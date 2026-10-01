use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount};

use crate::{
    engine::{
        accrue_funding, apply_fill, apply_settlement, bps_ceil, equity, fill_price_per_lot,
        margin_requirement, notional, settle_funding, update_open_interest,
    },
    error::TestPerpError,
    events::{OrderFilled, PositionLiquidated},
    instructions::vaults::apply_vault_settlement,
    oracle::oracle_price_per_lot,
    OrderSide, TestPerpMarket, TestPerpPosition,
};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct PlaceMarketOrderArgs {
    pub side: OrderSide,
    pub base_lots: u64,
    pub limit_price_in_ticks: u64,
    pub last_valid_slot: u64,
    pub reduce_only: bool,
    pub client_order_id: u128,
}

#[derive(Accounts)]
pub struct TradePosition<'info> {
    pub authority: Signer<'info>,
    #[account(mut)]
    pub market: Box<Account<'info, TestPerpMarket>>,
    #[account(mut, has_one = market @ TestPerpError::InvalidPositionAccount)]
    pub position: Box<Account<'info, TestPerpPosition>>,
    /// CHECK: Decoded and validated against the market oracle configuration.
    pub oracle: UncheckedAccount<'info>,
    #[account(mut, address = market.collateral_vault)]
    pub collateral_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = market.fee_vault)]
    pub fee_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = market.insurance_vault)]
    pub insurance_vault: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

/// Immediate-or-cancel for the full size against the oracle price plus spread and size impact.
pub fn place_market_order_handler(
    ctx: Context<TradePosition>,
    args: PlaceMarketOrderArgs,
) -> Result<()> {
    let accounts = ctx.accounts;
    let authority = accounts.authority.key();
    require!(
        authority == accounts.position.owner
            || (accounts.position.delegate != Pubkey::default()
                && authority == accounts.position.delegate),
        TestPerpError::Unauthorized
    );
    require!(
        args.base_lots > 0 && args.base_lots <= i64::MAX as u64,
        TestPerpError::InvalidBaseLots
    );
    require!(args.limit_price_in_ticks > 0, TestPerpError::LimitPriceZero);
    let clock = Clock::get()?;
    require!(
        clock.slot <= args.last_valid_slot,
        TestPerpError::OrderExpired
    );

    let oracle = oracle_price_per_lot(&accounts.market, &accounts.oracle, clock.unix_timestamp)?;
    accrue_funding(&mut accounts.market, oracle, clock.unix_timestamp)?;
    let funding = settle_funding(
        &mut accounts.position,
        accounts.market.cumulative_funding_index,
    )?;

    let before = accounts.position.base_lots;
    if args.reduce_only {
        let reduces = match args.side {
            OrderSide::Bid => before < 0,
            OrderSide::Ask => before > 0,
        };
        require!(
            reduces && args.base_lots <= before.unsigned_abs(),
            TestPerpError::ReduceOnlyViolation
        );
    }

    let price = fill_price_per_lot(&accounts.market, oracle, args.base_lots, args.side)?;
    let limit = args
        .limit_price_in_ticks
        .checked_mul(accounts.market.quote_tick_atoms_per_base_lot)
        .ok_or_else(|| error!(TestPerpError::ArithmeticOverflow))?;
    require!(
        match args.side {
            OrderSide::Ask => price >= limit,
            OrderSide::Bid => price <= limit,
        },
        TestPerpError::LimitPriceExceeded
    );

    let fill = apply_fill(&mut accounts.position, args.side, args.base_lots, price)?;
    let after = accounts.position.base_lots;
    if fill.increased_exposure {
        require!(!accounts.market.pause_opens, TestPerpError::OpensPaused);
    }
    require!(
        after.unsigned_abs() <= accounts.market.max_position_lots,
        TestPerpError::PositionLimitExceeded
    );
    update_open_interest(&mut accounts.market, before, after)?;

    let fee = bps_ceil(
        notional(price, args.base_lots)?,
        accounts.market.taker_fee_bps,
    )?;
    let house_flow = funding
        .checked_sub(fill.realized_pnl)
        .ok_or_else(|| error!(TestPerpError::ArithmeticOverflow))?;
    let settlement = apply_settlement(
        &mut accounts.market,
        &mut accounts.position,
        house_flow,
        fee,
    )?;
    if fill.increased_exposure {
        require!(
            settlement.to_fee_vault == fee
                && equity(&accounts.position, oracle)?
                    >= margin_requirement(
                        &accounts.position,
                        oracle,
                        accounts.market.initial_margin_bps
                    )?,
            TestPerpError::InsufficientInitialMargin
        );
    }
    apply_vault_settlement(
        &accounts.market,
        &accounts.token_program,
        &accounts.collateral_vault,
        &accounts.fee_vault,
        &accounts.insurance_vault,
        &settlement,
    )?;
    emit!(OrderFilled {
        market: accounts.market.key(),
        position: accounts.position.key(),
        side: args.side,
        base_lots: args.base_lots,
        oracle_price_per_lot: oracle,
        fill_price_per_lot: price,
        fee_atoms: settlement.to_fee_vault,
        realized_pnl_atoms: i64::try_from(fill.realized_pnl)
            .map_err(|_| error!(TestPerpError::ArithmeticOverflow))?,
        funding_atoms: i64::try_from(funding)
            .map_err(|_| error!(TestPerpError::ArithmeticOverflow))?,
        post_base_lots: after,
        post_collateral_atoms: accounts.position.collateral_atoms,
        client_order_id: args.client_order_id,
    });
    Ok(())
}

/// Permissionless. Closes the whole position at the oracle price when equity is below
/// maintenance margin and charges the liquidation penalty to the fee vault.
pub fn liquidate_handler(ctx: Context<TradePosition>) -> Result<()> {
    let accounts = ctx.accounts;
    let now = Clock::get()?.unix_timestamp;
    let oracle = oracle_price_per_lot(&accounts.market, &accounts.oracle, now)?;
    accrue_funding(&mut accounts.market, oracle, now)?;
    let funding = settle_funding(
        &mut accounts.position,
        accounts.market.cumulative_funding_index,
    )?;

    let before = accounts.position.base_lots;
    require!(before != 0, TestPerpError::NotLiquidatable);
    // Unsettled funding is part of equity: a positive amount is still owed by the trader.
    let current_equity = equity(&accounts.position, oracle)? - funding;
    require!(
        current_equity
            < margin_requirement(
                &accounts.position,
                oracle,
                accounts.market.maintenance_margin_bps
            )?,
        TestPerpError::NotLiquidatable
    );

    let side = if before > 0 {
        OrderSide::Ask
    } else {
        OrderSide::Bid
    };
    let base_lots = before.unsigned_abs();
    let fill = apply_fill(&mut accounts.position, side, base_lots, oracle)?;
    update_open_interest(&mut accounts.market, before, 0)?;
    let penalty = bps_ceil(
        notional(oracle, base_lots)?,
        accounts.market.liquidation_penalty_bps,
    )?;
    let house_flow = funding
        .checked_sub(fill.realized_pnl)
        .ok_or_else(|| error!(TestPerpError::ArithmeticOverflow))?;
    let settlement = apply_settlement(
        &mut accounts.market,
        &mut accounts.position,
        house_flow,
        penalty,
    )?;
    apply_vault_settlement(
        &accounts.market,
        &accounts.token_program,
        &accounts.collateral_vault,
        &accounts.fee_vault,
        &accounts.insurance_vault,
        &settlement,
    )?;
    emit!(PositionLiquidated {
        market: accounts.market.key(),
        position: accounts.position.key(),
        liquidator: accounts.authority.key(),
        base_lots: before,
        oracle_price_per_lot: oracle,
        penalty_atoms: settlement.to_fee_vault,
        post_collateral_atoms: accounts.position.collateral_atoms,
        bad_debt_atoms: accounts.market.bad_debt_atoms,
    });
    Ok(())
}

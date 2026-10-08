use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount};

use crate::{
    constants::NETTING_RESIDUAL_RECEIPT_SEED,
    engine::{
        accrue_funding, apply_fill, apply_settlement, bps_ceil, equity, fill_price_per_lot,
        margin_requirement, notional, settle_funding, update_open_interest,
    },
    error::TestPerpError,
    events::{BoundedResidualFilled, OrderFilled, PositionLiquidated},
    instructions::vaults::apply_vault_settlement,
    oracle::oracle_price_per_lot,
    NettingResidualReceipt, OrderSide, TestPerpMarket, TestPerpPosition,
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

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct PlaceBoundedResidualArgs {
    pub intent_hash: [u8; 32],
    pub side: OrderSide,
    pub base_lots: u64,
    pub limit_price_in_ticks: u64,
    pub last_valid_slot: u64,
    pub reduce_only: bool,
    pub maximum_fee_atoms: u64,
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

#[derive(Accounts)]
#[instruction(args: PlaceBoundedResidualArgs)]
pub struct TradeBoundedResidual<'info> {
    #[account(mut)]
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
    #[account(
        init,
        payer = authority,
        space = 8 + NettingResidualReceipt::INIT_SPACE,
        seeds = [
            NETTING_RESIDUAL_RECEIPT_SEED,
            position.key().as_ref(),
            args.intent_hash.as_ref()
        ],
        bump
    )]
    pub receipt: Box<Account<'info, NettingResidualReceipt>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

struct MarketOrderOutcome {
    oracle_price_per_lot: u64,
    fill_price_per_lot: u64,
    fee_atoms: u64,
    realized_pnl_atoms: i64,
    funding_atoms: i64,
    post_base_lots: i64,
    post_collateral_atoms: u64,
    execution_slot: u64,
}

/// Immediate-or-cancel for the full size against the oracle price plus spread and size impact.
pub fn place_market_order_handler(
    ctx: Context<TradePosition>,
    args: PlaceMarketOrderArgs,
) -> Result<()> {
    let outcome = execute_market_order(ctx.accounts, &args)?;
    emit!(OrderFilled {
        market: ctx.accounts.market.key(),
        position: ctx.accounts.position.key(),
        side: args.side,
        base_lots: args.base_lots,
        oracle_price_per_lot: outcome.oracle_price_per_lot,
        fill_price_per_lot: outcome.fill_price_per_lot,
        fee_atoms: outcome.fee_atoms,
        realized_pnl_atoms: outcome.realized_pnl_atoms,
        funding_atoms: outcome.funding_atoms,
        post_base_lots: outcome.post_base_lots,
        post_collateral_atoms: outcome.post_collateral_atoms,
        client_order_id: args.client_order_id,
    });
    Ok(())
}

pub fn place_bounded_residual_order_handler(
    ctx: Context<TradeBoundedResidual>,
    args: PlaceBoundedResidualArgs,
) -> Result<()> {
    require!(
        args.intent_hash != [0u8; 32],
        TestPerpError::InvalidResidualIntent
    );
    let order = PlaceMarketOrderArgs {
        side: args.side,
        base_lots: args.base_lots,
        limit_price_in_ticks: args.limit_price_in_ticks,
        last_valid_slot: args.last_valid_slot,
        reduce_only: args.reduce_only,
        client_order_id: u128::from_le_bytes(args.intent_hash[..16].try_into().unwrap()),
    };
    let authority = ctx.accounts.authority.key();
    let market = ctx.accounts.market.key();
    let position = ctx.accounts.position.key();
    let outcome = execute_bounded_market_order(ctx.accounts, &order)?;
    require!(
        outcome.fee_atoms <= args.maximum_fee_atoms,
        TestPerpError::ResidualFeeExceeded
    );
    let gross_quote_atoms = notional(outcome.fill_price_per_lot, args.base_lots)?;
    let receipt = &mut ctx.accounts.receipt;
    receipt.set_inner(NettingResidualReceipt {
        version: 1,
        intent_hash: args.intent_hash,
        authority,
        market,
        position,
        side: args.side,
        base_lots: args.base_lots,
        limit_price_in_ticks: args.limit_price_in_ticks,
        maximum_fee_atoms: args.maximum_fee_atoms,
        fill_price_per_lot: outcome.fill_price_per_lot,
        gross_quote_atoms,
        fee_atoms: outcome.fee_atoms,
        post_base_lots: outcome.post_base_lots,
        post_collateral_atoms: outcome.post_collateral_atoms,
        execution_slot: outcome.execution_slot,
        bump: ctx.bumps.receipt,
    });
    emit!(BoundedResidualFilled {
        receipt: receipt.key(),
        intent_hash: args.intent_hash,
        authority,
        market,
        position,
        side: args.side,
        base_lots: args.base_lots,
        fill_price_per_lot: outcome.fill_price_per_lot,
        gross_quote_atoms,
        fee_atoms: outcome.fee_atoms,
        execution_slot: outcome.execution_slot,
    });
    Ok(())
}

fn execute_market_order(
    accounts: &mut TradePosition,
    args: &PlaceMarketOrderArgs,
) -> Result<MarketOrderOutcome> {
    execute_order(
        accounts.authority.key(),
        &mut accounts.market,
        &mut accounts.position,
        &accounts.oracle,
        &accounts.collateral_vault,
        &accounts.fee_vault,
        &accounts.insurance_vault,
        &accounts.token_program,
        args,
    )
}

fn execute_bounded_market_order(
    accounts: &mut TradeBoundedResidual,
    args: &PlaceMarketOrderArgs,
) -> Result<MarketOrderOutcome> {
    execute_order(
        accounts.authority.key(),
        &mut accounts.market,
        &mut accounts.position,
        &accounts.oracle,
        &accounts.collateral_vault,
        &accounts.fee_vault,
        &accounts.insurance_vault,
        &accounts.token_program,
        args,
    )
}

#[allow(clippy::too_many_arguments)]
fn execute_order<'info>(
    authority: Pubkey,
    market: &mut Account<'info, TestPerpMarket>,
    position: &mut Account<'info, TestPerpPosition>,
    oracle_account: &AccountInfo<'info>,
    collateral_vault: &Account<'info, TokenAccount>,
    fee_vault: &Account<'info, TokenAccount>,
    insurance_vault: &Account<'info, TokenAccount>,
    token_program: &Program<'info, Token>,
    args: &PlaceMarketOrderArgs,
) -> Result<MarketOrderOutcome> {
    require!(
        authority == position.owner
            || (position.delegate != Pubkey::default() && authority == position.delegate),
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

    let oracle = oracle_price_per_lot(market, oracle_account, clock.unix_timestamp)?;
    accrue_funding(market, oracle, clock.unix_timestamp)?;
    let funding = settle_funding(position, market.cumulative_funding_index)?;

    let before = position.base_lots;
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

    let price = fill_price_per_lot(market, oracle, args.base_lots, args.side)?;
    let limit = args
        .limit_price_in_ticks
        .checked_mul(market.quote_tick_atoms_per_base_lot)
        .ok_or_else(|| error!(TestPerpError::ArithmeticOverflow))?;
    require!(
        match args.side {
            OrderSide::Ask => price >= limit,
            OrderSide::Bid => price <= limit,
        },
        TestPerpError::LimitPriceExceeded
    );

    let fill = apply_fill(position, args.side, args.base_lots, price)?;
    let after = position.base_lots;
    if fill.increased_exposure {
        require!(!market.pause_opens, TestPerpError::OpensPaused);
    }
    require!(
        after.unsigned_abs() <= market.max_position_lots,
        TestPerpError::PositionLimitExceeded
    );
    update_open_interest(market, before, after)?;

    let fee = bps_ceil(notional(price, args.base_lots)?, market.taker_fee_bps)?;
    let house_flow = funding
        .checked_sub(fill.realized_pnl)
        .ok_or_else(|| error!(TestPerpError::ArithmeticOverflow))?;
    let settlement = apply_settlement(market, position, house_flow, fee)?;
    if fill.increased_exposure {
        require!(
            settlement.to_fee_vault == fee
                && equity(position, oracle)?
                    >= margin_requirement(position, oracle, market.initial_margin_bps)?,
            TestPerpError::InsufficientInitialMargin
        );
    }
    apply_vault_settlement(
        market,
        token_program,
        collateral_vault,
        fee_vault,
        insurance_vault,
        &settlement,
    )?;
    Ok(MarketOrderOutcome {
        oracle_price_per_lot: oracle,
        fill_price_per_lot: price,
        fee_atoms: settlement.to_fee_vault,
        realized_pnl_atoms: i64::try_from(fill.realized_pnl)
            .map_err(|_| error!(TestPerpError::ArithmeticOverflow))?,
        funding_atoms: i64::try_from(funding)
            .map_err(|_| error!(TestPerpError::ArithmeticOverflow))?,
        post_base_lots: after,
        post_collateral_atoms: position.collateral_atoms,
        execution_slot: clock.slot,
    })
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

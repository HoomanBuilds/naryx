use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::{
    constants::{
        BPS_DENOMINATOR, COLLATERAL_VAULT_SEED, FEE_VAULT_SEED, INSURANCE_VAULT_SEED, MARKET_SEED,
        MAX_CONFIDENCE_BPS, MAX_FUNDING_RATE_PER_SECOND, MAX_PRICE_AGE_SECONDS, MAX_TAKER_FEE_BPS,
        PYTH_RECEIVER_PROGRAM_ID,
    },
    error::TestPerpError,
    oracle::decode_price_update,
    TestPerpMarket,
};

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InitializeMarketArgs {
    pub feed_id: [u8; 32],
    pub funding_keeper: Pubkey,
    pub base_decimals: u8,
    pub max_price_age_seconds: u32,
    pub max_confidence_bps: u16,
    pub taker_fee_bps: u16,
    pub half_spread_bps: u16,
    pub impact_bps_per_unit: u16,
    pub impact_unit_lots: u64,
    pub max_slippage_bps: u16,
    pub initial_margin_bps: u16,
    pub maintenance_margin_bps: u16,
    pub liquidation_penalty_bps: u16,
    pub base_lot_atoms: u64,
    pub quote_tick_atoms_per_base_lot: u64,
    pub max_position_lots: u64,
    pub max_funding_rate_per_second: i64,
}

#[derive(Accounts)]
#[instruction(args: InitializeMarketArgs)]
pub struct InitializeMarket<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    pub collateral_mint: Account<'info, Mint>,
    /// CHECK: Owner, discriminator, verification level, and feed id are checked in the handler.
    #[account(owner = PYTH_RECEIVER_PROGRAM_ID @ TestPerpError::OracleOwnerInvalid)]
    pub oracle: UncheckedAccount<'info>,
    #[account(
        init,
        payer = owner,
        space = 8 + TestPerpMarket::INIT_SPACE,
        seeds = [MARKET_SEED, owner.key().as_ref(), args.feed_id.as_ref()],
        bump
    )]
    pub market: Box<Account<'info, TestPerpMarket>>,
    #[account(
        init,
        payer = owner,
        seeds = [COLLATERAL_VAULT_SEED, market.key().as_ref()],
        bump,
        token::mint = collateral_mint,
        token::authority = market
    )]
    pub collateral_vault: Box<Account<'info, TokenAccount>>,
    #[account(
        init,
        payer = owner,
        seeds = [FEE_VAULT_SEED, market.key().as_ref()],
        bump,
        token::mint = collateral_mint,
        token::authority = market
    )]
    pub fee_vault: Box<Account<'info, TokenAccount>>,
    #[account(
        init,
        payer = owner,
        seeds = [INSURANCE_VAULT_SEED, market.key().as_ref()],
        bump,
        token::mint = collateral_mint,
        token::authority = market
    )]
    pub insurance_vault: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<InitializeMarket>, args: InitializeMarketArgs) -> Result<()> {
    let bps = u16::try_from(BPS_DENOMINATOR).unwrap();
    require!(
        args.funding_keeper != Pubkey::default()
            && args.base_decimals <= 18
            && args.max_price_age_seconds > 0
            && args.max_price_age_seconds <= MAX_PRICE_AGE_SECONDS
            && args.max_confidence_bps > 0
            && args.max_confidence_bps <= MAX_CONFIDENCE_BPS
            && args.taker_fee_bps <= MAX_TAKER_FEE_BPS
            && args.max_slippage_bps < bps
            && args.half_spread_bps <= args.max_slippage_bps
            && args.impact_unit_lots > 0
            && args.maintenance_margin_bps > 0
            && args.maintenance_margin_bps < args.initial_margin_bps
            && args.initial_margin_bps <= bps
            && args.liquidation_penalty_bps <= args.maintenance_margin_bps
            && args.base_lot_atoms > 0
            && args.quote_tick_atoms_per_base_lot > 0
            && args.max_position_lots > 0
            && args.max_position_lots <= i64::MAX as u64
            && args.max_funding_rate_per_second >= 0
            && args.max_funding_rate_per_second <= MAX_FUNDING_RATE_PER_SECOND,
        TestPerpError::InvalidMarketParameters
    );
    let message = decode_price_update(&ctx.accounts.oracle.try_borrow_data()?)?;
    require!(
        message.feed_id == args.feed_id,
        TestPerpError::OracleFeedMismatch
    );

    let market = &mut ctx.accounts.market;
    market.set_inner(TestPerpMarket {
        owner: ctx.accounts.owner.key(),
        funding_keeper: args.funding_keeper,
        collateral_mint: ctx.accounts.collateral_mint.key(),
        oracle: ctx.accounts.oracle.key(),
        feed_id: args.feed_id,
        collateral_vault: ctx.accounts.collateral_vault.key(),
        fee_vault: ctx.accounts.fee_vault.key(),
        insurance_vault: ctx.accounts.insurance_vault.key(),
        collateral_decimals: ctx.accounts.collateral_mint.decimals,
        base_decimals: args.base_decimals,
        max_price_age_seconds: args.max_price_age_seconds,
        max_confidence_bps: args.max_confidence_bps,
        taker_fee_bps: args.taker_fee_bps,
        half_spread_bps: args.half_spread_bps,
        impact_bps_per_unit: args.impact_bps_per_unit,
        max_slippage_bps: args.max_slippage_bps,
        initial_margin_bps: args.initial_margin_bps,
        maintenance_margin_bps: args.maintenance_margin_bps,
        liquidation_penalty_bps: args.liquidation_penalty_bps,
        impact_unit_lots: args.impact_unit_lots,
        base_lot_atoms: args.base_lot_atoms,
        quote_tick_atoms_per_base_lot: args.quote_tick_atoms_per_base_lot,
        max_position_lots: args.max_position_lots,
        max_funding_rate_per_second: args.max_funding_rate_per_second,
        funding_rate_per_second: 0,
        cumulative_funding_index: 0,
        last_funding_timestamp: Clock::get()?.unix_timestamp,
        open_interest_long_lots: 0,
        open_interest_short_lots: 0,
        bad_debt_atoms: 0,
        pause_opens: false,
        bump: ctx.bumps.market,
    });
    Ok(())
}

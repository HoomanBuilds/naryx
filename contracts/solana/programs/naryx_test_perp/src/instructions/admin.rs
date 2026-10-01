use anchor_lang::prelude::*;

use crate::{
    engine::accrue_funding, error::TestPerpError, events::FundingRateSet,
    oracle::oracle_price_per_lot, TestPerpMarket,
};

#[derive(Accounts)]
pub struct SetFundingRate<'info> {
    pub funding_keeper: Signer<'info>,
    #[account(mut, has_one = funding_keeper @ TestPerpError::Unauthorized)]
    pub market: Box<Account<'info, TestPerpMarket>>,
    /// CHECK: Decoded and validated against the market oracle configuration.
    pub oracle: UncheckedAccount<'info>,
}

/// Accrues funding at the previous rate up to now, then applies the new bounded rate.
pub fn set_funding_rate_handler(
    ctx: Context<SetFundingRate>,
    funding_rate_per_second: i64,
) -> Result<()> {
    let market = &mut ctx.accounts.market;
    require!(
        funding_rate_per_second.unsigned_abs() <= market.max_funding_rate_per_second as u64,
        TestPerpError::FundingRateOutOfBounds
    );
    let now = Clock::get()?.unix_timestamp;
    let oracle = oracle_price_per_lot(market, &ctx.accounts.oracle, now)?;
    accrue_funding(market, oracle, now)?;
    market.funding_rate_per_second = funding_rate_per_second;
    emit!(FundingRateSet {
        market: market.key(),
        funding_rate_per_second,
        cumulative_funding_index: market.cumulative_funding_index,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct UpdateMarketControls<'info> {
    pub owner: Signer<'info>,
    #[account(mut, has_one = owner @ TestPerpError::Unauthorized)]
    pub market: Box<Account<'info, TestPerpMarket>>,
}

pub fn update_market_controls_handler(
    ctx: Context<UpdateMarketControls>,
    pause_opens: bool,
    funding_keeper: Pubkey,
) -> Result<()> {
    require_keys_neq!(
        funding_keeper,
        Pubkey::default(),
        TestPerpError::InvalidMarketParameters
    );
    let market = &mut ctx.accounts.market;
    market.pause_opens = pause_opens;
    market.funding_keeper = funding_keeper;
    Ok(())
}

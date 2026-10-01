use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace, Default)]
pub struct TestPerpMarket {
    pub owner: Pubkey,
    pub funding_keeper: Pubkey,
    pub collateral_mint: Pubkey,
    pub oracle: Pubkey,
    pub feed_id: [u8; 32],
    pub collateral_vault: Pubkey,
    pub fee_vault: Pubkey,
    pub insurance_vault: Pubkey,
    pub collateral_decimals: u8,
    pub base_decimals: u8,
    pub max_price_age_seconds: u32,
    pub max_confidence_bps: u16,
    pub taker_fee_bps: u16,
    pub half_spread_bps: u16,
    pub impact_bps_per_unit: u16,
    pub max_slippage_bps: u16,
    pub initial_margin_bps: u16,
    pub maintenance_margin_bps: u16,
    pub liquidation_penalty_bps: u16,
    pub impact_unit_lots: u64,
    pub base_lot_atoms: u64,
    pub quote_tick_atoms_per_base_lot: u64,
    pub max_position_lots: u64,
    pub max_funding_rate_per_second: i64,
    pub funding_rate_per_second: i64,
    pub cumulative_funding_index: i128,
    pub last_funding_timestamp: i64,
    pub open_interest_long_lots: u64,
    pub open_interest_short_lots: u64,
    pub bad_debt_atoms: u64,
    pub pause_opens: bool,
    pub bump: u8,
}

#[account]
#[derive(InitSpace, Default)]
pub struct TestPerpPosition {
    pub market: Pubkey,
    pub owner: Pubkey,
    // May place and reduce orders but never withdraw, like a Rise position authority.
    pub delegate: Pubkey,
    pub collateral_atoms: u64,
    pub base_lots: i64,
    pub entry_notional_atoms: u64,
    pub entry_funding_index: i128,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum OrderSide {
    Bid,
    Ask,
}

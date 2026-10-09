use anchor_lang::prelude::*;

use crate::OrderSide;

#[event]
pub struct OrderFilled {
    pub market: Pubkey,
    pub position: Pubkey,
    pub side: OrderSide,
    pub base_lots: u64,
    pub oracle_price_per_lot: u64,
    pub fill_price_per_lot: u64,
    pub fee_atoms: u64,
    pub realized_pnl_atoms: i64,
    pub funding_atoms: i64,
    pub post_base_lots: i64,
    pub post_collateral_atoms: u64,
    pub client_order_id: u128,
}

#[event]
pub struct BoundedResidualFilled {
    pub receipt: Pubkey,
    pub intent_hash: [u8; 32],
    pub authority: Pubkey,
    pub market: Pubkey,
    pub position: Pubkey,
    pub side: OrderSide,
    pub base_lots: u64,
    pub fill_price_per_lot: u64,
    pub gross_quote_atoms: u64,
    pub fee_atoms: u64,
    pub execution_slot: u64,
}

#[event]
pub struct PositionLiquidated {
    pub market: Pubkey,
    pub position: Pubkey,
    pub liquidator: Pubkey,
    pub base_lots: i64,
    pub oracle_price_per_lot: u64,
    pub penalty_atoms: u64,
    pub post_collateral_atoms: u64,
    pub bad_debt_atoms: u64,
}

#[event]
pub struct FundingRateSet {
    pub market: Pubkey,
    pub funding_rate_per_second: i64,
    pub cumulative_funding_index: i128,
}

#[event]
pub struct OracleRiskControlsUpdated {
    pub market: Pubkey,
    pub max_price_age_seconds: u32,
    pub max_confidence_bps: u16,
}

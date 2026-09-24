use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct RiseStrategy {
    pub owner: Pubkey,
    pub controller: Pubkey,
    pub strategy_id: [u8; 32],
    pub trader_account: Pubkey,
    pub trader_pda_index: u8,
    pub trader_subaccount_index: u8,
    pub asset_id: u32,
    pub perp_asset_map: Pubkey,
    pub orderbook: Pubkey,
    pub spline_collection: Pubkey,
    pub max_base_lots: u64,
    pub bump: u8,
}

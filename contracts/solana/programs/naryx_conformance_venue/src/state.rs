use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct MarketConfig {
    pub admin: Pubkey,
    pub base_mint: Pubkey,
    pub quote_mint: Pubkey,
    pub spot_base_vault: Pubkey,
    pub spot_quote_vault: Pubkey,
    pub perp_quote_vault: Pubkey,
    pub price_quote_atoms: u64,
    pub price_base_atoms: u64,
    pub spot_fee_bps: u16,
    pub initial_margin_bps: u16,
    pub max_spot_base_atoms: u64,
    pub max_perp_base_atoms: u64,
    pub paused: bool,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct PerpPosition {
    pub market: Pubkey,
    pub trader: Pubkey,
    pub short_base_atoms: u64,
    pub collateral_quote_atoms: u64,
    pub bump: u8,
}

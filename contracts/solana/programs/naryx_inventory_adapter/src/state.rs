use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct PackageInventory {
    pub version: u8,
    pub bump: u8,
    pub vault_bump: u8,
    pub strategy_account: Pubkey,
    pub package_id: [u8; 32],
    pub mint: Pubkey,
    pub vault: Pubkey,
}

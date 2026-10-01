use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct TestPerpStrategy {
    pub owner: Pubkey,
    pub controller: Pubkey,
    pub strategy_id: [u8; 32],
    pub market: Pubkey,
    pub position: Pubkey,
    pub max_base_lots: u64,
    pub bump: u8,
}

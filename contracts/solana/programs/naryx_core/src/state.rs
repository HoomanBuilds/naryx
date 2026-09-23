use anchor_lang::prelude::*;

use crate::wire::{DomainRef, ProtocolId};

pub const PROTOCOL_CONFIG_VERSION: u16 = 2;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, InitSpace, Debug)]
pub struct PendingDomain {
    pub domain: DomainRef,
    pub activation_slot: u64,
}

#[account]
#[derive(InitSpace)]
pub struct ProtocolConfig {
    pub config_version: u16,
    pub environment: ProtocolId,
    pub domain: DomainRef,
    pub pending_domain: Option<PendingDomain>,
    pub proposer: Pubkey,
    pub canceller: Pubkey,
    pub executor: Pubkey,
    pub pauser: Pubkey,
    pub config_delay_slots: u64,
    pub entry_paused: bool,
    pub pending_unpause_slot: Option<u64>,
    pub bump: u8,
}

#[cfg(feature = "conformance")]
#[account]
#[derive(InitSpace)]
pub struct ConformanceExecutionReceipt {
    pub domain: DomainRef,
    pub order_hash: [u8; 32],
    pub quote_hash: [u8; 32],
    pub route_hash: [u8; 32],
    pub trader: Pubkey,
    pub solver: Pubkey,
    pub nonce: u64,
    pub execution_digest: [u8; 32],
    pub action: u8,
    pub base_quantity_atoms: u64,
    pub pre_base_balance: u64,
    pub post_base_balance: u64,
    pub pre_quote_balance: u64,
    pub post_quote_balance: u64,
    pub pre_short_base_atoms: u64,
    pub post_short_base_atoms: u64,
    pub pre_collateral_quote_atoms: u64,
    pub post_collateral_quote_atoms: u64,
    pub execution_slot: u64,
    pub bump: u8,
}

#[cfg(feature = "conformance")]
#[account]
#[derive(InitSpace)]
pub struct ConformanceNonce {
    pub order_hash: [u8; 32],
    pub execution_digest: [u8; 32],
    pub bump: u8,
}

#[cfg(feature = "conformance")]
#[derive(AnchorSerialize, AnchorDeserialize, Clone, InitSpace)]
pub struct PendingSolver {
    pub key: Pubkey,
    pub activation_slot: u64,
}

#[cfg(feature = "conformance")]
#[account]
#[derive(InitSpace)]
pub struct SolverRegistry {
    pub active: Pubkey,
    pub pending: Option<PendingSolver>,
    pub bump: u8,
}

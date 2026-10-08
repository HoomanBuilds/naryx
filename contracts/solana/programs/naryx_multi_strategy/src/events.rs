use anchor_lang::prelude::*;
use naryx_core::{state::DescriptorRef, wire::DomainRef};

use crate::state::StrategyOperation;

#[event]
pub struct MultiStrategyAccountInitialized {
    pub strategy_account: Pubkey,
    pub owner: Pubkey,
    pub config: Pubkey,
}

#[event]
pub struct MultiStrategyExecuted {
    pub strategy_account: Pubkey,
    pub position: Pubkey,
    pub receipt: Pubkey,
    pub domain: DomainRef,
    pub package_id: [u8; 32],
    pub order_hash: [u8; 32],
    pub graph_hash: [u8; 32],
    pub quote_hash: [u8; 32],
    pub route_hash: [u8; 32],
    pub template: DescriptorRef,
    pub operation: StrategyOperation,
    pub calls_hash: [u8; 32],
    pub evidence_root: [u8; 32],
    pub receipt_hash: [u8; 32],
    pub solver: Pubkey,
    pub nonce: u64,
    pub execution_slot: u64,
}

#[event]
pub struct NettingAllocationExecuted {
    pub receipt: Pubkey,
    pub receipt_hash: [u8; 32],
    pub authorization_hash: [u8; 32],
}

#[event]
pub struct StrategyAdapterLegExecuted {
    pub receipt: Pubkey,
    pub call_index: u8,
    pub adapter_subject_id: [u8; 32],
    pub stage: u8,
    pub evidence_hash: [u8; 32],
}

#[event]
pub struct StrategyFeesCollected {
    pub receipt: Pubkey,
    pub mint: Pubkey,
    pub protocol_recipient: Pubkey,
    pub solver_recipient: Pubkey,
    pub protocol_fee_atoms: u64,
    pub solver_fee_atoms: u64,
}

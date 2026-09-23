use anchor_lang::prelude::*;

use crate::{
    state::{Lifecycle, ResourceKind},
    wire::{DomainRef, ProtocolId, HASH_BYTE_LENGTH},
};

#[event]
pub struct ProtocolConfigInitialized {
    pub config: Pubkey,
    pub initializer: Pubkey,
    pub environment: ProtocolId,
    pub domain: DomainRef,
    pub config_delay_slots: u64,
    pub proposer: Pubkey,
    pub canceller: Pubkey,
    pub executor: Pubkey,
    pub pauser: Pubkey,
}

#[event]
pub struct DomainProposed {
    pub config: Pubkey,
    pub proposer: Pubkey,
    pub domain: DomainRef,
    pub activation_slot: u64,
}

#[event]
pub struct DomainProposalCancelled {
    pub config: Pubkey,
    pub canceller: Pubkey,
    pub domain: DomainRef,
    pub activation_slot: u64,
}

#[event]
pub struct DomainActivated {
    pub config: Pubkey,
    pub executor: Pubkey,
    pub previous: DomainRef,
    pub current: DomainRef,
}

#[event]
pub struct EntryPaused {
    pub config: Pubkey,
    pub pauser: Pubkey,
}

#[event]
pub struct UnpauseScheduled {
    pub config: Pubkey,
    pub proposer: Pubkey,
    pub activation_slot: u64,
}

#[event]
pub struct UnpauseCancelled {
    pub config: Pubkey,
    pub actor: Pubkey,
    pub activation_slot: u64,
}

#[event]
pub struct EntryUnpaused {
    pub config: Pubkey,
    pub executor: Pubkey,
}

#[event]
pub struct ResourceRegistrationProposed {
    pub actor: Pubkey,
    pub record: Pubkey,
    pub kind: ResourceKind,
    pub subject_id: [u8; HASH_BYTE_LENGTH],
    pub manifest_version: u32,
    pub manifest_hash: [u8; HASH_BYTE_LENGTH],
    pub activation_slot: u64,
}

#[event]
pub struct ResourceRegistrationCancelled {
    pub actor: Pubkey,
    pub record: Pubkey,
    pub kind: ResourceKind,
    pub subject_id: [u8; HASH_BYTE_LENGTH],
    pub manifest_version: u32,
    pub manifest_hash: [u8; HASH_BYTE_LENGTH],
}

#[event]
pub struct ResourceActivated {
    pub actor: Pubkey,
    pub record: Pubkey,
    pub previous_record: Pubkey,
    pub kind: ResourceKind,
    pub subject_id: [u8; HASH_BYTE_LENGTH],
    pub manifest_version: u32,
    pub manifest_hash: [u8; HASH_BYTE_LENGTH],
    pub lifecycle: Lifecycle,
}

#[event]
pub struct ResourceControlProposed {
    pub actor: Pubkey,
    pub record: Pubkey,
    pub lifecycle: Lifecycle,
    pub activation_slot: u64,
}

#[event]
pub struct ResourceControlCancelled {
    pub actor: Pubkey,
    pub record: Pubkey,
}

#[event]
pub struct ResourceControlActivated {
    pub actor: Pubkey,
    pub record: Pubkey,
    pub lifecycle: Lifecycle,
}

#[event]
pub struct ResourceControlTightened {
    pub actor: Pubkey,
    pub record: Pubkey,
    pub lifecycle: Lifecycle,
    pub registration_cancelled: bool,
    pub control_cancelled: bool,
}

#[cfg(feature = "conformance")]
#[event]
pub struct ConformanceExecutionRecorded {
    pub receipt: Pubkey,
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
}

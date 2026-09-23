use anchor_lang::prelude::*;

use crate::wire::{DomainRef, ProtocolId};

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

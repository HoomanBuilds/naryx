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

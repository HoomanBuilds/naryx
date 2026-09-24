use anchor_lang::prelude::*;
use naryx_core::DomainRef;

#[event]
pub struct PackageQuoteShardInitialized {
    pub shard: Pubkey,
    pub solver: Pubkey,
    pub series_manifest_hash: [u8; 32],
    pub execution_class_manifest_hash: [u8; 32],
}

#[event]
pub struct PackageQuoteReferenceUpdated {
    pub shard: Pubkey,
    pub reference_sequence: u64,
    pub shard_sequence: u64,
    pub heartbeat_expiry_slot: u64,
}

#[event]
pub struct PackageQuoteLevelsUpdated {
    pub shard: Pubkey,
    pub epoch: u64,
    pub shard_sequence: u64,
    pub level_count: u16,
    pub replaced: bool,
}

#[event]
pub struct PackageQuoteLevelCancelled {
    pub shard: Pubkey,
    pub level_id: u64,
    pub shard_sequence: u64,
}

#[event]
pub struct PackageQuoteEpochCancelled {
    pub shard: Pubkey,
    pub epoch: u64,
    pub shard_sequence: u64,
}

#[event]
pub struct PackageQuoteKillSwitchSet {
    pub shard: Pubkey,
    pub killed: bool,
    pub reference_sequence: u64,
    pub shard_sequence: u64,
}

#[event]
pub struct PackageFillCommitted {
    pub fill_commitment: [u8; 32],
    pub domain: DomainRef,
    pub shard: Pubkey,
    pub solver: Pubkey,
    pub consumer_authority: Pubkey,
    pub series_manifest_hash: [u8; 32],
    pub execution_class_manifest_hash: [u8; 32],
    pub level_id: u64,
    pub level_sequence: u64,
    pub reference_sequence: u64,
    pub shard_sequence: u64,
    pub epoch: u64,
    pub side: u8,
    pub package_size_units: u64,
    pub package_price: i128,
    pub max_fee_atoms: u64,
    pub settlement_class_identity_hash: [u8; 32],
    pub quote_mode: u8,
    pub reservation_policy_hash: [u8; 32],
    pub reservation_id: [u8; 32],
    pub order_hash: [u8; 32],
    pub quote_hash: [u8; 32],
    pub route_hash: [u8; 32],
}

use anchor_lang::prelude::*;

#[constant]
pub const PROTOCOL_CONFIG_SEED: &[u8] = b"naryx-protocol-config";

pub const RESOURCE_INDEX_SEED: &[u8] = b"naryx-resource-index";
pub const RESOURCE_RECORD_SEED: &[u8] = b"naryx-resource-record";

pub const ASSET_RESOURCE_SEED: &[u8] = b"asset";
pub const VENUE_RESOURCE_SEED: &[u8] = b"venue";
pub const MARKET_RESOURCE_SEED: &[u8] = b"market";
pub const ADAPTER_RESOURCE_SEED: &[u8] = b"adapter";

#[cfg(feature = "conformance")]
pub const CONFORMANCE_RECEIPT_SEED: &[u8] = b"conformance-receipt";

#[cfg(feature = "conformance")]
pub const CONFORMANCE_NONCE_SEED: &[u8] = b"conformance-nonce";

#[cfg(feature = "conformance")]
pub const SOLVER_REGISTRY_SEED: &[u8] = b"conformance-solver";

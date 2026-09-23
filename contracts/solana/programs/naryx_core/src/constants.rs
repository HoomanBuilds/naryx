use anchor_lang::prelude::*;

#[constant]
pub const PROTOCOL_CONFIG_SEED: &[u8] = b"naryx-protocol-config";

#[cfg(feature = "conformance")]
pub const CONFORMANCE_RECEIPT_SEED: &[u8] = b"conformance-receipt";

#[cfg(feature = "conformance")]
pub const CONFORMANCE_NONCE_SEED: &[u8] = b"conformance-nonce";

#[cfg(feature = "conformance")]
pub const SOLVER_REGISTRY_SEED: &[u8] = b"conformance-solver";

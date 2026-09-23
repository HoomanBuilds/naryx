use anchor_lang::prelude::*;

#[constant]
pub const PROTOCOL_CONFIG_SEED: &[u8] = b"naryx-protocol-config";

#[cfg(feature = "conformance")]
pub const CONFORMANCE_RECEIPT_SEED: &[u8] = b"conformance-receipt";

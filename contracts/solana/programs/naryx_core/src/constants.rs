use anchor_lang::prelude::*;

#[constant]
pub const PROTOCOL_CONFIG_SEED: &[u8] = b"naryx-protocol-config";

pub const RESOURCE_INDEX_SEED: &[u8] = b"naryx-resource-index";
pub const RESOURCE_RECORD_SEED: &[u8] = b"naryx-resource-record";

pub const ASSET_RESOURCE_SEED: &[u8] = b"asset";
pub const VENUE_RESOURCE_SEED: &[u8] = b"venue";
pub const MARKET_RESOURCE_SEED: &[u8] = b"market";
pub const ADAPTER_RESOURCE_SEED: &[u8] = b"adapter";

pub const CASH_CARRY_SERIES_INDEX_SEED: &[u8] = b"cash-carry-series-index";
pub const CASH_CARRY_SERIES_RECORD_SEED: &[u8] = b"cash-carry-series-record";

#[cfg(feature = "conformance")]
pub const CONFORMANCE_RECEIPT_SEED: &[u8] = b"conformance-receipt";

#[cfg(feature = "conformance")]
pub const CONFORMANCE_NONCE_SEED: &[u8] = b"conformance-nonce";

pub const SOLVER_REGISTRY_SEED: &[u8] = b"conformance-solver";

pub const CASH_CARRY_RECEIPT_SEED: &[u8] = b"cash-carry-receipt";
pub const CASH_CARRY_NONCE_SEED: &[u8] = b"cash-carry-nonce";
pub const CASH_CARRY_OPEN_SEED: &[u8] = b"cash-carry-open";
pub const CASH_CARRY_EXECUTOR_SEED: &[u8] = b"cash-carry-executor";

pub const PACKAGE_BOOK_PROGRAM_ID: Pubkey = pubkey!("8MgGrVCrAN2AhQ6hHPLqRXkUvwQ2WKHcbSXtXpEWpsFR");
pub const PACKAGE_BOOK_CLASS_SEED: &[u8] = b"package-book-class";
pub const PACKAGE_QUOTE_SHARD_SEED: &[u8] = b"package-quote-shard";
pub const PACKAGE_QUOTE_LEVEL_PAGE_SEED: &[u8] = b"quote-level-page";

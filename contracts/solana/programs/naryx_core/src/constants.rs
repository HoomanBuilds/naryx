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
pub const FEE_POLICY_SEED: &[u8] = b"fee-policy";

#[cfg(feature = "conformance")]
pub const CONFORMANCE_RECEIPT_SEED: &[u8] = b"conformance-receipt";

#[cfg(feature = "conformance")]
pub const CONFORMANCE_NONCE_SEED: &[u8] = b"conformance-nonce";

pub const SOLVER_REGISTRY_SEED: &[u8] = b"conformance-solver";

pub const CASH_CARRY_RECEIPT_SEED: &[u8] = b"cash-carry-receipt";
pub const CASH_CARRY_NONCE_SEED: &[u8] = b"cash-carry-nonce";
pub const CASH_CARRY_OPEN_SEED: &[u8] = b"cash-carry-open";
pub const CASH_CARRY_EXECUTOR_SEED: &[u8] = b"cash-carry-executor";

// Both programs depend on this crate, so their IDs cannot be imported. `anchor keys sync` does not
// rewrite these copies; scripts/sync-core-program-ids.mjs does.
pub const PACKAGE_BOOK_PROGRAM_ID: Pubkey = pubkey!("CefHTR5CVCuUpErk9p78f9KsRFUfffdKgAU1xho77DpY");
pub const INVENTORY_RESERVATION_PROGRAM_ID: Pubkey =
    pubkey!("CumWE8RbCAUCfgpEdWPkZQgKQvUHx6VzvErDZb4WzYrt");
pub const PACKAGE_BOOK_CLASS_SEED: &[u8] = b"package-book-class";
pub const PACKAGE_QUOTE_SHARD_SEED: &[u8] = b"package-quote-shard";
pub const PACKAGE_QUOTE_LEVEL_PAGE_SEED: &[u8] = b"quote-level-page";

#[cfg(test)]
mod tests {
    use super::*;

    fn declared_id(source: &str) -> &str {
        source
            .lines()
            .find_map(|line| line.split_once("declare_id!(\"")?.1.split_once("\")"))
            .map(|(id, _)| id)
            .expect("declare_id! literal")
    }

    #[test]
    fn cross_program_ids_match_declared_ids() {
        assert_eq!(
            PACKAGE_BOOK_PROGRAM_ID.to_string(),
            declared_id(include_str!("../../naryx_package_book/src/lib.rs"))
        );
        assert_eq!(
            INVENTORY_RESERVATION_PROGRAM_ID.to_string(),
            declared_id(include_str!("../../naryx_inventory_reservation/src/lib.rs"))
        );
    }
}

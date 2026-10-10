use anchor_lang::prelude::*;

#[constant]
pub const MULTI_STRATEGY_ACCOUNT_SEED: &[u8] = b"multi-strategy-account";
pub const STRATEGY_POSITION_SEED: &[u8] = b"strategy-position";
pub const STRATEGY_RECEIPT_SEED: &[u8] = b"strategy-receipt";

pub const MAX_STRATEGY_CALLS: usize = 8;
pub const MAX_CPI_ACCOUNTS_PER_CALL: usize = 24;
/// `execute_bound_strategy_leg(context, payload)`: the context carries this program's package id and
/// risk label so each adapter can bind the leg and refuse a risk-increasing action labelled otherwise.
pub const BOUND_ADAPTER_DISCRIMINATOR: [u8; 8] = [0x72, 0x97, 0xcd, 0x4d, 0xbe, 0xc5, 0xb5, 0x84];
pub const EXECUTION_HASH_DOMAIN: &[u8] = b"naryx.solana.multi-strategy.execution.v1";
pub const CALLS_HASH_DOMAIN: &[u8] = b"naryx.solana.multi-strategy.calls.v1";
pub const EVIDENCE_ROOT_DOMAIN: &[u8] = b"naryx.solana.multi-strategy.evidence.v1";
pub const RECEIPT_HASH_DOMAIN: &[u8] = b"naryx.solana.multi-strategy.receipt.v1";

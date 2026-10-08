use anchor_lang::prelude::*;

pub const MARKET_SEED: &[u8] = b"test-perp-market";
pub const POSITION_SEED: &[u8] = b"test-perp-position";
pub const COLLATERAL_VAULT_SEED: &[u8] = b"test-perp-collateral-vault";
pub const FEE_VAULT_SEED: &[u8] = b"test-perp-fee-vault";
pub const INSURANCE_VAULT_SEED: &[u8] = b"test-perp-insurance-vault";
pub const NETTING_RESIDUAL_RECEIPT_SEED: &[u8] = b"netting-residual-receipt";
pub const TEST_COLLATERAL_FAUCET_SEED: &[u8] = b"test-collateral-faucet";

// Test USDC: six decimals, 10,000 per claim, 10,000,000 per token account through the faucet.
pub const TEST_COLLATERAL_DECIMALS: u8 = 6;
pub const TEST_COLLATERAL_MAX_CLAIM_ATOMS: u64 = 10_000_000_000;
pub const TEST_COLLATERAL_MAX_BALANCE_ATOMS: u64 = 10_000_000_000_000;

pub const PYTH_RECEIVER_PROGRAM_ID: Pubkey = pubkey!("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");
pub const PRICE_UPDATE_V2_DISCRIMINATOR: [u8; 8] = [34, 241, 35, 99, 157, 126, 244, 205];

pub const BPS_DENOMINATOR: u64 = 10_000;
// Funding rates are a signed fraction of oracle notional per second, scaled by 1e12.
pub const FUNDING_RATE_SCALE: i128 = 1_000_000_000_000;
// 1e-6 per second, about 8.64% per day.
pub const MAX_FUNDING_RATE_PER_SECOND: i64 = 1_000_000;
pub const MAX_TAKER_FEE_BPS: u16 = 1_000;
pub const MAX_PRICE_AGE_SECONDS: u32 = 300;
pub const MAX_CONFIDENCE_BPS: u16 = 1_000;
pub const MAX_ORACLE_EXPONENT_MAGNITUDE: i32 = 18;

use anchor_lang::prelude::*;

pub const RISE_STRATEGY_SEED: &[u8] = b"rise-strategy";
pub const RISE_PROGRAM_ID: Pubkey = phoenix_rise::ix::constants::PROD_PHOENIX_PROGRAM_ID;
pub const RISE_LOG_AUTHORITY: Pubkey = phoenix_rise::ix::constants::PROD_PHOENIX_LOG_AUTHORITY;
pub const RISE_GLOBAL_CONFIG: Pubkey =
    phoenix_rise::ix::constants::PROD_PHOENIX_GLOBAL_CONFIGURATION;

pub const GLOBAL_TRADER_INDEX_SEED: &[u8] = b"global_trader_index";
pub const ACTIVE_TRADER_BUFFER_SEED: &[u8] = b"active_trader_buffer";
pub const TRADER_SEED: &[u8] = b"trader";

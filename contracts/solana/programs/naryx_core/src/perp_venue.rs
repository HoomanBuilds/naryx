//! Perpetual leg binding for cash-and-carry execution.
//!
//! The default build binds Phoenix Rise through `naryx_rise_adapter`. The `devnet-test-perp`
//! build binds the oracle-priced Naryx Devnet test perp through `naryx_test_perp_adapter` with the
//! same order arguments, pre and post position and collateral reads, and postconditions. A
//! `devnet-test-perp` core is a Devnet artifact only and is never a mainnet identity.
//!
//! The `rise` and `rise_strategy` account names are kept in both builds so the default IDL is
//! unchanged; under `devnet-test-perp` they carry the test perp strategy and venue accounts.

use anchor_lang::prelude::*;

use crate::error::ErrorCode;

#[cfg(not(feature = "devnet-test-perp"))]
pub use naryx_rise_adapter::{
    program::NaryxRiseAdapter as PerpAdapterProgram, RiseMarketOrderArgs as PerpMarketOrderArgs,
    RiseStrategy as PerpStrategy, RISE_PROGRAM_ID as PERP_VENUE_PROGRAM_ID,
};
#[cfg(not(feature = "devnet-test-perp"))]
use naryx_rise_adapter::{read_position_and_collateral, RISE_GLOBAL_CONFIG, RISE_LOG_AUTHORITY};

#[cfg(feature = "devnet-test-perp")]
pub use naryx_test_perp_adapter::{
    program::NaryxTestPerpAdapter as PerpAdapterProgram,
    TestPerpMarketOrderArgs as PerpMarketOrderArgs, TestPerpStrategy as PerpStrategy,
    TEST_PERP_PROGRAM_ID as PERP_VENUE_PROGRAM_ID,
};
#[cfg(feature = "devnet-test-perp")]
use naryx_test_perp_adapter::{read_position_and_collateral, PYTH_RECEIVER_PROGRAM_ID};

/// Venue accounts listed after the strategy in route and execution account commitments.
#[cfg(not(feature = "devnet-test-perp"))]
pub const PERP_VENUE_ACCOUNT_COUNT: usize = 8;
#[cfg(feature = "devnet-test-perp")]
pub const PERP_VENUE_ACCOUNT_COUNT: usize = 6;

#[cfg(not(feature = "devnet-test-perp"))]
#[derive(Accounts)]
pub struct CashCarryRiseAccounts<'info> {
    /// CHECK: Fixed to the Rise log authority.
    #[account(address = RISE_LOG_AUTHORITY)]
    pub rise_log_authority: UncheckedAccount<'info>,
    /// CHECK: The adapter decodes this with the official Rise account layout.
    #[account(mut, address = RISE_GLOBAL_CONFIG, owner = PERP_VENUE_PROGRAM_ID)]
    pub rise_global_config: UncheckedAccount<'info>,
    /// CHECK: The adapter decodes and binds this account to the strategy.
    #[account(mut, owner = PERP_VENUE_PROGRAM_ID)]
    pub rise_trader_account: UncheckedAccount<'info>,
    /// CHECK: The adapter decodes and binds this market map to the strategy.
    #[account(mut, owner = PERP_VENUE_PROGRAM_ID)]
    pub rise_perp_asset_map: UncheckedAccount<'info>,
    /// CHECK: The adapter derives this address from the Rise global configuration.
    #[account(mut, owner = PERP_VENUE_PROGRAM_ID)]
    pub rise_global_trader_index_header: UncheckedAccount<'info>,
    /// CHECK: The adapter derives this address from the Rise global configuration.
    #[account(mut, owner = PERP_VENUE_PROGRAM_ID)]
    pub rise_active_trader_buffer_header: UncheckedAccount<'info>,
    /// CHECK: The adapter decodes and binds this market to the strategy.
    #[account(mut, owner = PERP_VENUE_PROGRAM_ID)]
    pub rise_orderbook: UncheckedAccount<'info>,
    /// CHECK: The adapter derives and decodes this spline collection.
    #[account(mut, owner = PERP_VENUE_PROGRAM_ID)]
    pub rise_spline_collection: UncheckedAccount<'info>,
}

#[cfg(feature = "devnet-test-perp")]
#[derive(Accounts)]
pub struct CashCarryRiseAccounts<'info> {
    /// CHECK: Bound to the strategy and to the admitted venue and market records.
    #[account(mut, owner = PERP_VENUE_PROGRAM_ID)]
    pub test_perp_market: UncheckedAccount<'info>,
    /// CHECK: Bound to the strategy and decoded with the venue position layout.
    #[account(mut, owner = PERP_VENUE_PROGRAM_ID)]
    pub test_perp_position: UncheckedAccount<'info>,
    /// CHECK: The venue pins this Pyth PriceUpdateV2 account to the market.
    #[account(owner = PYTH_RECEIVER_PROGRAM_ID)]
    pub test_perp_oracle: UncheckedAccount<'info>,
    /// CHECK: The venue pins this vault to the market.
    #[account(mut)]
    pub test_perp_collateral_vault: UncheckedAccount<'info>,
    /// CHECK: The venue pins this vault to the market.
    #[account(mut)]
    pub test_perp_fee_vault: UncheckedAccount<'info>,
    /// CHECK: The venue pins this vault to the market.
    #[account(mut)]
    pub test_perp_insurance_vault: UncheckedAccount<'info>,
}

#[cfg(not(feature = "devnet-test-perp"))]
pub fn perp_position_and_collateral(
    strategy: &PerpStrategy,
    perp: &CashCarryRiseAccounts,
) -> Result<(i64, i64)> {
    read_position_and_collateral(&perp.rise_trader_account, strategy.asset_id)
}

#[cfg(feature = "devnet-test-perp")]
pub fn perp_position_and_collateral(
    _strategy: &PerpStrategy,
    perp: &CashCarryRiseAccounts,
) -> Result<(i64, i64)> {
    read_position_and_collateral(&perp.test_perp_position)
}

#[cfg(not(feature = "devnet-test-perp"))]
pub fn perp_venue_account_keys(perp: &CashCarryRiseAccounts) -> [Pubkey; PERP_VENUE_ACCOUNT_COUNT] {
    [
        perp.rise_log_authority.key(),
        perp.rise_global_config.key(),
        perp.rise_trader_account.key(),
        perp.rise_perp_asset_map.key(),
        perp.rise_global_trader_index_header.key(),
        perp.rise_active_trader_buffer_header.key(),
        perp.rise_orderbook.key(),
        perp.rise_spline_collection.key(),
    ]
}

#[cfg(feature = "devnet-test-perp")]
pub fn perp_venue_account_keys(perp: &CashCarryRiseAccounts) -> [Pubkey; PERP_VENUE_ACCOUNT_COUNT] {
    [
        perp.test_perp_market.key(),
        perp.test_perp_position.key(),
        perp.test_perp_oracle.key(),
        perp.test_perp_collateral_vault.key(),
        perp.test_perp_fee_vault.key(),
        perp.test_perp_insurance_vault.key(),
    ]
}

/// Binds the admitted perp venue and market record subjects and the strategy to the live accounts.
#[cfg(not(feature = "devnet-test-perp"))]
pub fn validate_perp_accounts(
    strategy: &PerpStrategy,
    perp: &CashCarryRiseAccounts,
    venue_subject: Pubkey,
    market_subject: Pubkey,
) -> Result<()> {
    for (expected, actual) in [
        (venue_subject, perp.rise_global_config.key()),
        (market_subject, perp.rise_orderbook.key()),
        (strategy.trader_account, perp.rise_trader_account.key()),
        (strategy.perp_asset_map, perp.rise_perp_asset_map.key()),
        (strategy.orderbook, perp.rise_orderbook.key()),
        (
            strategy.spline_collection,
            perp.rise_spline_collection.key(),
        ),
    ] {
        require_keys_eq!(
            expected,
            actual,
            ErrorCode::CashCarryResourceAccountMismatch
        );
    }
    Ok(())
}

/// The test perp market account is the subject of both the venue and the market record, like a
/// Whirlpool for the spot leg.
#[cfg(feature = "devnet-test-perp")]
pub fn validate_perp_accounts(
    strategy: &PerpStrategy,
    perp: &CashCarryRiseAccounts,
    venue_subject: Pubkey,
    market_subject: Pubkey,
) -> Result<()> {
    for (expected, actual) in [
        (venue_subject, perp.test_perp_market.key()),
        (market_subject, perp.test_perp_market.key()),
        (strategy.market, perp.test_perp_market.key()),
        (strategy.position, perp.test_perp_position.key()),
    ] {
        require_keys_eq!(
            expected,
            actual,
            ErrorCode::CashCarryResourceAccountMismatch
        );
    }
    Ok(())
}

/// Accounts for one perp order CPI. The controller signs with the executor authority seeds.
pub struct PerpOrderContext<'a, 'info> {
    pub strategy: AccountInfo<'info>,
    pub controller: AccountInfo<'info>,
    pub adapter_program: Pubkey,
    pub venue_program: AccountInfo<'info>,
    pub perp: &'a CashCarryRiseAccounts<'info>,
    pub token_program: AccountInfo<'info>,
    pub remaining_accounts: &'a [AccountInfo<'info>],
}

#[cfg(not(feature = "devnet-test-perp"))]
pub fn invoke_perp_order(
    context: PerpOrderContext,
    signer_seeds: &[&[&[u8]]],
    args: PerpMarketOrderArgs,
    entry: bool,
) -> Result<()> {
    let perp = context.perp;
    let cpi_accounts = naryx_rise_adapter::cpi::accounts::ExecuteRiseOrder {
        strategy: context.strategy.clone(),
        controller: context.controller,
        phoenix_program: context.venue_program,
        log_authority: perp.rise_log_authority.to_account_info(),
        global_config: perp.rise_global_config.to_account_info(),
        permission_account: context.strategy,
        trader_account: perp.rise_trader_account.to_account_info(),
        perp_asset_map: perp.rise_perp_asset_map.to_account_info(),
        global_trader_index_header: perp.rise_global_trader_index_header.to_account_info(),
        active_trader_buffer_header: perp.rise_active_trader_buffer_header.to_account_info(),
        orderbook: perp.rise_orderbook.to_account_info(),
        spline_collection: perp.rise_spline_collection.to_account_info(),
    };
    let cpi = CpiContext::new_with_signer(context.adapter_program, cpi_accounts, signer_seeds)
        .with_remaining_accounts(context.remaining_accounts.to_vec());
    if entry {
        naryx_rise_adapter::cpi::rise_enter_short(cpi, args)
    } else {
        naryx_rise_adapter::cpi::rise_close_short(cpi, args)
    }
}

#[cfg(feature = "devnet-test-perp")]
pub fn invoke_perp_order(
    context: PerpOrderContext,
    signer_seeds: &[&[&[u8]]],
    args: PerpMarketOrderArgs,
    entry: bool,
) -> Result<()> {
    require!(
        context.remaining_accounts.is_empty(),
        ErrorCode::CashCarryQuoteAccountMismatch
    );
    let perp = context.perp;
    let cpi_accounts = naryx_test_perp_adapter::cpi::accounts::ExecuteTestPerpOrder {
        strategy: context.strategy,
        controller: context.controller,
        test_perp_program: context.venue_program,
        market: perp.test_perp_market.to_account_info(),
        position: perp.test_perp_position.to_account_info(),
        oracle: perp.test_perp_oracle.to_account_info(),
        collateral_vault: perp.test_perp_collateral_vault.to_account_info(),
        fee_vault: perp.test_perp_fee_vault.to_account_info(),
        insurance_vault: perp.test_perp_insurance_vault.to_account_info(),
        token_program: context.token_program,
    };
    let cpi = CpiContext::new_with_signer(context.adapter_program, cpi_accounts, signer_seeds);
    if entry {
        naryx_test_perp_adapter::cpi::test_perp_enter_short(cpi, args)
    } else {
        naryx_test_perp_adapter::cpi::test_perp_close_short(cpi, args)
    }
}

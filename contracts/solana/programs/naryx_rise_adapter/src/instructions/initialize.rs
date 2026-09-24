use anchor_lang::prelude::*;
use phoenix_rise_accounts::{
    global_config::{GlobalConfig, LastRestartSlot},
    orderbook::Orderbook,
    pda::derive_spline_collection_address,
    perp_asset_map::PerpAssetMap,
    spline_collection::SplineCollection,
    trader::TraderHeader,
};

use crate::{
    error::RiseAdapterError, RiseStrategy, RISE_GLOBAL_CONFIG, RISE_PROGRAM_ID, RISE_STRATEGY_SEED,
    TRADER_SEED,
};

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InitializeRiseStrategyArgs {
    pub strategy_id: [u8; 32],
    pub controller: Pubkey,
    pub trader_pda_index: u8,
    pub trader_subaccount_index: u8,
    pub asset_id: u32,
    pub max_base_lots: u64,
}

#[derive(Accounts)]
#[instruction(args: InitializeRiseStrategyArgs)]
pub struct InitializeRiseStrategy<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        init,
        payer = owner,
        space = 8 + RiseStrategy::INIT_SPACE,
        seeds = [RISE_STRATEGY_SEED, owner.key().as_ref(), args.strategy_id.as_ref()],
        bump
    )]
    pub strategy: Account<'info, RiseStrategy>,
    /// CHECK: The address, executable bit, and all CPI targets are fixed below.
    #[account(address = RISE_PROGRAM_ID @ RiseAdapterError::InvalidRiseProgram)]
    pub phoenix_program: UncheckedAccount<'info>,
    /// CHECK: Decoded with the official Rise account layout.
    #[account(address = RISE_GLOBAL_CONFIG, owner = RISE_PROGRAM_ID)]
    pub global_config: UncheckedAccount<'info>,
    /// CHECK: Decoded and checked against its canonical Rise PDA and authority fields.
    #[account(owner = RISE_PROGRAM_ID)]
    pub trader_account: UncheckedAccount<'info>,
    /// CHECK: Decoded with the official Rise account layout.
    #[account(owner = RISE_PROGRAM_ID)]
    pub perp_asset_map: UncheckedAccount<'info>,
    /// CHECK: Decoded and bound to the selected Rise asset.
    #[account(owner = RISE_PROGRAM_ID)]
    pub orderbook: UncheckedAccount<'info>,
    /// CHECK: Decoded and checked against the canonical Rise spline PDA.
    #[account(owner = RISE_PROGRAM_ID)]
    pub spline_collection: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<InitializeRiseStrategy>,
    args: InitializeRiseStrategyArgs,
) -> Result<()> {
    require!(
        args.strategy_id.iter().any(|byte| *byte != 0),
        RiseAdapterError::StrategyIdZero
    );
    require_keys_neq!(
        args.controller,
        Pubkey::default(),
        RiseAdapterError::ControllerZero
    );
    require!(
        args.max_base_lots > 0 && args.max_base_lots <= i64::MAX as u64,
        RiseAdapterError::InvalidMaxBaseLots
    );
    require!(
        ctx.accounts.phoenix_program.executable,
        RiseAdapterError::InvalidRiseProgram
    );

    validate_global_config(
        &ctx.accounts.global_config,
        ctx.accounts.perp_asset_map.key(),
    )?;
    validate_trader(
        &ctx.accounts.trader_account,
        ctx.accounts.owner.key(),
        ctx.accounts.strategy.key(),
        args.trader_pda_index,
        args.trader_subaccount_index,
    )?;
    validate_market(
        &ctx.accounts.perp_asset_map,
        &ctx.accounts.orderbook,
        &ctx.accounts.spline_collection,
        args.asset_id,
    )?;

    let strategy = &mut ctx.accounts.strategy;
    strategy.owner = ctx.accounts.owner.key();
    strategy.controller = args.controller;
    strategy.strategy_id = args.strategy_id;
    strategy.trader_account = ctx.accounts.trader_account.key();
    strategy.trader_pda_index = args.trader_pda_index;
    strategy.trader_subaccount_index = args.trader_subaccount_index;
    strategy.asset_id = args.asset_id;
    strategy.perp_asset_map = ctx.accounts.perp_asset_map.key();
    strategy.orderbook = ctx.accounts.orderbook.key();
    strategy.spline_collection = ctx.accounts.spline_collection.key();
    strategy.max_base_lots = args.max_base_lots;
    strategy.bump = ctx.bumps.strategy;
    Ok(())
}

#[inline(never)]
fn validate_global_config(
    account: &UncheckedAccount,
    expected_perp_asset_map: Pubkey,
) -> Result<()> {
    let data = account.try_borrow_data()?;
    let config = GlobalConfig::try_from_account_bytes(&data)
        .map_err(|_| error!(RiseAdapterError::InvalidRiseAccountData))?;
    require!(
        config.account_key() == account.key().to_bytes(),
        RiseAdapterError::GlobalConfigMismatch
    );
    require!(
        config.perp_asset_map_key() == expected_perp_asset_map.to_bytes(),
        RiseAdapterError::GlobalConfigMismatch
    );
    require!(
        config.is_exchange_active(LastRestartSlot::Unknown),
        RiseAdapterError::ExchangeInactive
    );
    require!(
        config.global_trader_index_header_key() != [0; 32]
            && config.active_trader_buffer_header_key() != [0; 32],
        RiseAdapterError::GlobalConfigMismatch
    );
    Ok(())
}

#[inline(never)]
fn validate_trader(
    account: &UncheckedAccount,
    owner: Pubkey,
    strategy: Pubkey,
    trader_pda_index: u8,
    trader_subaccount_index: u8,
) -> Result<()> {
    let pda_schema = [trader_pda_index, trader_subaccount_index];
    let expected = Pubkey::find_program_address(
        &[TRADER_SEED, owner.as_ref(), pda_schema.as_ref()],
        &RISE_PROGRAM_ID,
    )
    .0;
    require_keys_eq!(account.key(), expected, RiseAdapterError::InvalidTraderPda);

    let data = account.try_borrow_data()?;
    let trader = TraderHeader::try_read_from_account_bytes(&data)
        .map_err(|_| error!(RiseAdapterError::InvalidRiseAccountData))?;
    require!(
        trader.key() == &account.key().to_bytes()
            && trader.authority() == &owner.to_bytes()
            && trader.trader_pda_index() == trader_pda_index
            && trader.trader_subaccount_index() == trader_subaccount_index,
        RiseAdapterError::InvalidTraderIdentity
    );
    require!(
        trader.position_authority() == &strategy.to_bytes(),
        RiseAdapterError::InvalidPositionAuthority
    );
    Ok(())
}

#[inline(never)]
fn validate_market(
    perp_asset_map_account: &UncheckedAccount,
    orderbook_account: &UncheckedAccount,
    spline_account: &UncheckedAccount,
    asset_id: u32,
) -> Result<()> {
    let perp_data = perp_asset_map_account.try_borrow_data()?;
    let perp_asset_map = PerpAssetMap::try_from_account_bytes(&perp_data)
        .map_err(|_| error!(RiseAdapterError::InvalidRiseAccountData))?;
    let market_entry = perp_asset_map
        .iter()
        .find_map(|entry| match entry {
            Ok(entry) if entry.metadata.static_market_params().asset_id() == asset_id => {
                Some(entry)
            }
            _ => None,
        })
        .ok_or_else(|| error!(RiseAdapterError::InvalidMarketIdentity))?;
    let params = market_entry.metadata.static_market_params();
    require!(
        params.market_account == orderbook_account.key().to_bytes(),
        RiseAdapterError::InvalidMarketIdentity
    );

    let orderbook_data = orderbook_account.try_borrow_data()?;
    let orderbook = Orderbook::try_from_account_bytes(&orderbook_data)
        .map_err(|_| error!(RiseAdapterError::InvalidRiseAccountData))?;
    require!(
        orderbook.header().asset_id() == asset_id
            && orderbook.header().base_lots_decimals() == params.base_lot_decimals
            && orderbook
                .header()
                .asset_symbol()
                .map_err(|_| error!(RiseAdapterError::InvalidRiseAccountData))?
                == market_entry.symbol,
        RiseAdapterError::InvalidMarketIdentity
    );

    let expected_spline =
        derive_spline_collection_address(&RISE_PROGRAM_ID, &orderbook_account.key());
    require_keys_eq!(
        spline_account.key(),
        expected_spline,
        RiseAdapterError::InvalidSplineCollection
    );
    let spline_data = spline_account.try_borrow_data()?;
    let spline = SplineCollection::try_from_account_bytes(&spline_data)
        .map_err(|_| error!(RiseAdapterError::InvalidRiseAccountData))?;
    require!(
        spline.market() == orderbook_account.key().to_bytes()
            && spline.asset_symbol() == market_entry.symbol,
        RiseAdapterError::InvalidSplineCollection
    );
    Ok(())
}

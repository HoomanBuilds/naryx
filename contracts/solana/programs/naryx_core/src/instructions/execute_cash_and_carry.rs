use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount};
use naryx_orca_adapter::{program::NaryxOrcaAdapter, ORCA_WHIRLPOOL_PROGRAM_ID};
use naryx_rise_adapter::{
    program::NaryxRiseAdapter, read_position_and_collateral, RiseMarketOrderArgs, RiseStrategy,
    RISE_GLOBAL_CONFIG, RISE_LOG_AUTHORITY, RISE_PROGRAM_ID,
};
use solana_instructions_sysvar::{load_current_index_checked, load_instruction_at_checked};
use solana_sdk_ids::ed25519_program;
use solana_sha256_hasher::hashv;

use crate::{
    constants::{
        CASH_CARRY_EXECUTOR_SEED, CASH_CARRY_NONCE_SEED, CASH_CARRY_OPEN_SEED,
        CASH_CARRY_RECEIPT_SEED, PROTOCOL_CONFIG_SEED, SOLVER_REGISTRY_SEED,
    },
    error::ErrorCode,
    events::CashCarryExecutionRecorded,
    instructions::resource_registry::{
        validate_cash_carry_admission, validate_cash_carry_exit_admission, verify_code_identity,
        CashCarryAdmission, CashCarryResources, ResourceAction,
    },
    state::{
        CashCarryExecutionReceipt, CashCarryNonce, ManifestRef, OpenCashCarryPackage,
        ProtocolConfig, ResourceIndex, ResourceRecord, SettlementClass, SolverRegistry,
    },
    wire::{DomainRef, HASH_BYTE_LENGTH},
};

const EXECUTION_DIGEST_DOMAIN: &[u8] = b"NARYX/cash-carry-execution/v1";
const RESOURCE_COMMITMENT_DOMAIN: &[u8] = b"NARYX/cash-carry-resources/v1";
const ROUTE_ACCOUNTS_DOMAIN: &[u8] = b"NARYX/cash-carry-route-accounts/v1";
const PACKAGE_ACCOUNTS_DOMAIN: &[u8] = b"NARYX/cash-carry-package-accounts/v1";
const OPEN_PACKAGE_VERSION: u8 = 1;
pub const RISE_COLLATERAL_MUST_BE_PREFUNDED: bool = true;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum CashCarryAction {
    Entry,
    Exit,
}

impl CashCarryAction {
    fn discriminant(self) -> u8 {
        match self {
            Self::Entry => 1,
            Self::Exit => 2,
        }
    }

    fn resource_action(self) -> ResourceAction {
        match self {
            Self::Entry => ResourceAction::Entry,
            Self::Exit => ResourceAction::Exit,
        }
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct CashCarryExecutionArgs {
    pub action: CashCarryAction,
    pub spot_quantity_atoms: u64,
    pub perp_quantity_atoms: u64,
    pub spot_limit_quote_atoms_per_base_lot: u64,
    pub perp_limit_quote_atoms_per_base_lot: u64,
    pub package_notional_atoms: u64,
    pub spot_sqrt_price_limit: u128,
    pub minimum_rise_collateral_quote_lots: i64,
    pub client_order_id: u128,
    pub expiry_slot: u64,
    pub nonce: u64,
}

#[derive(Accounts)]
#[instruction(order_hash: [u8; HASH_BYTE_LENGTH], quote_hash: [u8; HASH_BYTE_LENGTH], route_hash: [u8; HASH_BYTE_LENGTH], args: CashCarryExecutionArgs)]
pub struct ExecuteCashAndCarry<'info> {
    #[account(mut)]
    pub trader: Signer<'info>,
    #[account(seeds = [PROTOCOL_CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, ProtocolConfig>>,
    #[account(seeds = [SOLVER_REGISTRY_SEED], bump = solver_registry.bump)]
    pub solver_registry: Box<Account<'info, SolverRegistry>>,
    #[account(
        init,
        payer = trader,
        space = 8 + CashCarryExecutionReceipt::INIT_SPACE,
        seeds = [CASH_CARRY_RECEIPT_SEED, trader.key().as_ref(), order_hash.as_ref()],
        bump
    )]
    pub receipt: Box<Account<'info, CashCarryExecutionReceipt>>,
    #[account(
        init,
        payer = trader,
        space = 8 + CashCarryNonce::INIT_SPACE,
        seeds = [CASH_CARRY_NONCE_SEED, trader.key().as_ref(), args.nonce.to_be_bytes().as_ref()],
        bump
    )]
    pub nonce_marker: Box<Account<'info, CashCarryNonce>>,
    #[account(
        init_if_needed,
        payer = trader,
        space = 8 + OpenCashCarryPackage::INIT_SPACE,
        seeds = [CASH_CARRY_OPEN_SEED, trader.key().as_ref(), rise_strategy.key().as_ref()],
        bump
    )]
    pub open_package: Box<Account<'info, OpenCashCarryPackage>>,
    /// CHECK: Entry uses the system program sentinel. Exit validates the stored receipt exactly.
    pub entry_receipt: UncheckedAccount<'info>,
    /// CHECK: This exact PDA is the only controller accepted by the Rise strategy.
    #[account(
        seeds = [CASH_CARRY_EXECUTOR_SEED, trader.key().as_ref(), rise_strategy.key().as_ref()],
        bump
    )]
    pub executor_authority: UncheckedAccount<'info>,

    pub resources: CashCarryResourceAccounts<'info>,
    pub programs: CashCarryProgramAccounts<'info>,
    pub spot: CashCarrySpotAccounts<'info>,

    #[account(
        mut,
        constraint = rise_strategy.owner == trader.key() @ ErrorCode::CashCarryResourceAccountMismatch,
        constraint = rise_strategy.controller == executor_authority.key() @ ErrorCode::CashCarryResourceAccountMismatch
    )]
    pub rise_strategy: Box<Account<'info, RiseStrategy>>,
    pub rise: CashCarryRiseAccounts<'info>,
    pub runtime: CashCarryRuntimeAccounts<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CashCarryResourceAccounts<'info> {
    pub spot_adapter_index: Box<Account<'info, ResourceIndex>>,
    pub perp_adapter_index: Box<Account<'info, ResourceIndex>>,
    pub spot_market_index: Box<Account<'info, ResourceIndex>>,
    pub perp_market_index: Box<Account<'info, ResourceIndex>>,
    pub spot_venue_index: Box<Account<'info, ResourceIndex>>,
    pub perp_venue_index: Box<Account<'info, ResourceIndex>>,
    pub base_asset_index: Box<Account<'info, ResourceIndex>>,
    pub quote_asset_index: Box<Account<'info, ResourceIndex>>,
    pub spot_adapter_record: Box<Account<'info, ResourceRecord>>,
    pub perp_adapter_record: Box<Account<'info, ResourceRecord>>,
    pub spot_market_record: Box<Account<'info, ResourceRecord>>,
    pub perp_market_record: Box<Account<'info, ResourceRecord>>,
    pub spot_venue_record: Box<Account<'info, ResourceRecord>>,
    pub perp_venue_record: Box<Account<'info, ResourceRecord>>,
    pub base_asset_record: Box<Account<'info, ResourceRecord>>,
    pub quote_asset_record: Box<Account<'info, ResourceRecord>>,
}

#[derive(Accounts)]
pub struct CashCarryProgramAccounts<'info> {
    pub spot_adapter_program: Program<'info, NaryxOrcaAdapter>,
    /// CHECK: Its deterministic address and bytes are verified against the admitted adapter record.
    pub spot_adapter_program_data: UncheckedAccount<'info>,
    pub perp_adapter_program: Program<'info, NaryxRiseAdapter>,
    /// CHECK: Its deterministic address and bytes are verified against the admitted adapter record.
    pub perp_adapter_program_data: UncheckedAccount<'info>,
    /// CHECK: Fixed to Orca and verified against admitted venue records that reference its code.
    #[account(address = ORCA_WHIRLPOOL_PROGRAM_ID, executable)]
    pub spot_venue_program: UncheckedAccount<'info>,
    /// CHECK: Its deterministic address and bytes are verified against admitted venue records.
    pub spot_venue_program_data: UncheckedAccount<'info>,
    /// CHECK: Fixed to Rise and verified against admitted venue records that reference its code.
    #[account(address = RISE_PROGRAM_ID, executable)]
    pub perp_venue_program: UncheckedAccount<'info>,
    /// CHECK: Its deterministic address and bytes are verified against admitted venue records.
    pub perp_venue_program_data: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct CashCarrySpotAccounts<'info> {
    #[account(mut)]
    pub trader_token_a: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        constraint = trader_token_a.mint != trader_token_b.mint @ ErrorCode::CashCarryTokenAccountMismatch
    )]
    pub trader_token_b: Box<Account<'info, TokenAccount>>,
    #[account(mut, constraint = spot_vault_a.mint == trader_token_a.mint)]
    pub spot_vault_a: Box<Account<'info, TokenAccount>>,
    #[account(mut, constraint = spot_vault_b.mint == trader_token_b.mint)]
    pub spot_vault_b: Box<Account<'info, TokenAccount>>,
    /// CHECK: Its owner and exact identity are checked here and by the typed adapter.
    #[account(mut, owner = ORCA_WHIRLPOOL_PROGRAM_ID)]
    pub whirlpool: UncheckedAccount<'info>,
    /// CHECK: The typed adapter and Orca validate the account layout and sequence.
    #[account(mut, owner = ORCA_WHIRLPOOL_PROGRAM_ID)]
    pub tick_array_0: UncheckedAccount<'info>,
    /// CHECK: The typed adapter and Orca validate the account layout and sequence.
    #[account(mut, owner = ORCA_WHIRLPOOL_PROGRAM_ID)]
    pub tick_array_1: UncheckedAccount<'info>,
    /// CHECK: The typed adapter and Orca validate the account layout and sequence.
    #[account(mut, owner = ORCA_WHIRLPOOL_PROGRAM_ID)]
    pub tick_array_2: UncheckedAccount<'info>,
    /// CHECK: Its canonical PDA is checked before the swap.
    #[account(mut)]
    pub whirlpool_oracle: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct CashCarryRiseAccounts<'info> {
    /// CHECK: Fixed to the Rise log authority.
    #[account(address = RISE_LOG_AUTHORITY)]
    pub rise_log_authority: UncheckedAccount<'info>,
    /// CHECK: The adapter decodes this with the official Rise account layout.
    #[account(mut, address = RISE_GLOBAL_CONFIG, owner = RISE_PROGRAM_ID)]
    pub rise_global_config: UncheckedAccount<'info>,
    /// CHECK: The adapter decodes and binds this account to the strategy.
    #[account(mut, owner = RISE_PROGRAM_ID)]
    pub rise_trader_account: UncheckedAccount<'info>,
    /// CHECK: The adapter decodes and binds this market map to the strategy.
    #[account(mut, owner = RISE_PROGRAM_ID)]
    pub rise_perp_asset_map: UncheckedAccount<'info>,
    /// CHECK: The adapter derives this address from the Rise global configuration.
    #[account(mut, owner = RISE_PROGRAM_ID)]
    pub rise_global_trader_index_header: UncheckedAccount<'info>,
    /// CHECK: The adapter derives this address from the Rise global configuration.
    #[account(mut, owner = RISE_PROGRAM_ID)]
    pub rise_active_trader_buffer_header: UncheckedAccount<'info>,
    /// CHECK: The adapter decodes and binds this market to the strategy.
    #[account(mut, owner = RISE_PROGRAM_ID)]
    pub rise_orderbook: UncheckedAccount<'info>,
    /// CHECK: The adapter derives and decodes this spline collection.
    #[account(mut, owner = RISE_PROGRAM_ID)]
    pub rise_spline_collection: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct CashCarryRuntimeAccounts<'info> {
    pub token_program: Program<'info, Token>,
    /// CHECK: The address constraint pins the immediately preceding Ed25519 instruction lookup.
    #[account(address = solana_instructions_sysvar::id())]
    pub instructions_sysvar: UncheckedAccount<'info>,
}

pub fn execution_digest(
    domain: &DomainRef,
    order_hash: [u8; 32],
    quote_hash: [u8; 32],
    route_hash: [u8; 32],
    args: &CashCarryExecutionArgs,
    resource_admission_commitment: [u8; 32],
    account_keys: &[Pubkey],
) -> [u8; 32] {
    let mut data = Vec::with_capacity(256 + account_keys.len() * 32);
    data.extend_from_slice(&domain.canonical_bytes());
    data.extend_from_slice(&order_hash);
    data.extend_from_slice(&quote_hash);
    data.extend_from_slice(&route_hash);
    data.push(args.action.discriminant());
    data.extend_from_slice(&args.spot_quantity_atoms.to_be_bytes());
    data.extend_from_slice(&args.perp_quantity_atoms.to_be_bytes());
    data.extend_from_slice(&args.spot_limit_quote_atoms_per_base_lot.to_be_bytes());
    data.extend_from_slice(&args.perp_limit_quote_atoms_per_base_lot.to_be_bytes());
    data.extend_from_slice(&args.package_notional_atoms.to_be_bytes());
    data.extend_from_slice(&args.spot_sqrt_price_limit.to_be_bytes());
    data.extend_from_slice(&args.minimum_rise_collateral_quote_lots.to_be_bytes());
    data.extend_from_slice(&args.client_order_id.to_be_bytes());
    data.extend_from_slice(&args.expiry_slot.to_be_bytes());
    data.extend_from_slice(&args.nonce.to_be_bytes());
    data.extend_from_slice(&resource_admission_commitment);
    data.extend_from_slice(&(account_keys.len() as u32).to_be_bytes());
    for key in account_keys {
        data.extend_from_slice(key.as_ref());
    }
    hashv(&[EXECUTION_DIGEST_DOMAIN, &data]).to_bytes()
}

pub(crate) fn handler<'info>(
    ctx: Context<'info, ExecuteCashAndCarry<'info>>,
    order_hash: [u8; HASH_BYTE_LENGTH],
    quote_hash: [u8; HASH_BYTE_LENGTH],
    route_hash: [u8; HASH_BYTE_LENGTH],
    args: CashCarryExecutionArgs,
) -> Result<()> {
    validate_basic_inputs(order_hash, quote_hash, route_hash, &args)?;
    let execution_slot = Clock::get()?.slot;
    validate_expiry(execution_slot, args.expiry_slot)?;
    if args.action == CashCarryAction::Entry {
        require!(
            !ctx.accounts.config.entry_paused,
            ErrorCode::CashCarryEntryPaused
        );
    }
    let resources = CashCarryResources {
        spot_adapter: &ctx.accounts.resources.spot_adapter_record,
        perp_adapter: &ctx.accounts.resources.perp_adapter_record,
        spot_market: &ctx.accounts.resources.spot_market_record,
        perp_market: &ctx.accounts.resources.perp_market_record,
        spot_venue: &ctx.accounts.resources.spot_venue_record,
        perp_venue: &ctx.accounts.resources.perp_venue_record,
        base_asset: &ctx.accounts.resources.base_asset_record,
        quote_asset: &ctx.accounts.resources.quote_asset_record,
    };
    let admission = reconstruct_admission(&ctx.accounts, &args)?;
    let resource_admission_commitment =
        resource_admission_commitment(&admission, &resource_record_keys(&ctx.accounts));
    let route_accounts_commitment =
        route_accounts_commitment(&ctx.accounts, ctx.remaining_accounts);
    let package_accounts_commitment = package_accounts_commitment(&ctx.accounts);
    validate_package_lifecycle(
        &ctx.accounts,
        &args,
        resource_admission_commitment,
        package_accounts_commitment,
    )?;
    match args.action {
        CashCarryAction::Entry => {
            validate_cash_carry_admission(&ctx.accounts.config, &admission, &resources)?;
            validate_resource_indices(&ctx.accounts, true)?;
        }
        CashCarryAction::Exit => {
            validate_cash_carry_exit_admission(&ctx.accounts.config, &admission, &resources)?;
            validate_resource_indices(&ctx.accounts, false)?;
        }
    }
    validate_live_resource_accounts(&ctx.accounts)?;

    let solver = ctx.accounts.solver_registry.active;
    require_keys_neq!(solver, Pubkey::default(), ErrorCode::CashCarrySolverInvalid);
    let account_keys = execution_account_keys(&ctx.accounts, ctx.remaining_accounts, solver);
    let digest = execution_digest(
        &ctx.accounts.config.domain,
        order_hash,
        quote_hash,
        route_hash,
        &args,
        resource_admission_commitment,
        &account_keys,
    );
    require_solver_signature(&ctx.accounts.runtime.instructions_sysvar, &solver, &digest)?;

    let (base_is_a, pre_base_balance, pre_quote_balance) = token_route_and_balances(&ctx.accounts)?;
    let (pre_rise_base_lots, pre_rise_collateral_quote_lots) = read_position_and_collateral(
        &ctx.accounts.rise.rise_trader_account,
        ctx.accounts.rise_strategy.asset_id,
    )?;
    let (perp_base_lots, perp_limit_ticks, spot_quote_limit_atoms) =
        execution_units(&admission, &ctx.accounts)?;
    validate_preconditions(
        &args,
        pre_rise_base_lots,
        pre_rise_collateral_quote_lots,
        perp_base_lots,
    )?;

    match args.action {
        CashCarryAction::Entry => {
            execute_spot(
                &ctx,
                args.spot_quantity_atoms,
                spot_quote_limit_atoms,
                args.spot_sqrt_price_limit,
                !base_is_a,
                false,
            )?;
            execute_rise(
                &ctx,
                RiseMarketOrderArgs {
                    base_lots: perp_base_lots,
                    limit_price_in_ticks: perp_limit_ticks,
                    last_valid_slot: args.expiry_slot - 1,
                    min_post_collateral_quote_lots: args.minimum_rise_collateral_quote_lots,
                    client_order_id: args.client_order_id,
                },
                true,
            )?;
        }
        CashCarryAction::Exit => {
            execute_rise(
                &ctx,
                RiseMarketOrderArgs {
                    base_lots: perp_base_lots,
                    limit_price_in_ticks: perp_limit_ticks,
                    last_valid_slot: args.expiry_slot - 1,
                    min_post_collateral_quote_lots: args.minimum_rise_collateral_quote_lots,
                    client_order_id: args.client_order_id,
                },
                false,
            )?;
            execute_spot(
                &ctx,
                args.spot_quantity_atoms,
                spot_quote_limit_atoms,
                args.spot_sqrt_price_limit,
                base_is_a,
                true,
            )?;
        }
    }

    ctx.accounts.spot.trader_token_a.reload()?;
    ctx.accounts.spot.trader_token_b.reload()?;
    let (_, post_base_balance, post_quote_balance) = token_route_and_balances(&ctx.accounts)?;
    let (post_rise_base_lots, post_rise_collateral_quote_lots) = read_position_and_collateral(
        &ctx.accounts.rise.rise_trader_account,
        ctx.accounts.rise_strategy.asset_id,
    )?;
    let spot_quote_delta_atoms = enforce_postconditions(
        &args,
        pre_base_balance,
        post_base_balance,
        pre_quote_balance,
        post_quote_balance,
        pre_rise_base_lots,
        post_rise_base_lots,
        post_rise_collateral_quote_lots,
        perp_base_lots,
        spot_quote_limit_atoms,
    )?;

    let entry_receipt = match args.action {
        CashCarryAction::Entry => ctx.accounts.receipt.key(),
        CashCarryAction::Exit => ctx.accounts.open_package.entry_receipt,
    };
    ctx.accounts.receipt.set_inner(CashCarryExecutionReceipt {
        domain: ctx.accounts.config.domain.clone(),
        order_hash,
        quote_hash,
        route_hash,
        trader: ctx.accounts.trader.key(),
        solver,
        nonce: args.nonce,
        execution_digest: digest,
        action: args.action.discriminant(),
        spot_quantity_atoms: args.spot_quantity_atoms,
        perp_quantity_atoms: args.perp_quantity_atoms,
        spot_quote_delta_atoms,
        pre_base_balance,
        post_base_balance,
        pre_quote_balance,
        post_quote_balance,
        pre_rise_base_lots,
        post_rise_base_lots,
        pre_rise_collateral_quote_lots,
        post_rise_collateral_quote_lots,
        execution_slot,
        resource_admission_commitment,
        route_accounts_commitment,
        entry_receipt,
        bump: ctx.bumps.receipt,
    });
    ctx.accounts.nonce_marker.set_inner(CashCarryNonce {
        order_hash,
        execution_digest: digest,
        bump: ctx.bumps.nonce_marker,
    });

    if args.action == CashCarryAction::Entry {
        ctx.accounts.open_package.set_inner(OpenCashCarryPackage {
            version: OPEN_PACKAGE_VERSION,
            domain: ctx.accounts.config.domain.clone(),
            trader: ctx.accounts.trader.key(),
            entry_receipt,
            entry_route_hash: route_hash,
            resource_admission_commitment,
            entry_route_accounts_commitment: route_accounts_commitment,
            package_accounts_commitment,
            spot_quantity_atoms: args.spot_quantity_atoms,
            perp_quantity_atoms: args.perp_quantity_atoms,
            bump: ctx.bumps.open_package,
        });
    }

    emit!(CashCarryExecutionRecorded {
        receipt: ctx.accounts.receipt.key(),
        domain: ctx.accounts.config.domain.clone(),
        order_hash,
        quote_hash,
        route_hash,
        trader: ctx.accounts.trader.key(),
        solver,
        nonce: args.nonce,
        execution_digest: digest,
        action: args.action.discriminant(),
        spot_quantity_atoms: args.spot_quantity_atoms,
        perp_quantity_atoms: args.perp_quantity_atoms,
        spot_quote_delta_atoms,
        pre_base_balance,
        post_base_balance,
        pre_quote_balance,
        post_quote_balance,
        pre_rise_base_lots,
        post_rise_base_lots,
        pre_rise_collateral_quote_lots,
        post_rise_collateral_quote_lots,
        execution_slot,
        resource_admission_commitment,
        route_accounts_commitment,
        entry_receipt,
    });

    if args.action == CashCarryAction::Exit {
        ctx.accounts
            .open_package
            .close(ctx.accounts.trader.to_account_info())?;
    }
    Ok(())
}

fn validate_basic_inputs(
    order_hash: [u8; 32],
    quote_hash: [u8; 32],
    route_hash: [u8; 32],
    args: &CashCarryExecutionArgs,
) -> Result<()> {
    for hash in [order_hash, quote_hash, route_hash] {
        require!(hash != [0u8; 32], ErrorCode::CashCarryHashZero);
    }
    require!(args.nonce != 0, ErrorCode::CashCarryNonceZero);
    require!(
        args.spot_sqrt_price_limit != 0,
        ErrorCode::CashCarryRouteDirectionInvalid
    );
    Ok(())
}

fn validate_expiry(current_slot: u64, expiry_slot: u64) -> Result<()> {
    require!(current_slot < expiry_slot, ErrorCode::CashCarryOrderExpired);
    Ok(())
}

fn validate_resource_indices(
    accounts: &ExecuteCashAndCarry,
    require_current_active: bool,
) -> Result<()> {
    let pairs = [
        (
            &accounts.resources.spot_adapter_index,
            &accounts.resources.spot_adapter_record,
        ),
        (
            &accounts.resources.perp_adapter_index,
            &accounts.resources.perp_adapter_record,
        ),
        (
            &accounts.resources.spot_market_index,
            &accounts.resources.spot_market_record,
        ),
        (
            &accounts.resources.perp_market_index,
            &accounts.resources.perp_market_record,
        ),
        (
            &accounts.resources.spot_venue_index,
            &accounts.resources.spot_venue_record,
        ),
        (
            &accounts.resources.perp_venue_index,
            &accounts.resources.perp_venue_record,
        ),
        (
            &accounts.resources.base_asset_index,
            &accounts.resources.base_asset_record,
        ),
        (
            &accounts.resources.quote_asset_index,
            &accounts.resources.quote_asset_record,
        ),
    ];
    for (index, record) in pairs {
        let expected_index = Pubkey::find_program_address(
            &[
                crate::constants::RESOURCE_INDEX_SEED,
                record.manifest.kind.seed(),
                record.manifest.identity.subject_id.as_ref(),
            ],
            &crate::id(),
        )
        .0;
        require_keys_eq!(
            index.key(),
            expected_index,
            ErrorCode::CashCarryResourceNotCurrent
        );
        require!(
            index.kind == record.manifest.kind
                && index.subject_id == record.manifest.identity.subject_id,
            ErrorCode::CashCarryResourceNotCurrent
        );
        if require_current_active {
            require!(
                index.active_record == record.key()
                    && index.active_identity.as_ref() == Some(&record.manifest.identity)
                    && record.active,
                ErrorCode::CashCarryResourceNotCurrent
            );
        }
    }
    Ok(())
}

fn reconstruct_admission(
    accounts: &ExecuteCashAndCarry,
    args: &CashCarryExecutionArgs,
) -> Result<CashCarryAdmission> {
    let template = accounts
        .resources
        .spot_adapter_record
        .manifest
        .allowed_template
        .clone()
        .ok_or_else(|| error!(ErrorCode::CashCarryResourceAccountMismatch))?;
    let settlement = accounts
        .resources
        .spot_adapter_record
        .manifest
        .settlement
        .clone()
        .ok_or_else(|| error!(ErrorCode::CashCarryResourceAccountMismatch))?;
    Ok(CashCarryAdmission {
        domain: accounts.config.domain.clone(),
        spot_adapter: accounts
            .resources
            .spot_adapter_record
            .manifest
            .identity
            .clone(),
        perp_adapter: accounts
            .resources
            .perp_adapter_record
            .manifest
            .identity
            .clone(),
        spot_market: accounts
            .resources
            .spot_market_record
            .manifest
            .identity
            .clone(),
        perp_market: accounts
            .resources
            .perp_market_record
            .manifest
            .identity
            .clone(),
        spot_venue: accounts
            .resources
            .spot_venue_record
            .manifest
            .identity
            .clone(),
        perp_venue: accounts
            .resources
            .perp_venue_record
            .manifest
            .identity
            .clone(),
        base_asset: accounts
            .resources
            .base_asset_record
            .manifest
            .identity
            .clone(),
        quote_asset: accounts
            .resources
            .quote_asset_record
            .manifest
            .identity
            .clone(),
        quote_decimals: accounts.resources.quote_asset_record.manifest.decimals,
        template,
        settlement,
        action: args.action.resource_action(),
        spot_quantity_atoms: args.spot_quantity_atoms,
        perp_quantity_atoms: args.perp_quantity_atoms,
        spot_limit_quote_atoms_per_base_lot: args.spot_limit_quote_atoms_per_base_lot,
        perp_limit_quote_atoms_per_base_lot: args.perp_limit_quote_atoms_per_base_lot,
        package_notional_atoms: args.package_notional_atoms,
    })
}

fn validate_live_resource_accounts(accounts: &ExecuteCashAndCarry) -> Result<()> {
    verify_code_identity(
        &accounts.resources.spot_adapter_record.manifest,
        &accounts.programs.spot_adapter_program,
        &accounts.programs.spot_adapter_program_data,
    )?;
    verify_code_identity(
        &accounts.resources.perp_adapter_record.manifest,
        &accounts.programs.perp_adapter_program,
        &accounts.programs.perp_adapter_program_data,
    )?;
    for record in [
        &accounts.resources.spot_venue_record,
        &accounts.resources.spot_market_record,
    ] {
        verify_code_identity(
            &record.manifest,
            &accounts.programs.spot_venue_program,
            &accounts.programs.spot_venue_program_data,
        )?;
    }
    for record in [
        &accounts.resources.perp_venue_record,
        &accounts.resources.perp_market_record,
    ] {
        verify_code_identity(
            &record.manifest,
            &accounts.programs.perp_venue_program,
            &accounts.programs.perp_venue_program_data,
        )?;
    }
    require_keys_eq!(
        accounts
            .resources
            .spot_adapter_record
            .manifest
            .subject_address,
        accounts.programs.spot_adapter_program.key(),
        ErrorCode::CashCarryResourceAccountMismatch
    );
    require_keys_eq!(
        accounts
            .resources
            .perp_adapter_record
            .manifest
            .subject_address,
        accounts.programs.perp_adapter_program.key(),
        ErrorCode::CashCarryResourceAccountMismatch
    );
    require_keys_eq!(
        accounts
            .resources
            .spot_venue_record
            .manifest
            .subject_address,
        accounts.spot.whirlpool.key(),
        ErrorCode::CashCarryResourceAccountMismatch
    );
    require_keys_eq!(
        accounts
            .resources
            .spot_market_record
            .manifest
            .subject_address,
        accounts.spot.whirlpool.key(),
        ErrorCode::CashCarryResourceAccountMismatch
    );
    require_keys_eq!(
        accounts
            .resources
            .perp_venue_record
            .manifest
            .subject_address,
        accounts.rise.rise_global_config.key(),
        ErrorCode::CashCarryResourceAccountMismatch
    );
    require_keys_eq!(
        accounts
            .resources
            .perp_market_record
            .manifest
            .subject_address,
        accounts.rise.rise_orderbook.key(),
        ErrorCode::CashCarryResourceAccountMismatch
    );
    require_keys_eq!(
        accounts.rise_strategy.trader_account,
        accounts.rise.rise_trader_account.key(),
        ErrorCode::CashCarryResourceAccountMismatch
    );
    require_keys_eq!(
        accounts.rise_strategy.perp_asset_map,
        accounts.rise.rise_perp_asset_map.key(),
        ErrorCode::CashCarryResourceAccountMismatch
    );
    require_keys_eq!(
        accounts.rise_strategy.orderbook,
        accounts.rise.rise_orderbook.key(),
        ErrorCode::CashCarryResourceAccountMismatch
    );
    require_keys_eq!(
        accounts.rise_strategy.spline_collection,
        accounts.rise.rise_spline_collection.key(),
        ErrorCode::CashCarryResourceAccountMismatch
    );
    let expected_oracle = Pubkey::find_program_address(
        &[b"oracle", accounts.spot.whirlpool.key().as_ref()],
        &ORCA_WHIRLPOOL_PROGRAM_ID,
    )
    .0;
    require_keys_eq!(
        accounts.spot.whirlpool_oracle.key(),
        expected_oracle,
        ErrorCode::CashCarryResourceAccountMismatch
    );
    Ok(())
}

fn validate_package_lifecycle(
    accounts: &ExecuteCashAndCarry,
    args: &CashCarryExecutionArgs,
    resource_commitment: [u8; 32],
    package_accounts_commitment: [u8; 32],
) -> Result<()> {
    match args.action {
        CashCarryAction::Entry => {
            require!(
                accounts.open_package.version == 0,
                ErrorCode::CashCarryPackageAlreadyOpen
            );
            require_keys_eq!(
                accounts.entry_receipt.key(),
                anchor_lang::system_program::ID,
                ErrorCode::CashCarryEntryReceiptInvalid
            );
        }
        CashCarryAction::Exit => {
            let open = &accounts.open_package;
            require!(
                open.version == OPEN_PACKAGE_VERSION,
                ErrorCode::CashCarryPackageNotOpen
            );
            require!(
                open.domain == accounts.config.domain
                    && open.trader == accounts.trader.key()
                    && open.resource_admission_commitment == resource_commitment
                    && open.package_accounts_commitment == package_accounts_commitment
                    && open.spot_quantity_atoms == args.spot_quantity_atoms
                    && open.perp_quantity_atoms == args.perp_quantity_atoms,
                ErrorCode::CashCarryOpenPackageMismatch
            );
            require_keys_eq!(
                accounts.entry_receipt.key(),
                open.entry_receipt,
                ErrorCode::CashCarryEntryReceiptInvalid
            );
            require_keys_eq!(
                *accounts.entry_receipt.owner,
                crate::id(),
                ErrorCode::CashCarryEntryReceiptInvalid
            );
            let data = accounts.entry_receipt.try_borrow_data()?;
            let entry = CashCarryExecutionReceipt::try_deserialize(&mut data.as_ref())
                .map_err(|_| error!(ErrorCode::CashCarryEntryReceiptInvalid))?;
            require!(
                entry.action == CashCarryAction::Entry.discriminant()
                    && entry.trader == accounts.trader.key()
                    && entry.route_hash == open.entry_route_hash
                    && entry.resource_admission_commitment == resource_commitment
                    && entry.route_accounts_commitment == open.entry_route_accounts_commitment
                    && entry.spot_quantity_atoms == args.spot_quantity_atoms
                    && entry.perp_quantity_atoms == args.perp_quantity_atoms,
                ErrorCode::CashCarryEntryReceiptInvalid
            );
        }
    }
    Ok(())
}

fn validate_preconditions(
    args: &CashCarryExecutionArgs,
    pre_rise_base_lots: i64,
    pre_collateral: i64,
    perp_base_lots: u64,
) -> Result<()> {
    let exact_short = i64::try_from(perp_base_lots)
        .map_err(|_| error!(ErrorCode::CashCarryArithmeticOverflow))?;
    match args.action {
        CashCarryAction::Entry => {
            require!(
                pre_rise_base_lots == 0,
                ErrorCode::CashCarryPostconditionFailed
            );
            require!(
                RISE_COLLATERAL_MUST_BE_PREFUNDED
                    && args.minimum_rise_collateral_quote_lots > 0
                    && pre_collateral >= args.minimum_rise_collateral_quote_lots,
                ErrorCode::CashCarryCollateralNotPrefunded
            );
        }
        CashCarryAction::Exit => require!(
            pre_rise_base_lots == -exact_short,
            ErrorCode::CashCarryOpenPackageMismatch
        ),
    }
    Ok(())
}

fn token_route_and_balances(accounts: &ExecuteCashAndCarry) -> Result<(bool, u64, u64)> {
    require!(
        accounts.spot.trader_token_a.owner == accounts.trader.key()
            && accounts.spot.trader_token_b.owner == accounts.trader.key(),
        ErrorCode::CashCarryTokenAccountMismatch
    );
    let base_mint = accounts
        .resources
        .base_asset_record
        .manifest
        .subject_address;
    let quote_mint = accounts
        .resources
        .quote_asset_record
        .manifest
        .subject_address;
    require_keys_eq!(
        accounts.resources.base_asset_record.manifest.program_id,
        anchor_spl::token::ID,
        ErrorCode::CashCarryTokenAccountMismatch
    );
    require_keys_eq!(
        accounts.resources.quote_asset_record.manifest.program_id,
        anchor_spl::token::ID,
        ErrorCode::CashCarryTokenAccountMismatch
    );
    if accounts.spot.trader_token_a.mint == base_mint
        && accounts.spot.trader_token_b.mint == quote_mint
    {
        Ok((
            true,
            accounts.spot.trader_token_a.amount,
            accounts.spot.trader_token_b.amount,
        ))
    } else if accounts.spot.trader_token_b.mint == base_mint
        && accounts.spot.trader_token_a.mint == quote_mint
    {
        Ok((
            false,
            accounts.spot.trader_token_b.amount,
            accounts.spot.trader_token_a.amount,
        ))
    } else {
        err!(ErrorCode::CashCarryTokenAccountMismatch)
    }
}

fn execution_units(
    admission: &CashCarryAdmission,
    accounts: &ExecuteCashAndCarry,
) -> Result<(u64, u64, u64)> {
    let spot_units = accounts
        .resources
        .spot_market_record
        .manifest
        .market_units
        .as_ref()
        .ok_or_else(|| error!(ErrorCode::CashCarryResourceAccountMismatch))?;
    let perp_units = accounts
        .resources
        .perp_market_record
        .manifest
        .market_units
        .as_ref()
        .ok_or_else(|| error!(ErrorCode::CashCarryResourceAccountMismatch))?;
    let spot_base_lots = admission.spot_quantity_atoms / spot_units.base_lot_atoms;
    let spot_quote_limit_atoms = spot_base_lots
        .checked_mul(admission.spot_limit_quote_atoms_per_base_lot)
        .ok_or_else(|| error!(ErrorCode::CashCarryArithmeticOverflow))?;
    let perp_base_lots = admission.perp_quantity_atoms / perp_units.base_lot_atoms;
    let perp_limit_ticks =
        admission.perp_limit_quote_atoms_per_base_lot / perp_units.quote_tick_atoms_per_base_lot;
    require!(
        perp_base_lots != 0 && perp_limit_ticks != 0,
        ErrorCode::CashCarryArithmeticOverflow
    );
    Ok((perp_base_lots, perp_limit_ticks, spot_quote_limit_atoms))
}

fn execute_spot<'info>(
    ctx: &Context<'info, ExecuteCashAndCarry<'info>>,
    quantity_atoms: u64,
    quote_limit_atoms: u64,
    sqrt_price_limit: u128,
    a_to_b: bool,
    exact_input: bool,
) -> Result<()> {
    let cpi_accounts = naryx_orca_adapter::cpi::accounts::SwapOrca {
        token_authority: ctx.accounts.trader.to_account_info(),
        token_owner_account_a: ctx.accounts.spot.trader_token_a.to_account_info(),
        token_owner_account_b: ctx.accounts.spot.trader_token_b.to_account_info(),
        token_vault_a: ctx.accounts.spot.spot_vault_a.to_account_info(),
        token_vault_b: ctx.accounts.spot.spot_vault_b.to_account_info(),
        whirlpool: ctx.accounts.spot.whirlpool.to_account_info(),
        tick_array_0: ctx.accounts.spot.tick_array_0.to_account_info(),
        tick_array_1: ctx.accounts.spot.tick_array_1.to_account_info(),
        tick_array_2: ctx.accounts.spot.tick_array_2.to_account_info(),
        oracle: ctx.accounts.spot.whirlpool_oracle.to_account_info(),
        token_program: ctx.accounts.runtime.token_program.to_account_info(),
        whirlpool_program: ctx.accounts.programs.spot_venue_program.to_account_info(),
    };
    let cpi = CpiContext::new(
        ctx.accounts.programs.spot_adapter_program.key(),
        cpi_accounts,
    );
    if exact_input {
        naryx_orca_adapter::cpi::swap_exact_input(
            cpi,
            quantity_atoms,
            quote_limit_atoms,
            sqrt_price_limit,
            a_to_b,
        )
    } else {
        naryx_orca_adapter::cpi::swap_exact_output(
            cpi,
            quantity_atoms,
            quote_limit_atoms,
            sqrt_price_limit,
            a_to_b,
        )
    }
}

fn execute_rise<'info>(
    ctx: &Context<'info, ExecuteCashAndCarry<'info>>,
    args: RiseMarketOrderArgs,
    entry: bool,
) -> Result<()> {
    let cpi_accounts = naryx_rise_adapter::cpi::accounts::ExecuteRiseOrder {
        strategy: ctx.accounts.rise_strategy.to_account_info(),
        controller: ctx.accounts.executor_authority.to_account_info(),
        phoenix_program: ctx.accounts.programs.perp_venue_program.to_account_info(),
        log_authority: ctx.accounts.rise.rise_log_authority.to_account_info(),
        global_config: ctx.accounts.rise.rise_global_config.to_account_info(),
        permission_account: ctx.accounts.rise_strategy.to_account_info(),
        trader_account: ctx.accounts.rise.rise_trader_account.to_account_info(),
        perp_asset_map: ctx.accounts.rise.rise_perp_asset_map.to_account_info(),
        global_trader_index_header: ctx
            .accounts
            .rise
            .rise_global_trader_index_header
            .to_account_info(),
        active_trader_buffer_header: ctx
            .accounts
            .rise
            .rise_active_trader_buffer_header
            .to_account_info(),
        orderbook: ctx.accounts.rise.rise_orderbook.to_account_info(),
        spline_collection: ctx.accounts.rise.rise_spline_collection.to_account_info(),
    };
    let bump = [ctx.bumps.executor_authority];
    let signer_seeds: &[&[u8]] = &[
        CASH_CARRY_EXECUTOR_SEED,
        ctx.accounts.trader.key.as_ref(),
        ctx.accounts.rise_strategy.to_account_info().key.as_ref(),
        bump.as_ref(),
    ];
    let signer_seed_groups = [signer_seeds];
    let cpi = CpiContext::new_with_signer(
        ctx.accounts.programs.perp_adapter_program.key(),
        cpi_accounts,
        &signer_seed_groups,
    )
    .with_remaining_accounts(ctx.remaining_accounts.to_vec());
    if entry {
        naryx_rise_adapter::cpi::rise_enter_short(cpi, args)
    } else {
        naryx_rise_adapter::cpi::rise_close_short(cpi, args)
    }
}

#[allow(clippy::too_many_arguments)]
fn enforce_postconditions(
    args: &CashCarryExecutionArgs,
    pre_base: u64,
    post_base: u64,
    pre_quote: u64,
    post_quote: u64,
    pre_rise: i64,
    post_rise: i64,
    post_collateral: i64,
    perp_base_lots: u64,
    spot_quote_limit_atoms: u64,
) -> Result<u64> {
    require!(
        post_collateral >= args.minimum_rise_collateral_quote_lots,
        ErrorCode::CashCarryCollateralBelowFloor
    );
    let exact_short = i64::try_from(perp_base_lots)
        .map_err(|_| error!(ErrorCode::CashCarryArithmeticOverflow))?;
    match args.action {
        CashCarryAction::Entry => {
            require!(
                pre_base.checked_add(args.spot_quantity_atoms) == Some(post_base)
                    && pre_rise == 0
                    && post_rise == -exact_short,
                ErrorCode::CashCarryPostconditionFailed
            );
            let quote_delta = pre_quote
                .checked_sub(post_quote)
                .ok_or_else(|| error!(ErrorCode::CashCarryPostconditionFailed))?;
            require!(
                quote_delta <= spot_quote_limit_atoms,
                ErrorCode::CashCarryPostconditionFailed
            );
            Ok(quote_delta)
        }
        CashCarryAction::Exit => {
            require!(
                pre_base.checked_sub(args.spot_quantity_atoms) == Some(post_base)
                    && pre_rise == -exact_short
                    && post_rise == 0,
                ErrorCode::CashCarryPostconditionFailed
            );
            let quote_delta = post_quote
                .checked_sub(pre_quote)
                .ok_or_else(|| error!(ErrorCode::CashCarryPostconditionFailed))?;
            require!(
                quote_delta >= spot_quote_limit_atoms,
                ErrorCode::CashCarryPostconditionFailed
            );
            Ok(quote_delta)
        }
    }
}

fn require_solver_signature(
    instructions_sysvar: &AccountInfo,
    solver: &Pubkey,
    digest: &[u8; 32],
) -> Result<()> {
    let index = load_current_index_checked(instructions_sysvar)
        .map_err(|_| error!(ErrorCode::CashCarrySignatureInstructionInvalid))?;
    require!(index > 0, ErrorCode::CashCarrySignatureInstructionInvalid);
    let instruction = load_instruction_at_checked((index - 1) as usize, instructions_sysvar)
        .map_err(|_| error!(ErrorCode::CashCarrySignatureInstructionInvalid))?;
    require_keys_eq!(
        instruction.program_id,
        ed25519_program::id(),
        ErrorCode::CashCarrySignatureInstructionInvalid
    );
    require!(
        instruction.accounts.is_empty(),
        ErrorCode::CashCarrySignatureInstructionInvalid
    );
    let data = instruction.data;
    require!(
        data.len() == 144 && data[0] == 1 && data[1] == 0,
        ErrorCode::CashCarrySignatureInstructionInvalid
    );
    let field = |offset: usize| u16::from_le_bytes([data[offset], data[offset + 1]]);
    require!(
        field(2) == 48
            && field(4) == u16::MAX
            && field(6) == 16
            && field(8) == u16::MAX
            && field(10) == 112
            && field(12) == 32
            && field(14) == u16::MAX,
        ErrorCode::CashCarrySignatureInstructionInvalid
    );
    require!(
        &data[16..48] == solver.as_ref() && &data[112..144] == digest,
        ErrorCode::CashCarrySignatureMismatch
    );
    Ok(())
}

fn resource_record_keys(accounts: &ExecuteCashAndCarry) -> [Pubkey; 8] {
    [
        accounts.resources.spot_adapter_record.key(),
        accounts.resources.perp_adapter_record.key(),
        accounts.resources.spot_market_record.key(),
        accounts.resources.perp_market_record.key(),
        accounts.resources.spot_venue_record.key(),
        accounts.resources.perp_venue_record.key(),
        accounts.resources.base_asset_record.key(),
        accounts.resources.quote_asset_record.key(),
    ]
}

fn resource_admission_commitment(
    admission: &CashCarryAdmission,
    record_keys: &[Pubkey; 8],
) -> [u8; 32] {
    let mut data = admission.domain.canonical_bytes();
    for identity in [
        &admission.spot_adapter,
        &admission.perp_adapter,
        &admission.spot_market,
        &admission.perp_market,
        &admission.spot_venue,
        &admission.perp_venue,
        &admission.base_asset,
        &admission.quote_asset,
    ] {
        append_manifest_ref(&mut data, identity);
    }
    append_string(&mut data, admission.template.id.as_str());
    data.extend_from_slice(&admission.template.version.to_be_bytes());
    data.extend_from_slice(&admission.template.manifest_hash);
    data.push(match admission.settlement.class {
        SettlementClass::AtomicPostcondition => 1,
    });
    data.extend_from_slice(&admission.settlement.version.to_be_bytes());
    data.extend_from_slice(&admission.settlement.manifest_hash);
    data.push(admission.quote_decimals);
    for key in record_keys {
        data.extend_from_slice(key.as_ref());
    }
    hashv(&[RESOURCE_COMMITMENT_DOMAIN, &data]).to_bytes()
}

fn append_manifest_ref(data: &mut Vec<u8>, identity: &ManifestRef) {
    data.extend_from_slice(&identity.subject_id);
    data.extend_from_slice(&identity.manifest_version.to_be_bytes());
    data.extend_from_slice(&identity.manifest_hash);
}

fn append_string(data: &mut Vec<u8>, value: &str) {
    data.extend_from_slice(&(value.len() as u32).to_be_bytes());
    data.extend_from_slice(value.as_bytes());
}

fn route_accounts_commitment(
    accounts: &ExecuteCashAndCarry,
    remaining: &[AccountInfo],
) -> [u8; 32] {
    let mut keys = vec![
        accounts.spot.trader_token_a.key(),
        accounts.spot.trader_token_b.key(),
        accounts.spot.spot_vault_a.key(),
        accounts.spot.spot_vault_b.key(),
        accounts.spot.whirlpool.key(),
        accounts.spot.tick_array_0.key(),
        accounts.spot.tick_array_1.key(),
        accounts.spot.tick_array_2.key(),
        accounts.spot.whirlpool_oracle.key(),
        accounts.rise_strategy.key(),
        accounts.rise.rise_log_authority.key(),
        accounts.rise.rise_global_config.key(),
        accounts.rise.rise_trader_account.key(),
        accounts.rise.rise_perp_asset_map.key(),
        accounts.rise.rise_global_trader_index_header.key(),
        accounts.rise.rise_active_trader_buffer_header.key(),
        accounts.rise.rise_orderbook.key(),
        accounts.rise.rise_spline_collection.key(),
    ];
    keys.extend(remaining.iter().map(AccountInfo::key));
    hash_pubkeys(ROUTE_ACCOUNTS_DOMAIN, &keys)
}

fn package_accounts_commitment(accounts: &ExecuteCashAndCarry) -> [u8; 32] {
    hash_pubkeys(
        PACKAGE_ACCOUNTS_DOMAIN,
        &[
            accounts.spot.trader_token_a.key(),
            accounts.spot.trader_token_b.key(),
            accounts.rise_strategy.key(),
        ],
    )
}

fn execution_account_keys(
    accounts: &ExecuteCashAndCarry,
    remaining: &[AccountInfo],
    solver: Pubkey,
) -> Vec<Pubkey> {
    let mut keys = vec![
        crate::id(),
        accounts.trader.key(),
        accounts.config.key(),
        accounts.solver_registry.key(),
        solver,
        accounts.receipt.key(),
        accounts.nonce_marker.key(),
        accounts.open_package.key(),
        accounts.entry_receipt.key(),
        accounts.executor_authority.key(),
        accounts.resources.spot_adapter_index.key(),
        accounts.resources.perp_adapter_index.key(),
        accounts.resources.spot_market_index.key(),
        accounts.resources.perp_market_index.key(),
        accounts.resources.spot_venue_index.key(),
        accounts.resources.perp_venue_index.key(),
        accounts.resources.base_asset_index.key(),
        accounts.resources.quote_asset_index.key(),
    ];
    keys.extend_from_slice(&resource_record_keys(accounts));
    keys.extend_from_slice(&[
        accounts.programs.spot_adapter_program.key(),
        accounts.programs.spot_adapter_program_data.key(),
        accounts.programs.perp_adapter_program.key(),
        accounts.programs.perp_adapter_program_data.key(),
        accounts.programs.spot_venue_program.key(),
        accounts.programs.spot_venue_program_data.key(),
        accounts.programs.perp_venue_program.key(),
        accounts.programs.perp_venue_program_data.key(),
        accounts.spot.trader_token_a.key(),
        accounts.spot.trader_token_b.key(),
        accounts.spot.spot_vault_a.key(),
        accounts.spot.spot_vault_b.key(),
        accounts.spot.whirlpool.key(),
        accounts.spot.tick_array_0.key(),
        accounts.spot.tick_array_1.key(),
        accounts.spot.tick_array_2.key(),
        accounts.spot.whirlpool_oracle.key(),
        accounts.rise_strategy.key(),
        accounts.rise.rise_log_authority.key(),
        accounts.rise.rise_global_config.key(),
        accounts.rise.rise_trader_account.key(),
        accounts.rise.rise_perp_asset_map.key(),
        accounts.rise.rise_global_trader_index_header.key(),
        accounts.rise.rise_active_trader_buffer_header.key(),
        accounts.rise.rise_orderbook.key(),
        accounts.rise.rise_spline_collection.key(),
        accounts.runtime.token_program.key(),
        accounts.system_program.key(),
        accounts.runtime.instructions_sysvar.key(),
    ]);
    keys.extend(remaining.iter().map(AccountInfo::key));
    keys
}

fn hash_pubkeys(domain: &[u8], keys: &[Pubkey]) -> [u8; 32] {
    let mut data = Vec::with_capacity(4 + keys.len() * 32);
    data.extend_from_slice(&(keys.len() as u32).to_be_bytes());
    for key in keys {
        data.extend_from_slice(key.as_ref());
    }
    hashv(&[domain, &data]).to_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{DescriptorRef, SettlementRef};

    fn manifest(byte: u8) -> ManifestRef {
        ManifestRef {
            subject_id: [byte; 32],
            manifest_version: 1,
            manifest_hash: [byte.wrapping_add(1); 32],
        }
    }

    fn admission() -> CashCarryAdmission {
        CashCarryAdmission {
            domain: DomainRef::new("solana:test", 1, [1; 32]).unwrap(),
            spot_adapter: manifest(2),
            perp_adapter: manifest(3),
            spot_market: manifest(4),
            perp_market: manifest(5),
            spot_venue: manifest(6),
            perp_venue: manifest(7),
            base_asset: manifest(8),
            quote_asset: manifest(9),
            quote_decimals: 6,
            template: DescriptorRef::new("cash-and-carry-v1", 1, [10; 32]).unwrap(),
            settlement: SettlementRef {
                class: SettlementClass::AtomicPostcondition,
                version: 1,
                manifest_hash: [11; 32],
            },
            action: ResourceAction::Entry,
            spot_quantity_atoms: 100,
            perp_quantity_atoms: 10,
            spot_limit_quote_atoms_per_base_lot: 200,
            perp_limit_quote_atoms_per_base_lot: 300,
            package_notional_atoms: 3_000,
        }
    }

    #[test]
    fn digest_binds_limits_and_account_order() {
        let admission = admission();
        let args = CashCarryExecutionArgs {
            action: CashCarryAction::Entry,
            spot_quantity_atoms: admission.spot_quantity_atoms,
            perp_quantity_atoms: admission.perp_quantity_atoms,
            spot_limit_quote_atoms_per_base_lot: admission.spot_limit_quote_atoms_per_base_lot,
            perp_limit_quote_atoms_per_base_lot: admission.perp_limit_quote_atoms_per_base_lot,
            package_notional_atoms: admission.package_notional_atoms,
            spot_sqrt_price_limit: 12,
            minimum_rise_collateral_quote_lots: 13,
            client_order_id: 14,
            expiry_slot: 15,
            nonce: 16,
        };
        let keys = [Pubkey::new_unique(), Pubkey::new_unique()];
        let resource = [17; 32];
        let digest = execution_digest(
            &admission.domain,
            [18; 32],
            [19; 32],
            [20; 32],
            &args,
            resource,
            &keys,
        );
        let mut changed = args.clone();
        changed.perp_limit_quote_atoms_per_base_lot += 1;
        assert_ne!(
            digest,
            execution_digest(
                &admission.domain,
                [18; 32],
                [19; 32],
                [20; 32],
                &changed,
                resource,
                &keys,
            )
        );
        assert_ne!(
            digest,
            execution_digest(
                &admission.domain,
                [18; 32],
                [19; 32],
                [20; 32],
                &args,
                resource,
                &[keys[1], keys[0]],
            )
        );
    }

    #[test]
    fn postconditions_enforce_exact_spot_and_rise_deltas() {
        let args = CashCarryExecutionArgs {
            action: CashCarryAction::Entry,
            spot_quantity_atoms: 100,
            perp_quantity_atoms: 10,
            spot_limit_quote_atoms_per_base_lot: 200,
            perp_limit_quote_atoms_per_base_lot: 300,
            package_notional_atoms: 3_000,
            spot_sqrt_price_limit: 1,
            minimum_rise_collateral_quote_lots: 5,
            client_order_id: 1,
            expiry_slot: 2,
            nonce: 1,
        };
        assert_eq!(
            enforce_postconditions(&args, 10, 110, 1_000, 850, 0, -10, 5, 10, 200).unwrap(),
            150
        );
        assert!(enforce_postconditions(&args, 10, 109, 1_000, 850, 0, -10, 5, 10, 200).is_err());
        let mut exit = args;
        exit.action = CashCarryAction::Exit;
        assert_eq!(
            enforce_postconditions(&exit, 110, 10, 850, 1_050, -10, 0, 5, 10, 200).unwrap(),
            200
        );
    }

    #[test]
    fn expiry_is_strict() {
        assert!(validate_expiry(9, 10).is_ok());
        assert!(validate_expiry(10, 10).is_err());
    }
}

use anchor_lang::{
    prelude::*,
    solana_program::{
        bpf_loader_upgradeable::get_program_data_address,
        instruction::{AccountMeta, Instruction},
        program::{get_return_data, invoke_signed},
    },
};
use anchor_spl::token::{Token, TokenAccount};
use naryx_orca_adapter::{program::NaryxOrcaAdapter, ORCA_WHIRLPOOL_PROGRAM_ID};
use naryx_rise_adapter::{
    program::NaryxRiseAdapter, read_position_and_collateral, RiseMarketOrderArgs, RiseStrategy,
    RISE_GLOBAL_CONFIG, RISE_LOG_AUTHORITY, RISE_PROGRAM_ID,
};
use solana_instructions_sysvar::{load_current_index_checked, load_instruction_at_checked};
use solana_sdk_ids::{bpf_loader_upgradeable, ed25519_program};
use solana_sha256_hasher::hashv;

use crate::{
    constants::{
        CASH_CARRY_EXECUTOR_SEED, CASH_CARRY_NONCE_SEED, CASH_CARRY_OPEN_SEED,
        CASH_CARRY_RECEIPT_SEED, PACKAGE_BOOK_CLASS_SEED, PACKAGE_BOOK_PROGRAM_ID,
        PACKAGE_QUOTE_LEVEL_PAGE_SEED, PACKAGE_QUOTE_SHARD_SEED, PROTOCOL_CONFIG_SEED,
        SOLVER_REGISTRY_SEED,
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
const QUOTE_INTENT_DOMAIN: &[u8] = b"NARYX/cash-carry-quote-intent/v1";
const QUOTED_EXECUTION_DIGEST_DOMAIN: &[u8] = b"NARYX/quoted-cash-carry-execution/v1";
const PACKAGE_BOOK_DOMAIN_REF_IDENTITY_DOMAIN: &[u8] = b"CON/v1/domain-ref-identity";
const PACKAGE_BOOK_CONSUME_CAPACITY_DISCRIMINATOR: [u8; 8] =
    [0x93, 0x38, 0x6b, 0x07, 0x4f, 0x8a, 0xcd, 0xb0];
const PACKAGE_BOOK_QUOTE_MODE_EXECUTION_COMMITMENT: u8 = 1;
const PACKAGE_BOOK_ACCOUNT_COUNT: usize = 7;
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
    pub recovery: bool,
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

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct CashCarryQuoteArgs {
    pub package_book_code_identity: [u8; 32],
    pub series_manifest_hash: [u8; 32],
    pub execution_class_manifest_hash: [u8; 32],
    pub expected_reference_sequence: u64,
    pub expected_shard_sequence: u64,
    pub slot_index: u8,
    pub level_id: u64,
    pub expected_level_sequence: u64,
    pub package_size_units: u64,
    pub expected_package_price: i128,
    pub expected_max_fee_atoms: u64,
    pub expected_expiry_slot: u64,
    pub expected_settlement_class_identity_hash: [u8; 32],
    pub expected_quote_mode: u8,
    pub expected_reservation_policy_hash: [u8; 32],
    pub reservation_id: [u8; 32],
    pub expected_fill_commitment: [u8; 32],
}

#[derive(AnchorSerialize, Clone, Copy)]
struct PackageBookConsumeCapacityArgs {
    expected_reference_sequence: u64,
    expected_shard_sequence: u64,
    slot_index: u8,
    level_id: u64,
    expected_level_sequence: u64,
    package_size_units: u64,
    expected_package_price: i128,
    expected_max_fee_atoms: u64,
    expected_expiry_slot: u64,
    expected_settlement_class_identity_hash: [u8; 32],
    expected_quote_mode: u8,
    expected_reservation_policy_hash: [u8; 32],
    reservation_id: [u8; 32],
    order_hash: [u8; 32],
    quote_hash: [u8; 32],
    route_hash: [u8; 32],
}

#[derive(Clone, Copy)]
struct QuoteEvidence {
    intent_commitment: [u8; 32],
    fill_commitment: [u8; 32],
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
    data.push(u8::from(args.recovery));
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

#[allow(clippy::too_many_arguments)]
fn quoted_execution_digest(
    domain: &DomainRef,
    order_hash: [u8; 32],
    quote_hash: [u8; 32],
    route_hash: [u8; 32],
    args: &CashCarryExecutionArgs,
    resource_admission_commitment: [u8; 32],
    account_keys: &[Pubkey],
    quote_evidence: QuoteEvidence,
) -> [u8; 32] {
    let base = execution_digest(
        domain,
        order_hash,
        quote_hash,
        route_hash,
        args,
        resource_admission_commitment,
        account_keys,
    );
    hashv(&[
        QUOTED_EXECUTION_DIGEST_DOMAIN,
        &base,
        &quote_evidence.intent_commitment,
        &quote_evidence.fill_commitment,
    ])
    .to_bytes()
}

#[allow(clippy::too_many_arguments)]
fn quote_intent_commitment(
    domain: &DomainRef,
    solver: &Pubkey,
    consumer_authority: &Pubkey,
    order_hash: [u8; 32],
    quote_hash: [u8; 32],
    route_hash: [u8; 32],
    args: &CashCarryQuoteArgs,
    quote_account_keys: &[Pubkey],
) -> [u8; 32] {
    let mut data = Vec::with_capacity(512);
    data.extend_from_slice(&domain.canonical_bytes());
    data.extend_from_slice(solver.as_ref());
    data.extend_from_slice(consumer_authority.as_ref());
    data.extend_from_slice(&order_hash);
    data.extend_from_slice(&quote_hash);
    data.extend_from_slice(&route_hash);
    data.extend_from_slice(&args.package_book_code_identity);
    data.extend_from_slice(&args.series_manifest_hash);
    data.extend_from_slice(&args.execution_class_manifest_hash);
    data.extend_from_slice(&args.expected_reference_sequence.to_be_bytes());
    data.extend_from_slice(&args.expected_shard_sequence.to_be_bytes());
    data.push(args.slot_index);
    data.extend_from_slice(&args.level_id.to_be_bytes());
    data.extend_from_slice(&args.expected_level_sequence.to_be_bytes());
    data.extend_from_slice(&args.package_size_units.to_be_bytes());
    data.extend_from_slice(&args.expected_package_price.to_be_bytes());
    data.extend_from_slice(&args.expected_max_fee_atoms.to_be_bytes());
    data.extend_from_slice(&args.expected_expiry_slot.to_be_bytes());
    data.extend_from_slice(&args.expected_settlement_class_identity_hash);
    data.push(args.expected_quote_mode);
    data.extend_from_slice(&args.expected_reservation_policy_hash);
    data.extend_from_slice(&args.reservation_id);
    data.extend_from_slice(&args.expected_fill_commitment);
    data.extend_from_slice(&(quote_account_keys.len() as u32).to_be_bytes());
    for key in quote_account_keys {
        data.extend_from_slice(key.as_ref());
    }
    hashv(&[QUOTE_INTENT_DOMAIN, &data]).to_bytes()
}

fn encode_consume_capacity_instruction(
    order_hash: [u8; 32],
    quote_hash: [u8; 32],
    route_hash: [u8; 32],
    args: &CashCarryQuoteArgs,
) -> Result<Vec<u8>> {
    let wire = PackageBookConsumeCapacityArgs {
        expected_reference_sequence: args.expected_reference_sequence,
        expected_shard_sequence: args.expected_shard_sequence,
        slot_index: args.slot_index,
        level_id: args.level_id,
        expected_level_sequence: args.expected_level_sequence,
        package_size_units: args.package_size_units,
        expected_package_price: args.expected_package_price,
        expected_max_fee_atoms: args.expected_max_fee_atoms,
        expected_expiry_slot: args.expected_expiry_slot,
        expected_settlement_class_identity_hash: args.expected_settlement_class_identity_hash,
        expected_quote_mode: args.expected_quote_mode,
        expected_reservation_policy_hash: args.expected_reservation_policy_hash,
        reservation_id: args.reservation_id,
        order_hash,
        quote_hash,
        route_hash,
    };
    let mut data = Vec::with_capacity(305);
    data.extend_from_slice(&PACKAGE_BOOK_CONSUME_CAPACITY_DISCRIMINATOR);
    wire.serialize(&mut data)?;
    Ok(data)
}

pub(crate) fn handler<'info>(
    ctx: Context<'info, ExecuteCashAndCarry<'info>>,
    order_hash: [u8; HASH_BYTE_LENGTH],
    quote_hash: [u8; HASH_BYTE_LENGTH],
    route_hash: [u8; HASH_BYTE_LENGTH],
    args: CashCarryExecutionArgs,
) -> Result<()> {
    execute(ctx, order_hash, quote_hash, route_hash, args, None)
}

pub(crate) fn quoted_handler<'info>(
    ctx: Context<'info, ExecuteCashAndCarry<'info>>,
    order_hash: [u8; HASH_BYTE_LENGTH],
    quote_hash: [u8; HASH_BYTE_LENGTH],
    route_hash: [u8; HASH_BYTE_LENGTH],
    args: CashCarryExecutionArgs,
    quote_args: CashCarryQuoteArgs,
) -> Result<()> {
    execute(
        ctx,
        order_hash,
        quote_hash,
        route_hash,
        args,
        Some(quote_args),
    )
}

fn execute<'info>(
    ctx: Context<'info, ExecuteCashAndCarry<'info>>,
    order_hash: [u8; HASH_BYTE_LENGTH],
    quote_hash: [u8; HASH_BYTE_LENGTH],
    route_hash: [u8; HASH_BYTE_LENGTH],
    args: CashCarryExecutionArgs,
    quote_args: Option<CashCarryQuoteArgs>,
) -> Result<()> {
    validate_basic_inputs(order_hash, quote_hash, route_hash, &args)?;
    if let Some(quote) = &quote_args {
        validate_quote_parameters(&args, quote)?;
        require!(
            ctx.remaining_accounts.len() >= PACKAGE_BOOK_ACCOUNT_COUNT,
            ErrorCode::CashCarryQuoteAccountMismatch
        );
    }
    let execution_slot = Clock::get()?.slot;
    validate_expiry(execution_slot, args.expiry_slot)?;
    if args.action == CashCarryAction::Entry {
        require!(
            !ctx.accounts.config.entry_paused,
            ErrorCode::CashCarryEntryPaused
        );
    }
    let execution_domain = select_execution_domain(
        args.action,
        &ctx.accounts.config.domain,
        ctx.accounts.open_package.version,
        ctx.accounts.open_package.trader,
        ctx.accounts.trader.key(),
        &ctx.accounts.open_package.domain,
    )?;
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
    let admission = reconstruct_admission(&ctx.accounts, &args, execution_domain.clone())?;
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
            validate_cash_carry_exit_admission(&execution_domain, &admission, &resources)?;
            validate_resource_indices(&ctx.accounts, false)?;
        }
    }
    validate_live_resource_accounts(&ctx.accounts)?;

    let solver = execution_solver(
        args.action,
        args.recovery,
        ctx.accounts.solver_registry.active,
    )?;
    let quote_evidence = if let Some(quote) = &quote_args {
        prepare_quote_evidence(
            &ctx.accounts,
            ctx.remaining_accounts,
            &execution_domain,
            solver,
            order_hash,
            quote_hash,
            route_hash,
            quote,
        )?
    } else {
        QuoteEvidence {
            intent_commitment: [0u8; 32],
            fill_commitment: [0u8; 32],
        }
    };
    let account_keys = execution_account_keys(&ctx.accounts, ctx.remaining_accounts, solver);
    let digest = if quote_args.is_some() {
        quoted_execution_digest(
            &execution_domain,
            order_hash,
            quote_hash,
            route_hash,
            &args,
            resource_admission_commitment,
            &account_keys,
            quote_evidence,
        )
    } else {
        execution_digest(
            &execution_domain,
            order_hash,
            quote_hash,
            route_hash,
            &args,
            resource_admission_commitment,
            &account_keys,
        )
    };
    if !args.recovery {
        require_solver_signature(&ctx.accounts.runtime.instructions_sysvar, &solver, &digest)?;
    }

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

    if let Some(quote) = &quote_args {
        consume_package_quote(
            &ctx.accounts,
            ctx.remaining_accounts,
            ctx.bumps.receipt,
            order_hash,
            quote_hash,
            route_hash,
            quote,
        )?;
    }

    let rise_remaining_start = if quote_args.is_some() {
        PACKAGE_BOOK_ACCOUNT_COUNT
    } else {
        0
    };

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
                &ctx.remaining_accounts[rise_remaining_start..],
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
                &ctx.remaining_accounts[rise_remaining_start..],
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
        domain: execution_domain.clone(),
        order_hash,
        quote_hash,
        route_hash,
        trader: ctx.accounts.trader.key(),
        solver,
        nonce: args.nonce,
        execution_digest: digest,
        quote_intent_commitment: quote_evidence.intent_commitment,
        package_fill_commitment: quote_evidence.fill_commitment,
        action: args.action.discriminant(),
        recovery: args.recovery,
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
            domain: execution_domain.clone(),
            trader: ctx.accounts.trader.key(),
            entry_receipt,
            entry_route_hash: route_hash,
            quote_intent_commitment: quote_evidence.intent_commitment,
            package_fill_commitment: quote_evidence.fill_commitment,
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
        domain: execution_domain,
        order_hash,
        quote_hash,
        route_hash,
        trader: ctx.accounts.trader.key(),
        solver,
        nonce: args.nonce,
        execution_digest: digest,
        quote_intent_commitment: quote_evidence.intent_commitment,
        package_fill_commitment: quote_evidence.fill_commitment,
        action: args.action.discriminant(),
        recovery: args.recovery,
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

fn validate_quote_parameters(
    execution: &CashCarryExecutionArgs,
    quote: &CashCarryQuoteArgs,
) -> Result<()> {
    require!(
        execution.action == CashCarryAction::Entry && !execution.recovery,
        ErrorCode::CashCarryQuoteActionInvalid
    );
    require!(
        quote.package_book_code_identity != [0u8; 32]
            && quote.series_manifest_hash != [0u8; 32]
            && quote.execution_class_manifest_hash != [0u8; 32]
            && quote.expected_settlement_class_identity_hash != [0u8; 32]
            && quote.expected_fill_commitment != [0u8; 32]
            && quote.expected_reference_sequence != 0
            && quote.expected_shard_sequence != 0
            && quote.level_id != 0
            && quote.expected_level_sequence != 0
            && quote.package_size_units != 0
            && quote.expected_expiry_slot != 0
            && quote.expected_expiry_slot <= execution.expiry_slot
            && quote.expected_quote_mode == PACKAGE_BOOK_QUOTE_MODE_EXECUTION_COMMITMENT
            && quote.expected_max_fee_atoms == 0
            && quote.expected_reservation_policy_hash == [0u8; 32]
            && quote.reservation_id == [0u8; 32],
        ErrorCode::CashCarryQuoteParameterInvalid
    );
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn prepare_quote_evidence(
    accounts: &ExecuteCashAndCarry,
    remaining: &[AccountInfo],
    domain: &DomainRef,
    solver: Pubkey,
    order_hash: [u8; 32],
    quote_hash: [u8; 32],
    route_hash: [u8; 32],
    quote: &CashCarryQuoteArgs,
) -> Result<QuoteEvidence> {
    let quote_accounts = &remaining[..PACKAGE_BOOK_ACCOUNT_COUNT];
    validate_package_book_accounts(accounts, quote_accounts, domain, solver, quote)?;
    let keys = quote_accounts
        .iter()
        .map(AccountInfo::key)
        .collect::<Vec<_>>();
    Ok(QuoteEvidence {
        intent_commitment: quote_intent_commitment(
            domain,
            &solver,
            &accounts.receipt.key(),
            order_hash,
            quote_hash,
            route_hash,
            quote,
            &keys,
        ),
        fill_commitment: quote.expected_fill_commitment,
    })
}

fn validate_package_book_accounts(
    accounts: &ExecuteCashAndCarry,
    quote_accounts: &[AccountInfo],
    domain: &DomainRef,
    solver: Pubkey,
    quote: &CashCarryQuoteArgs,
) -> Result<()> {
    let package_book_program = &quote_accounts[0];
    let package_book_program_data = &quote_accounts[1];
    let core_program = &quote_accounts[2];
    let core_program_data = &quote_accounts[3];
    let package_book_class = &quote_accounts[4];
    let shard = &quote_accounts[5];
    let level_page = &quote_accounts[6];

    require_keys_eq!(
        package_book_program.key(),
        PACKAGE_BOOK_PROGRAM_ID,
        ErrorCode::CashCarryQuoteAccountMismatch
    );
    require!(
        live_program_code_identity(package_book_program, package_book_program_data)?
            == quote.package_book_code_identity,
        ErrorCode::CashCarryQuoteCodeIdentityMismatch
    );
    require_keys_eq!(
        core_program.key(),
        crate::id(),
        ErrorCode::CashCarryQuoteAccountMismatch
    );
    live_program_code_identity(core_program, core_program_data)?;

    let (expected_class, expected_shard, expected_page) = expected_package_book_addresses(
        domain,
        solver,
        quote.series_manifest_hash,
        quote.execution_class_manifest_hash,
    );
    require_keys_eq!(
        package_book_class.key(),
        expected_class,
        ErrorCode::CashCarryQuoteAccountMismatch
    );
    require_keys_eq!(
        shard.key(),
        expected_shard,
        ErrorCode::CashCarryQuoteAccountMismatch
    );
    require_keys_eq!(
        level_page.key(),
        expected_page,
        ErrorCode::CashCarryQuoteAccountMismatch
    );
    require!(
        &accounts.config.domain == domain,
        ErrorCode::CashCarryQuoteAccountMismatch
    );
    Ok(())
}

fn expected_package_book_addresses(
    domain: &DomainRef,
    solver: Pubkey,
    series_manifest_hash: [u8; 32],
    execution_class_manifest_hash: [u8; 32],
) -> (Pubkey, Pubkey, Pubkey) {
    let domain_identity = hashv(&[
        PACKAGE_BOOK_DOMAIN_REF_IDENTITY_DOMAIN,
        &domain.canonical_bytes(),
    ])
    .to_bytes();
    let version = domain.domain_manifest_version().to_le_bytes();
    let manifest_hash = domain.domain_manifest_hash();
    let class = Pubkey::find_program_address(
        &[
            PACKAGE_BOOK_CLASS_SEED,
            domain_identity.as_ref(),
            version.as_ref(),
            manifest_hash.as_ref(),
        ],
        &PACKAGE_BOOK_PROGRAM_ID,
    )
    .0;
    let shard = Pubkey::find_program_address(
        &[
            PACKAGE_QUOTE_SHARD_SEED,
            class.as_ref(),
            solver.as_ref(),
            series_manifest_hash.as_ref(),
            execution_class_manifest_hash.as_ref(),
        ],
        &PACKAGE_BOOK_PROGRAM_ID,
    )
    .0;
    let page = Pubkey::find_program_address(
        &[PACKAGE_QUOTE_LEVEL_PAGE_SEED, shard.as_ref()],
        &PACKAGE_BOOK_PROGRAM_ID,
    )
    .0;
    (class, shard, page)
}

fn live_program_code_identity(
    program: &AccountInfo,
    program_data: &AccountInfo,
) -> Result<[u8; 32]> {
    require!(
        program.executable && program.owner == &bpf_loader_upgradeable::id(),
        ErrorCode::CashCarryQuoteAccountMismatch
    );
    require_keys_eq!(
        program_data.key(),
        get_program_data_address(program.key),
        ErrorCode::CashCarryQuoteCodeIdentityMismatch
    );
    require_keys_eq!(
        *program_data.owner,
        bpf_loader_upgradeable::id(),
        ErrorCode::CashCarryQuoteCodeIdentityMismatch
    );
    let data = program_data.try_borrow_data()?;
    require!(
        !data.is_empty(),
        ErrorCode::CashCarryQuoteCodeIdentityMismatch
    );
    Ok(hashv(&[data.as_ref()]).to_bytes())
}

fn consume_package_quote<'info>(
    accounts: &ExecuteCashAndCarry<'info>,
    remaining: &[AccountInfo<'info>],
    receipt_bump: u8,
    order_hash: [u8; 32],
    quote_hash: [u8; 32],
    route_hash: [u8; 32],
    quote: &CashCarryQuoteArgs,
) -> Result<()> {
    let quote_accounts = &remaining[..PACKAGE_BOOK_ACCOUNT_COUNT];
    let package_book_program = &quote_accounts[0];
    let core_program = &quote_accounts[2];
    let core_program_data = &quote_accounts[3];
    let package_book_class = &quote_accounts[4];
    let shard = &quote_accounts[5];
    let level_page = &quote_accounts[6];
    let instruction = Instruction {
        program_id: PACKAGE_BOOK_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new_readonly(accounts.receipt.key(), true),
            AccountMeta::new_readonly(core_program.key(), false),
            AccountMeta::new_readonly(core_program_data.key(), false),
            AccountMeta::new_readonly(accounts.config.key(), false),
            AccountMeta::new_readonly(core_program.key(), false),
            AccountMeta::new_readonly(core_program_data.key(), false),
            AccountMeta::new_readonly(package_book_class.key(), false),
            AccountMeta::new(shard.key(), false),
            AccountMeta::new(level_page.key(), false),
        ],
        data: encode_consume_capacity_instruction(order_hash, quote_hash, route_hash, quote)?,
    };
    let trader = accounts.trader.key();
    let bump = [receipt_bump];
    let signer: &[&[u8]] = &[
        CASH_CARRY_RECEIPT_SEED,
        trader.as_ref(),
        order_hash.as_ref(),
        bump.as_ref(),
    ];
    invoke_signed(
        &instruction,
        &[
            accounts.receipt.to_account_info(),
            core_program.clone(),
            core_program_data.clone(),
            accounts.config.to_account_info(),
            core_program.clone(),
            core_program_data.clone(),
            package_book_class.clone(),
            shard.clone(),
            level_page.clone(),
            package_book_program.clone(),
        ],
        &[signer],
    )?;
    let (return_program, return_bytes) =
        get_return_data().ok_or_else(|| error!(ErrorCode::CashCarryQuoteReturnDataInvalid))?;
    require_keys_eq!(
        return_program,
        PACKAGE_BOOK_PROGRAM_ID,
        ErrorCode::CashCarryQuoteReturnDataInvalid
    );
    require!(
        return_bytes.len() == 32
            && return_bytes.as_slice() == quote.expected_fill_commitment.as_ref(),
        ErrorCode::CashCarryQuoteReturnDataInvalid
    );
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
        !args.recovery || args.action == CashCarryAction::Exit,
        ErrorCode::CashCarryRecoveryInvalid
    );
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

fn select_execution_domain(
    action: CashCarryAction,
    active_domain: &DomainRef,
    open_version: u8,
    open_trader: Pubkey,
    trader: Pubkey,
    open_domain: &DomainRef,
) -> Result<DomainRef> {
    match action {
        CashCarryAction::Entry => Ok(active_domain.clone()),
        CashCarryAction::Exit => {
            require!(
                open_version == OPEN_PACKAGE_VERSION && open_trader == trader,
                ErrorCode::CashCarryPackageNotOpen
            );
            Ok(open_domain.clone())
        }
    }
}

fn execution_solver(
    action: CashCarryAction,
    recovery: bool,
    active_solver: Pubkey,
) -> Result<Pubkey> {
    if recovery {
        require!(
            action == CashCarryAction::Exit,
            ErrorCode::CashCarryRecoveryInvalid
        );
        Ok(Pubkey::default())
    } else {
        require_keys_neq!(
            active_solver,
            Pubkey::default(),
            ErrorCode::CashCarrySolverInvalid
        );
        Ok(active_solver)
    }
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
    domain: DomainRef,
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
        domain,
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
                open.trader == accounts.trader.key()
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
                    && !entry.recovery
                    && entry.domain == open.domain
                    && entry.trader == accounts.trader.key()
                    && entry.route_hash == open.entry_route_hash
                    && entry.quote_intent_commitment == open.quote_intent_commitment
                    && entry.package_fill_commitment == open.package_fill_commitment
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
    remaining_accounts: &[AccountInfo<'info>],
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
    .with_remaining_accounts(remaining_accounts.to_vec());
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

    fn quote_args() -> CashCarryQuoteArgs {
        CashCarryQuoteArgs {
            package_book_code_identity: [21; 32],
            series_manifest_hash: [22; 32],
            execution_class_manifest_hash: [23; 32],
            expected_reference_sequence: 24,
            expected_shard_sequence: 25,
            slot_index: 3,
            level_id: 26,
            expected_level_sequence: 27,
            package_size_units: 28,
            expected_package_price: -29,
            expected_max_fee_atoms: 0,
            expected_expiry_slot: 30,
            expected_settlement_class_identity_hash: [31; 32],
            expected_quote_mode: PACKAGE_BOOK_QUOTE_MODE_EXECUTION_COMMITMENT,
            expected_reservation_policy_hash: [0; 32],
            reservation_id: [0; 32],
            expected_fill_commitment: [32; 32],
        }
    }

    fn execution_args() -> CashCarryExecutionArgs {
        CashCarryExecutionArgs {
            action: CashCarryAction::Entry,
            recovery: false,
            spot_quantity_atoms: 100,
            perp_quantity_atoms: 10,
            spot_limit_quote_atoms_per_base_lot: 200,
            perp_limit_quote_atoms_per_base_lot: 300,
            package_notional_atoms: 3_000,
            spot_sqrt_price_limit: 12,
            minimum_rise_collateral_quote_lots: 13,
            client_order_id: 14,
            expiry_slot: 40,
            nonce: 16,
        }
    }

    #[test]
    fn package_book_consume_codec_has_exact_discriminator_and_field_order() {
        let quote = quote_args();
        let encoded =
            encode_consume_capacity_instruction([41; 32], [42; 32], [43; 32], &quote).unwrap();
        let mut expected = PACKAGE_BOOK_CONSUME_CAPACITY_DISCRIMINATOR.to_vec();
        expected.extend_from_slice(&quote.expected_reference_sequence.to_le_bytes());
        expected.extend_from_slice(&quote.expected_shard_sequence.to_le_bytes());
        expected.push(quote.slot_index);
        expected.extend_from_slice(&quote.level_id.to_le_bytes());
        expected.extend_from_slice(&quote.expected_level_sequence.to_le_bytes());
        expected.extend_from_slice(&quote.package_size_units.to_le_bytes());
        expected.extend_from_slice(&quote.expected_package_price.to_le_bytes());
        expected.extend_from_slice(&quote.expected_max_fee_atoms.to_le_bytes());
        expected.extend_from_slice(&quote.expected_expiry_slot.to_le_bytes());
        expected.extend_from_slice(&quote.expected_settlement_class_identity_hash);
        expected.push(quote.expected_quote_mode);
        expected.extend_from_slice(&quote.expected_reservation_policy_hash);
        expected.extend_from_slice(&quote.reservation_id);
        expected.extend_from_slice(&[41; 32]);
        expected.extend_from_slice(&[42; 32]);
        expected.extend_from_slice(&[43; 32]);
        assert_eq!(encoded, expected);
    }

    #[test]
    fn quoted_digest_binds_fill_and_intent_commitments() {
        let domain = DomainRef::new("solana:test", 1, [1; 32]).unwrap();
        let args = execution_args();
        let keys = [Pubkey::new_unique()];
        let evidence = QuoteEvidence {
            intent_commitment: [2; 32],
            fill_commitment: [3; 32],
        };
        let digest = quoted_execution_digest(
            &domain, [4; 32], [5; 32], [6; 32], &args, [7; 32], &keys, evidence,
        );
        let changed_fill = QuoteEvidence {
            fill_commitment: [8; 32],
            ..evidence
        };
        let changed_intent = QuoteEvidence {
            intent_commitment: [9; 32],
            ..evidence
        };
        assert_ne!(
            digest,
            quoted_execution_digest(
                &domain,
                [4; 32],
                [5; 32],
                [6; 32],
                &args,
                [7; 32],
                &keys,
                changed_fill,
            )
        );
        assert_ne!(
            digest,
            quoted_execution_digest(
                &domain,
                [4; 32],
                [5; 32],
                [6; 32],
                &args,
                [7; 32],
                &keys,
                changed_intent,
            )
        );
    }

    #[test]
    fn quoted_entry_rejects_firm_reservations_and_fees() {
        let execution = execution_args();
        let quote = quote_args();
        assert!(validate_quote_parameters(&execution, &quote).is_ok());
        let mut wrong = quote.clone();
        wrong.expected_quote_mode = 2;
        assert!(validate_quote_parameters(&execution, &wrong).is_err());
        wrong = quote.clone();
        wrong.reservation_id = [1; 32];
        assert!(validate_quote_parameters(&execution, &wrong).is_err());
        wrong = quote.clone();
        wrong.expected_reservation_policy_hash = [1; 32];
        assert!(validate_quote_parameters(&execution, &wrong).is_err());
        wrong = quote;
        wrong.expected_max_fee_atoms = 1;
        assert!(validate_quote_parameters(&execution, &wrong).is_err());
    }

    #[test]
    fn package_book_addresses_bind_domain_solver_and_manifest_hashes() {
        let domain = DomainRef::new("solana:test", 1, [1; 32]).unwrap();
        let solver = Pubkey::new_unique();
        let addresses = expected_package_book_addresses(&domain, solver, [2; 32], [3; 32]);
        let changed_domain = DomainRef::new("solana:test", 2, [4; 32]).unwrap();
        assert_ne!(
            addresses,
            expected_package_book_addresses(&changed_domain, solver, [2; 32], [3; 32])
        );
        assert_ne!(
            addresses,
            expected_package_book_addresses(&domain, Pubkey::new_unique(), [2; 32], [3; 32])
        );
        assert_ne!(
            addresses,
            expected_package_book_addresses(&domain, solver, [5; 32], [3; 32])
        );
        assert_ne!(
            addresses,
            expected_package_book_addresses(&domain, solver, [2; 32], [6; 32])
        );
    }

    #[test]
    fn digest_binds_limits_and_account_order() {
        let admission = admission();
        let args = CashCarryExecutionArgs {
            action: CashCarryAction::Entry,
            recovery: false,
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
        let mut normal_exit = args;
        normal_exit.action = CashCarryAction::Exit;
        let mut recovery = normal_exit.clone();
        recovery.recovery = true;
        assert_ne!(
            execution_digest(
                &admission.domain,
                [18; 32],
                [19; 32],
                [20; 32],
                &normal_exit,
                resource,
                &keys,
            ),
            execution_digest(
                &admission.domain,
                [18; 32],
                [19; 32],
                [20; 32],
                &recovery,
                resource,
                &keys,
            )
        );
    }

    #[test]
    fn postconditions_enforce_exact_spot_and_rise_deltas() {
        let args = CashCarryExecutionArgs {
            action: CashCarryAction::Entry,
            recovery: false,
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

    #[test]
    fn exit_uses_entry_domain_after_active_domain_rotation() {
        let active = DomainRef::new("solana:test", 2, [2; 32]).unwrap();
        let historical = DomainRef::new("solana:test", 1, [1; 32]).unwrap();
        let trader = Pubkey::new_unique();
        assert_eq!(
            select_execution_domain(
                CashCarryAction::Entry,
                &active,
                0,
                Pubkey::default(),
                trader,
                &historical,
            )
            .unwrap(),
            active
        );
        assert_eq!(
            select_execution_domain(
                CashCarryAction::Exit,
                &active,
                OPEN_PACKAGE_VERSION,
                trader,
                trader,
                &historical,
            )
            .unwrap(),
            historical
        );
        assert!(select_execution_domain(
            CashCarryAction::Exit,
            &active,
            OPEN_PACKAGE_VERSION,
            Pubkey::new_unique(),
            trader,
            &historical,
        )
        .is_err());
    }

    #[test]
    fn recovery_authorization_is_exit_only_and_solverless() {
        let active_solver = Pubkey::new_unique();
        assert_eq!(
            execution_solver(CashCarryAction::Entry, false, active_solver).unwrap(),
            active_solver
        );
        assert_eq!(
            execution_solver(CashCarryAction::Exit, true, Pubkey::default()).unwrap(),
            Pubkey::default()
        );
        assert!(execution_solver(CashCarryAction::Entry, true, active_solver).is_err());
        assert!(execution_solver(CashCarryAction::Exit, false, Pubkey::default()).is_err());
    }
}

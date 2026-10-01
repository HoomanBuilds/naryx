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
use solana_sdk_ids::bpf_loader_upgradeable;
use solana_sha256_hasher::hashv;

use crate::{
    constants::{
        CASH_CARRY_EXECUTOR_SEED, CASH_CARRY_NONCE_SEED, CASH_CARRY_OPEN_SEED,
        CASH_CARRY_RECEIPT_SEED, CASH_CARRY_SERIES_INDEX_SEED, CASH_CARRY_SERIES_RECORD_SEED,
        PACKAGE_BOOK_CLASS_SEED, PACKAGE_BOOK_PROGRAM_ID, PACKAGE_QUOTE_LEVEL_PAGE_SEED,
        PACKAGE_QUOTE_SHARD_SEED, PROTOCOL_CONFIG_SEED, SOLVER_REGISTRY_SEED,
    },
    error::ErrorCode,
    events::CashCarryExecutionRecorded,
    instructions::resource_registry::{
        validate_cash_carry_admission, validate_cash_carry_exit_admission, verify_code_identity,
        CashCarryAdmission, CashCarryResources, ResourceAction,
    },
    instructions::series_registry::validate_active_cash_carry_series_binding,
    instructions::{
        ed25519_signature::{
            signed_ed25519_public_key, verify_ed25519_signature, Ed25519SignatureError,
        },
        program_identity::program_data_header_identity,
    },
    perp_venue::{
        invoke_perp_order, perp_position_and_collateral, perp_venue_account_keys,
        validate_perp_accounts, CashCarryRiseAccounts, CashCarryRiseAccountsBumps,
        PerpAdapterProgram, PerpMarketOrderArgs, PerpOrderContext, PerpStrategy,
        __client_accounts_cash_carry_rise_accounts, __cpi_client_accounts_cash_carry_rise_accounts,
        PERP_VENUE_PROGRAM_ID,
    },
    state::{
        CashCarryExecutionReceipt, CashCarryNonce, CashCarrySeriesBindingIndex,
        CashCarrySeriesBindingRecord, CashCarrySeriesBindingV1, CashCarryStrategyAuthority,
        ManifestRef, OpenCashCarryPackage, ProtocolConfig, ResourceIndex, ResourceRecord,
        SettlementClass, SolverRegistry, CASH_CARRY_SERIES_ENTRY_SIDE_ASK, SPOT_ADAPTER_CLASS_ID,
    },
    wire::{DomainRef, HASH_BYTE_LENGTH},
};

const EXECUTION_DIGEST_DOMAIN: &[u8] = b"NARYX/cash-carry-execution/v1";
const RESOURCE_COMMITMENT_DOMAIN: &[u8] = b"NARYX/cash-carry-resources/v1";
const ECONOMIC_PACKAGE_COMMITMENT_DOMAIN: &[u8] = b"NARYX/cash-carry-economic-package/v1";
pub(crate) const ROUTE_ACCOUNTS_DOMAIN: &[u8] = b"NARYX/cash-carry-route-accounts/v1";
pub(crate) const PACKAGE_ACCOUNTS_DOMAIN: &[u8] = b"NARYX/cash-carry-package-accounts/v1";
const QUOTE_INTENT_DOMAIN: &[u8] = b"NARYX/cash-carry-quote-intent/v1";
const QUOTED_EXECUTION_DIGEST_DOMAIN: &[u8] = b"NARYX/quoted-cash-carry-execution/v1";
const PACKAGE_BOOK_DOMAIN_REF_IDENTITY_DOMAIN: &[u8] = b"CON/v1/domain-ref-identity";
const PACKAGE_BOOK_CONSUME_CAPACITY_DISCRIMINATOR: [u8; 8] =
    [0x93, 0x38, 0x6b, 0x07, 0x4f, 0x8a, 0xcd, 0xb0];
pub(crate) const PACKAGE_BOOK_QUOTE_MODE_EXECUTION_COMMITMENT: u8 = 1;
pub(crate) const PACKAGE_BOOK_QUOTE_MODE_FIRM_ONCHAIN: u8 = 2;
pub(crate) const PACKAGE_BOOK_QUOTE_SIDE_BID: u8 = 1;
pub(crate) const PACKAGE_BOOK_QUOTE_SIDE_ASK: u8 = 2;
pub(crate) const PACKAGE_BOOK_ACCOUNT_COUNT: usize = 7;
const SERIES_INDEX_ACCOUNT_INDEX: usize = PACKAGE_BOOK_ACCOUNT_COUNT;
const SERIES_RECORD_ACCOUNT_INDEX: usize = SERIES_INDEX_ACCOUNT_INDEX + 1;
pub(crate) const QUOTED_ENTRY_ACCOUNT_COUNT: usize = SERIES_RECORD_ACCOUNT_INDEX + 1;
pub(crate) const OPEN_PACKAGE_VERSION: u8 = 2;
pub const RISE_COLLATERAL_MUST_BE_PREFUNDED: bool = true;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum CashCarryAction {
    Entry,
    Exit,
}

impl CashCarryAction {
    pub(crate) fn discriminant(self) -> u8 {
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
    pub expected_side: u8,
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
    expected_side: u8,
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
pub(crate) struct QuoteEvidence {
    pub intent_commitment: [u8; 32],
    pub fill_commitment: [u8; 32],
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
    #[account(
        seeds = [CASH_CARRY_EXECUTOR_SEED, trader.key().as_ref(), rise_strategy.key().as_ref()],
        bump = executor_authority.bump,
        has_one = trader @ ErrorCode::CashCarryStrategyAuthorityInvalid,
        has_one = rise_strategy @ ErrorCode::CashCarryStrategyAuthorityInvalid
    )]
    pub executor_authority: Box<Account<'info, CashCarryStrategyAuthority>>,

    pub resources: CashCarryResourceAccounts<'info>,
    pub programs: CashCarryProgramAccounts<'info>,
    pub spot: CashCarrySpotAccounts<'info>,

    #[account(
        mut,
        constraint = rise_strategy.owner == trader.key() @ ErrorCode::CashCarryResourceAccountMismatch,
        constraint = rise_strategy.controller == executor_authority.key() @ ErrorCode::CashCarryResourceAccountMismatch
    )]
    pub rise_strategy: Box<Account<'info, PerpStrategy>>,
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
    pub perp_adapter_program: Program<'info, PerpAdapterProgram>,
    /// CHECK: Its deterministic address and bytes are verified against the admitted adapter record.
    pub perp_adapter_program_data: UncheckedAccount<'info>,
    /// CHECK: Fixed to Orca and verified against admitted venue records that reference its code.
    #[account(address = ORCA_WHIRLPOOL_PROGRAM_ID, executable)]
    pub spot_venue_program: UncheckedAccount<'info>,
    /// CHECK: Its deterministic address and bytes are verified against admitted venue records.
    pub spot_venue_program_data: UncheckedAccount<'info>,
    /// CHECK: Fixed to the perp venue and verified against admitted venue records that reference its code.
    #[account(address = PERP_VENUE_PROGRAM_ID, executable)]
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
pub(crate) fn quoted_execution_digest(
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
pub(crate) fn quote_intent_commitment(
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
    data.push(args.expected_side);
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

pub(crate) fn encode_consume_capacity_instruction(
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
        expected_side: args.expected_side,
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
    let mut data = Vec::with_capacity(306);
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
            ctx.remaining_accounts.len() >= QUOTED_ENTRY_ACCOUNT_COUNT,
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
    let admission =
        reconstruct_admission(&ctx.accounts.resources, &args, execution_domain.clone())?;
    validate_execution_authority(&ctx.accounts, &execution_domain)?;
    let resource_admission_commitment =
        resource_admission_commitment(&admission, &resource_record_keys(&ctx.accounts.resources));
    let economic_package_commitment = economic_package_commitment(
        &admission,
        &economic_resource_record_keys(&ctx.accounts.resources),
    );
    let route_accounts_commitment =
        route_accounts_commitment(&ctx.accounts, ctx.remaining_accounts);
    let package_accounts_commitment = package_accounts_commitment(&ctx.accounts)?;
    validate_package_lifecycle(
        &ctx.accounts,
        &args,
        economic_package_commitment,
        package_accounts_commitment,
    )?;
    match args.action {
        CashCarryAction::Entry => {
            validate_cash_carry_admission(&ctx.accounts.config, &admission, &resources)?;
            validate_resource_indices(&ctx.accounts.resources, true)?;
        }
        CashCarryAction::Exit => {
            validate_cash_carry_exit_admission(&execution_domain, &admission, &resources)?;
            validate_resource_indices(&ctx.accounts.resources, false)?;
        }
    }
    validate_live_resource_accounts(&ctx.accounts)?;

    // A solver-authorized execution names its solver through the Ed25519 verification instruction;
    // that key must be in the active set, and the digest checked below binds it.
    let signed_solver = if args.recovery {
        None
    } else {
        Some(signed_solver_key(
            &ctx.accounts.runtime.instructions_sysvar,
        )?)
    };
    let solver = execution_solver(
        args.action,
        args.recovery,
        &ctx.accounts.solver_registry,
        signed_solver,
    )?;
    let quote_evidence = if let Some(quote) = &quote_args {
        prepare_quote_evidence(
            &ctx.accounts,
            ctx.remaining_accounts,
            &execution_domain,
            &args,
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
    let (pre_rise_base_lots, pre_rise_collateral_quote_lots) =
        perp_position_and_collateral(&ctx.accounts.rise_strategy, &ctx.accounts.rise)?;
    let (perp_base_lots, perp_limit_ticks, spot_quote_limit_atoms) =
        execution_units(&admission, &ctx.accounts.resources)?;
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
        QUOTED_ENTRY_ACCOUNT_COUNT
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
                PerpMarketOrderArgs {
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
                PerpMarketOrderArgs {
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
    let (post_rise_base_lots, post_rise_collateral_quote_lots) =
        perp_position_and_collateral(&ctx.accounts.rise_strategy, &ctx.accounts.rise)?;
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
            entry_resource_admission_commitment: resource_admission_commitment,
            entry_route_accounts_commitment: route_accounts_commitment,
            economic_package_commitment,
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
            && quote.expected_side == PACKAGE_BOOK_QUOTE_SIDE_ASK
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
fn prepare_quote_evidence<'info>(
    accounts: &ExecuteCashAndCarry<'info>,
    remaining: &'info [AccountInfo<'info>],
    domain: &DomainRef,
    execution: &CashCarryExecutionArgs,
    solver: Pubkey,
    order_hash: [u8; 32],
    quote_hash: [u8; 32],
    route_hash: [u8; 32],
    quote: &CashCarryQuoteArgs,
) -> Result<QuoteEvidence> {
    let quote_accounts = &remaining[..QUOTED_ENTRY_ACCOUNT_COUNT];
    validate_package_book_accounts(
        &accounts.config,
        &quote_accounts[..PACKAGE_BOOK_ACCOUNT_COUNT],
        domain,
        solver,
        quote,
    )?;
    validate_quote_series_binding(
        &accounts.config,
        &accounts.resources,
        quote_accounts,
        execution,
        quote,
    )?;
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

pub(crate) fn validate_quote_series_binding<'info>(
    config: &ProtocolConfig,
    resources: &CashCarryResourceAccounts<'info>,
    quote_accounts: &'info [AccountInfo<'info>],
    execution: &CashCarryExecutionArgs,
    quote: &CashCarryQuoteArgs,
) -> Result<()> {
    let index = Account::<CashCarrySeriesBindingIndex>::try_from(
        &quote_accounts[SERIES_INDEX_ACCOUNT_INDEX],
    )?;
    let record = Account::<CashCarrySeriesBindingRecord>::try_from(
        &quote_accounts[SERIES_RECORD_ACCOUNT_INDEX],
    )?;
    validate_quote_series_binding_pair(config, resources, &index, &record, execution, quote)
}

pub(crate) fn validate_quote_series_binding_pair(
    config: &ProtocolConfig,
    resources: &CashCarryResourceAccounts,
    index: &Account<CashCarrySeriesBindingIndex>,
    record: &Account<CashCarrySeriesBindingRecord>,
    execution: &CashCarryExecutionArgs,
    quote: &CashCarryQuoteArgs,
) -> Result<()> {
    let identity_key = record.binding.identity_key();
    let expected_index = Pubkey::find_program_address(
        &[CASH_CARRY_SERIES_INDEX_SEED, identity_key.as_ref()],
        &crate::id(),
    )
    .0;
    let expected_record = Pubkey::find_program_address(
        &[
            CASH_CARRY_SERIES_RECORD_SEED,
            identity_key.as_ref(),
            record.binding.binding_version.to_be_bytes().as_ref(),
        ],
        &crate::id(),
    )
    .0;
    require_keys_eq!(
        index.key(),
        expected_index,
        ErrorCode::CashCarryQuoteAccountMismatch
    );
    require_keys_eq!(
        record.key(),
        expected_record,
        ErrorCode::CashCarryQuoteAccountMismatch
    );
    validate_active_cash_carry_series_binding(
        config,
        &index,
        record.key(),
        &record,
        identity_key,
        record.binding.binding_hash(),
        &resources.base_asset_index,
        resources.base_asset_record.key(),
        &resources.base_asset_record,
        &resources.quote_asset_index,
        resources.quote_asset_record.key(),
        &resources.quote_asset_record,
    )?;
    validate_quote_against_series(execution, quote, &record.binding)?;
    Ok(())
}

pub(crate) fn validate_quote_against_series(
    execution: &CashCarryExecutionArgs,
    quote: &CashCarryQuoteArgs,
    binding: &CashCarrySeriesBindingV1,
) -> Result<u64> {
    require!(
        quote.series_manifest_hash == binding.series_manifest_hash
            && quote.execution_class_manifest_hash == binding.execution_class_manifest_hash
            && quote.expected_settlement_class_identity_hash
                == binding.settlement_class_identity_hash,
        ErrorCode::CashCarryQuoteSeriesMismatch
    );
    // Entry lifts the series ask; a firm exit hits the solver's bid for the same package.
    let expected_side = match execution.action {
        CashCarryAction::Entry => PACKAGE_BOOK_QUOTE_SIDE_ASK,
        CashCarryAction::Exit => PACKAGE_BOOK_QUOTE_SIDE_BID,
    };
    require!(
        binding.entry_side == CASH_CARRY_SERIES_ENTRY_SIDE_ASK
            && quote.expected_side == expected_side,
        ErrorCode::CashCarryQuoteSideMismatch
    );
    let package_size_units = derive_package_size_units(execution, binding)?;
    require!(
        quote.package_size_units == package_size_units,
        ErrorCode::CashCarryQuotePackageUnitMismatch
    );
    Ok(package_size_units)
}

pub(crate) fn derive_package_size_units(
    execution: &CashCarryExecutionArgs,
    binding: &CashCarrySeriesBindingV1,
) -> Result<u64> {
    require!(
        binding.spot_base_atoms_per_package_unit != 0
            && binding.perp_quantity_atoms_per_package_unit != 0,
        ErrorCode::SeriesBindingUnitZero
    );
    let spot_quantity = u128::from(execution.spot_quantity_atoms);
    let perp_quantity = u128::from(execution.perp_quantity_atoms);
    require!(
        spot_quantity % binding.spot_base_atoms_per_package_unit == 0
            && perp_quantity % binding.perp_quantity_atoms_per_package_unit == 0,
        ErrorCode::CashCarryQuotePackageUnitMismatch
    );
    let spot_units = spot_quantity / binding.spot_base_atoms_per_package_unit;
    let perp_units = perp_quantity / binding.perp_quantity_atoms_per_package_unit;
    require!(
        spot_units != 0 && spot_units == perp_units,
        ErrorCode::CashCarryQuotePackageUnitMismatch
    );
    u64::try_from(spot_units).map_err(|_| error!(ErrorCode::CashCarryQuotePackageUnitMismatch))
}

pub(crate) fn validate_package_book_accounts(
    config: &ProtocolConfig,
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
        &config.domain == domain,
        ErrorCode::CashCarryQuoteAccountMismatch
    );
    Ok(())
}

pub(crate) fn expected_package_book_addresses(
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

pub(crate) fn live_program_code_identity(
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
    program_data_header_identity(program_data.try_borrow_data()?.as_ref())
        .ok_or_else(|| error!(ErrorCode::CashCarryQuoteCodeIdentityMismatch))
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

pub(crate) fn validate_basic_inputs(
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

pub(crate) fn validate_expiry(current_slot: u64, expiry_slot: u64) -> Result<()> {
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
    registry: &SolverRegistry,
    signed_solver: Option<Pubkey>,
) -> Result<Pubkey> {
    if recovery {
        require!(
            action == CashCarryAction::Exit,
            ErrorCode::CashCarryRecoveryInvalid
        );
        Ok(Pubkey::default())
    } else {
        let solver = signed_solver.ok_or_else(|| error!(ErrorCode::CashCarrySolverInvalid))?;
        require!(registry.is_active(&solver), ErrorCode::CashCarrySolverInvalid);
        Ok(solver)
    }
}

/// The solver key the preceding Ed25519 verification instruction names.
pub(crate) fn signed_solver_key(instructions_sysvar: &AccountInfo) -> Result<Pubkey> {
    signed_ed25519_public_key(instructions_sysvar)
        .map_err(|_| error!(ErrorCode::CashCarrySignatureInstructionInvalid))
}

pub(crate) fn validate_resource_indices(
    resources: &CashCarryResourceAccounts,
    require_current_active: bool,
) -> Result<()> {
    let pairs = [
        (
            &resources.spot_adapter_index,
            &resources.spot_adapter_record,
        ),
        (
            &resources.perp_adapter_index,
            &resources.perp_adapter_record,
        ),
        (&resources.spot_market_index, &resources.spot_market_record),
        (&resources.perp_market_index, &resources.perp_market_record),
        (&resources.spot_venue_index, &resources.spot_venue_record),
        (&resources.perp_venue_index, &resources.perp_venue_record),
        (&resources.base_asset_index, &resources.base_asset_record),
        (&resources.quote_asset_index, &resources.quote_asset_record),
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

pub(crate) fn reconstruct_admission(
    resources: &CashCarryResourceAccounts,
    args: &CashCarryExecutionArgs,
    domain: DomainRef,
) -> Result<CashCarryAdmission> {
    let template = resources
        .spot_adapter_record
        .manifest
        .allowed_template
        .clone()
        .ok_or_else(|| error!(ErrorCode::CashCarryResourceAccountMismatch))?;
    let settlement = resources
        .spot_adapter_record
        .manifest
        .settlement
        .clone()
        .ok_or_else(|| error!(ErrorCode::CashCarryResourceAccountMismatch))?;
    Ok(CashCarryAdmission {
        domain,
        spot_adapter: resources.spot_adapter_record.manifest.identity.clone(),
        perp_adapter: resources.perp_adapter_record.manifest.identity.clone(),
        spot_market: resources.spot_market_record.manifest.identity.clone(),
        perp_market: resources.perp_market_record.manifest.identity.clone(),
        spot_venue: resources.spot_venue_record.manifest.identity.clone(),
        perp_venue: resources.perp_venue_record.manifest.identity.clone(),
        base_asset: resources.base_asset_record.manifest.identity.clone(),
        quote_asset: resources.quote_asset_record.manifest.identity.clone(),
        quote_decimals: resources.quote_asset_record.manifest.decimals,
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
    require!(
        accounts
            .resources
            .spot_adapter_record
            .manifest
            .adapter_class
            .as_ref()
            .map(|class| class.id.as_str())
            == Some(SPOT_ADAPTER_CLASS_ID),
        ErrorCode::CashCarryResourceAccountMismatch
    );
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
    validate_perp_accounts(
        &accounts.rise_strategy,
        &accounts.rise,
        accounts
            .resources
            .perp_venue_record
            .manifest
            .subject_address,
        accounts
            .resources
            .perp_market_record
            .manifest
            .subject_address,
    )?;
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

fn validate_execution_authority(accounts: &ExecuteCashAndCarry, domain: &DomainRef) -> Result<()> {
    crate::instructions::cash_carry_strategy::validate_strategy_authority(
        &accounts.executor_authority,
        domain,
        accounts.trader.key(),
        accounts
            .resources
            .base_asset_record
            .manifest
            .subject_address,
        accounts
            .resources
            .quote_asset_record
            .manifest
            .subject_address,
        accounts.rise_strategy.key(),
    )
}

fn validate_package_lifecycle(
    accounts: &ExecuteCashAndCarry,
    args: &CashCarryExecutionArgs,
    economic_package_commitment: [u8; 32],
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
            validate_open_package_identity(
                open,
                accounts.trader.key(),
                economic_package_commitment,
                package_accounts_commitment,
                args.spot_quantity_atoms,
                args.perp_quantity_atoms,
            )?;
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
                    && entry.resource_admission_commitment
                        == open.entry_resource_admission_commitment
                    && entry.route_accounts_commitment == open.entry_route_accounts_commitment
                    && entry.spot_quantity_atoms == args.spot_quantity_atoms
                    && entry.perp_quantity_atoms == args.perp_quantity_atoms,
                ErrorCode::CashCarryEntryReceiptInvalid
            );
        }
    }
    Ok(())
}

pub(crate) fn validate_open_package_identity(
    open: &OpenCashCarryPackage,
    trader: Pubkey,
    economic_package_commitment: [u8; 32],
    package_accounts_commitment: [u8; 32],
    spot_quantity_atoms: u64,
    perp_quantity_atoms: u64,
) -> Result<()> {
    require!(
        open.trader == trader
            && open.economic_package_commitment == economic_package_commitment
            && open.package_accounts_commitment == package_accounts_commitment
            && open.spot_quantity_atoms == spot_quantity_atoms
            && open.perp_quantity_atoms == perp_quantity_atoms,
        ErrorCode::CashCarryOpenPackageMismatch
    );
    Ok(())
}

pub(crate) fn validate_preconditions(
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

pub(crate) fn execution_units(
    admission: &CashCarryAdmission,
    resources: &CashCarryResourceAccounts,
) -> Result<(u64, u64, u64)> {
    let spot_units = resources
        .spot_market_record
        .manifest
        .market_units
        .as_ref()
        .ok_or_else(|| error!(ErrorCode::CashCarryResourceAccountMismatch))?;
    let perp_units = resources
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
    args: PerpMarketOrderArgs,
    entry: bool,
    remaining_accounts: &[AccountInfo<'info>],
) -> Result<()> {
    let bump = [ctx.accounts.executor_authority.bump];
    let signer_seeds: &[&[u8]] = &[
        CASH_CARRY_EXECUTOR_SEED,
        ctx.accounts.trader.key.as_ref(),
        ctx.accounts.rise_strategy.to_account_info().key.as_ref(),
        bump.as_ref(),
    ];
    invoke_perp_order(
        PerpOrderContext {
            strategy: ctx.accounts.rise_strategy.to_account_info(),
            controller: ctx.accounts.executor_authority.to_account_info(),
            adapter_program: ctx.accounts.programs.perp_adapter_program.key(),
            venue_program: ctx.accounts.programs.perp_venue_program.to_account_info(),
            perp: &ctx.accounts.rise,
            token_program: ctx.accounts.runtime.token_program.to_account_info(),
            remaining_accounts,
        },
        &[signer_seeds],
        args,
        entry,
    )
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn enforce_postconditions(
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

pub(crate) fn require_solver_signature(
    instructions_sysvar: &AccountInfo,
    solver: &Pubkey,
    digest: &[u8; 32],
) -> Result<()> {
    verify_ed25519_signature(instructions_sysvar, solver, digest).map_err(|error| match error {
        Ed25519SignatureError::InvalidInstruction => {
            error!(ErrorCode::CashCarrySignatureInstructionInvalid)
        }
        Ed25519SignatureError::Mismatch => error!(ErrorCode::CashCarrySignatureMismatch),
    })
}

pub(crate) fn resource_record_keys(resources: &CashCarryResourceAccounts) -> [Pubkey; 8] {
    [
        resources.spot_adapter_record.key(),
        resources.perp_adapter_record.key(),
        resources.spot_market_record.key(),
        resources.perp_market_record.key(),
        resources.spot_venue_record.key(),
        resources.perp_venue_record.key(),
        resources.base_asset_record.key(),
        resources.quote_asset_record.key(),
    ]
}

pub(crate) fn economic_resource_record_keys(resources: &CashCarryResourceAccounts) -> [Pubkey; 5] {
    [
        resources.perp_adapter_record.key(),
        resources.perp_market_record.key(),
        resources.perp_venue_record.key(),
        resources.base_asset_record.key(),
        resources.quote_asset_record.key(),
    ]
}

pub(crate) fn resource_admission_commitment(
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

pub(crate) fn economic_package_commitment(
    admission: &CashCarryAdmission,
    record_keys: &[Pubkey; 5],
) -> [u8; 32] {
    let mut data = admission.domain.canonical_bytes();
    for identity in [
        &admission.perp_adapter,
        &admission.perp_market,
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
    hashv(&[ECONOMIC_PACKAGE_COMMITMENT_DOMAIN, &data]).to_bytes()
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
    ];
    keys.extend(perp_venue_account_keys(&accounts.rise));
    keys.extend(remaining.iter().map(AccountInfo::key));
    hash_pubkeys(ROUTE_ACCOUNTS_DOMAIN, &keys)
}

fn package_accounts_commitment(accounts: &ExecuteCashAndCarry) -> Result<[u8; 32]> {
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
    let (base_account, quote_account) = canonical_trader_token_accounts(
        accounts.spot.trader_token_a.key(),
        accounts.spot.trader_token_a.mint,
        accounts.spot.trader_token_b.key(),
        accounts.spot.trader_token_b.mint,
        base_mint,
        quote_mint,
    )?;
    Ok(hash_pubkeys(
        PACKAGE_ACCOUNTS_DOMAIN,
        &[base_account, quote_account, accounts.rise_strategy.key()],
    ))
}

fn canonical_trader_token_accounts(
    token_a: Pubkey,
    mint_a: Pubkey,
    token_b: Pubkey,
    mint_b: Pubkey,
    base_mint: Pubkey,
    quote_mint: Pubkey,
) -> Result<(Pubkey, Pubkey)> {
    if mint_a == base_mint && mint_b == quote_mint {
        Ok((token_a, token_b))
    } else if mint_b == base_mint && mint_a == quote_mint {
        Ok((token_b, token_a))
    } else {
        err!(ErrorCode::CashCarryTokenAccountMismatch)
    }
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
    keys.extend_from_slice(&resource_record_keys(&accounts.resources));
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
    ]);
    keys.extend_from_slice(&perp_venue_account_keys(&accounts.rise));
    keys.extend_from_slice(&[
        accounts.runtime.token_program.key(),
        accounts.system_program.key(),
        accounts.runtime.instructions_sysvar.key(),
    ]);
    keys.extend(remaining.iter().map(AccountInfo::key));
    keys
}

pub(crate) fn hash_pubkeys(domain: &[u8], keys: &[Pubkey]) -> [u8; 32] {
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
            expected_side: PACKAGE_BOOK_QUOTE_SIDE_ASK,
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
        expected.push(quote.expected_side);
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

    fn series_binding() -> CashCarrySeriesBindingV1 {
        CashCarrySeriesBindingV1 {
            schema_version: 1,
            binding_version: 1,
            domain_ref_identity_hash: [20; 32],
            series_manifest_hash: [22; 32],
            execution_class_manifest_hash: [23; 32],
            template_identity_hash: [24; 32],
            template_version: 1,
            template_manifest_hash: [25; 32],
            settlement_class_identity_hash: [31; 32],
            base_asset: manifest(8),
            quote_asset: manifest(9),
            quote_convention_identity_hash: [26; 32],
            entry_side: CASH_CARRY_SERIES_ENTRY_SIDE_ASK,
            spot_base_atoms_per_package_unit: 20,
            perp_quantity_atoms_per_package_unit: 2,
        }
    }

    #[test]
    fn quoted_entry_derives_equal_nonzero_package_units() {
        let execution = execution_args();
        let binding = series_binding();
        let mut quote = quote_args();
        quote.package_size_units = 5;
        assert_eq!(derive_package_size_units(&execution, &binding).unwrap(), 5);
        assert_eq!(
            validate_quote_against_series(&execution, &quote, &binding).unwrap(),
            5
        );
        let domain = DomainRef::new("solana:test", 1, [1; 32]).unwrap();
        let solver = Pubkey::new_unique();
        let consumer = Pubkey::new_unique();
        let quote_accounts = [Pubkey::new_unique()];
        let commitment = quote_intent_commitment(
            &domain,
            &solver,
            &consumer,
            [2; 32],
            [3; 32],
            [4; 32],
            &quote,
            &quote_accounts,
        );
        let mut changed_side = quote.clone();
        changed_side.expected_side = 1;
        assert_ne!(
            commitment,
            quote_intent_commitment(
                &domain,
                &solver,
                &consumer,
                [2; 32],
                [3; 32],
                [4; 32],
                &changed_side,
                &quote_accounts,
            )
        );

        quote.package_size_units = 4;
        assert!(validate_quote_against_series(&execution, &quote, &binding).is_err());
    }

    #[test]
    fn quoted_entry_rejects_wrong_side_and_invalid_quantity_ratios() {
        let binding = series_binding();
        let mut quote = quote_args();
        quote.package_size_units = 5;
        quote.expected_side = 1;
        assert!(validate_quote_against_series(&execution_args(), &quote, &binding).is_err());
        let mut exit = execution_args();
        exit.action = CashCarryAction::Exit;
        assert_eq!(validate_quote_against_series(&exit, &quote, &binding).unwrap(), 5);
        quote.expected_side = PACKAGE_BOOK_QUOTE_SIDE_ASK;
        assert!(validate_quote_against_series(&exit, &quote, &binding).is_err());

        let mut non_divisible = execution_args();
        non_divisible.spot_quantity_atoms = 101;
        assert!(derive_package_size_units(&non_divisible, &binding).is_err());

        let mut ratio_mismatch = execution_args();
        ratio_mismatch.perp_quantity_atoms = 8;
        assert!(derive_package_size_units(&ratio_mismatch, &binding).is_err());
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
        let other_solver = Pubkey::new_unique();
        let registry = SolverRegistry {
            active: vec![active_solver, other_solver],
            pending: Vec::new(),
            bump: 255,
        };
        assert_eq!(
            execution_solver(CashCarryAction::Entry, false, &registry, Some(active_solver)).unwrap(),
            active_solver
        );
        // Any active solver may authorize with its own signature.
        assert_eq!(
            execution_solver(CashCarryAction::Entry, false, &registry, Some(other_solver)).unwrap(),
            other_solver
        );
        assert_eq!(
            execution_solver(CashCarryAction::Exit, true, &registry, None).unwrap(),
            Pubkey::default()
        );
        assert!(execution_solver(CashCarryAction::Entry, true, &registry, None).is_err());
        assert!(execution_solver(CashCarryAction::Exit, false, &registry, None).is_err());
        assert!(execution_solver(
            CashCarryAction::Entry,
            false,
            &registry,
            Some(Pubkey::new_unique())
        )
        .is_err());
        assert!(execution_solver(
            CashCarryAction::Entry,
            false,
            &registry,
            Some(Pubkey::default())
        )
        .is_err());
    }

    #[test]
    fn lifecycle_exit_can_change_spot_route_but_not_economic_package() {
        let entry = admission();
        let economic_keys = [
            Pubkey::new_unique(),
            Pubkey::new_unique(),
            Pubkey::new_unique(),
            Pubkey::new_unique(),
            Pubkey::new_unique(),
        ];
        let commitment = economic_package_commitment(&entry, &economic_keys);

        let mut fresh_exit = entry.clone();
        fresh_exit.action = ResourceAction::Exit;
        fresh_exit.spot_adapter = manifest(31);
        fresh_exit.spot_market = manifest(32);
        fresh_exit.spot_venue = manifest(33);
        fresh_exit.spot_limit_quote_atoms_per_base_lot += 1;
        assert_eq!(
            commitment,
            economic_package_commitment(&fresh_exit, &economic_keys)
        );

        fresh_exit.perp_market = manifest(34);
        assert_ne!(
            commitment,
            economic_package_commitment(&fresh_exit, &economic_keys)
        );

        let trader = Pubkey::new_unique();
        let package_accounts = [41; 32];
        let open = OpenCashCarryPackage {
            version: OPEN_PACKAGE_VERSION,
            domain: entry.domain,
            trader,
            entry_receipt: Pubkey::new_unique(),
            entry_route_hash: [42; 32],
            quote_intent_commitment: [43; 32],
            package_fill_commitment: [44; 32],
            entry_resource_admission_commitment: [45; 32],
            entry_route_accounts_commitment: [46; 32],
            economic_package_commitment: commitment,
            package_accounts_commitment: package_accounts,
            spot_quantity_atoms: entry.spot_quantity_atoms,
            perp_quantity_atoms: entry.perp_quantity_atoms,
            bump: 1,
        };
        assert!(validate_open_package_identity(
            &open,
            trader,
            commitment,
            package_accounts,
            entry.spot_quantity_atoms,
            entry.perp_quantity_atoms,
        )
        .is_ok());
        assert!(validate_open_package_identity(
            &open,
            trader,
            [47; 32],
            package_accounts,
            entry.spot_quantity_atoms,
            entry.perp_quantity_atoms,
        )
        .is_err());

        let base_account = Pubkey::new_unique();
        let quote_account = Pubkey::new_unique();
        let base_mint = Pubkey::new_unique();
        let quote_mint = Pubkey::new_unique();
        assert_eq!(
            canonical_trader_token_accounts(
                base_account,
                base_mint,
                quote_account,
                quote_mint,
                base_mint,
                quote_mint,
            )
            .unwrap(),
            canonical_trader_token_accounts(
                quote_account,
                quote_mint,
                base_account,
                base_mint,
                base_mint,
                quote_mint,
            )
            .unwrap()
        );
    }
}

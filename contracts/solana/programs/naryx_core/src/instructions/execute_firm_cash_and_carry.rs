use anchor_lang::{
    prelude::*,
    solana_program::{
        instruction::{AccountMeta, Instruction},
        program::{get_return_data, invoke_signed},
    },
};
use anchor_spl::{
    associated_token::get_associated_token_address,
    token::{self, TokenAccount, Transfer},
};
use solana_sha256_hasher::hashv;

#[cfg(feature = "devnet-test-perp")]
use crate::instructions::{
    execute_cash_and_carry::validate_open_package_identity,
    resource_registry::validate_cash_carry_exit_admission,
};
use crate::{
    constants::{
        CASH_CARRY_EXECUTOR_SEED, CASH_CARRY_NONCE_SEED, CASH_CARRY_OPEN_SEED,
        CASH_CARRY_RECEIPT_SEED, INVENTORY_RESERVATION_PROGRAM_ID, PROTOCOL_CONFIG_SEED,
        SOLVER_REGISTRY_SEED,
    },
    error::ErrorCode,
    events::CashCarryExecutionRecorded,
    instructions::{
        cash_carry_strategy::validate_strategy_authority,
        execute_cash_and_carry::{
            economic_package_commitment, encode_consume_capacity_instruction,
            enforce_postconditions, execution_units, hash_pubkeys, live_program_code_identity,
            quote_intent_commitment, quoted_execution_digest, reconstruct_admission,
            require_solver_signature, resource_admission_commitment, resource_record_keys,
            validate_basic_inputs, validate_cash_carry_risk_domain, validate_expiry,
            validate_package_book_accounts, validate_preconditions,
            validate_quote_series_binding_pair, validate_resource_indices, CashCarryAction,
            CashCarryExecutionArgs, CashCarryQuoteArgs, CashCarryResourceAccounts,
            CashCarryRiskDomainAccounts, CashCarryRuntimeAccounts, QuoteEvidence,
            OPEN_PACKAGE_VERSION, PACKAGE_ACCOUNTS_DOMAIN, PACKAGE_BOOK_ACCOUNT_COUNT,
            PACKAGE_BOOK_QUOTE_MODE_FIRM_ONCHAIN, PACKAGE_BOOK_QUOTE_SIDE_ASK,
            PACKAGE_BOOK_QUOTE_SIDE_BID, ROUTE_ACCOUNTS_DOMAIN,
        },
        resource_registry::{
            validate_cash_carry_admission, verify_code_identity, CashCarryResources,
        },
    },
    perp_venue::{
        invoke_perp_order, perp_position_and_collateral, perp_venue_account_keys,
        validate_perp_accounts, CashCarryRiseAccounts, CashCarryRiseAccountsBumps,
        PerpAdapterProgram, PerpMarketOrderArgs, PerpOrderContext, PerpStrategy,
        __client_accounts_cash_carry_rise_accounts, __cpi_client_accounts_cash_carry_rise_accounts,
        PERP_VENUE_ACCOUNT_COUNT, PERP_VENUE_PROGRAM_ID,
    },
    reservation_policy::reservation_policy_hash,
    state::{
        CashCarryExecutionReceipt, CashCarryNonce, CashCarrySeriesBindingIndex,
        CashCarrySeriesBindingRecord, CashCarryStrategyAuthority, OpenCashCarryPackage,
        ProtocolConfig, SolverRegistry, FIRM_RESERVATION_SPOT_ADAPTER_CLASS_ID,
    },
    wire::{DomainRef, ProtocolId, HASH_BYTE_LENGTH},
    CashCarryResourceAccountsBumps, CashCarryRiskDomainAccountsBumps,
    CashCarryRuntimeAccountsBumps, __client_accounts_cash_carry_resource_accounts,
    __client_accounts_cash_carry_risk_domain_accounts,
    __client_accounts_cash_carry_runtime_accounts,
    __cpi_client_accounts_cash_carry_resource_accounts,
    __cpi_client_accounts_cash_carry_risk_domain_accounts,
    __cpi_client_accounts_cash_carry_runtime_accounts,
};

const RESERVATION_CLASS_SEED: &[u8] = b"reservation-class";
const RESERVATION_CAPACITY_SEED: &[u8] = b"reservation-capacity";
const RESERVATION_SEED: &[u8] = b"reservation";
const RESERVATION_VAULT_SEED: &[u8] = b"reservation-vault";
const LIVE_PAIR_SEED: &[u8] = b"live-pair";
const RESERVATION_CLASS_VERSION: u16 = 2;
const RESERVATION_DOMAIN_IDENTITY_DOMAIN: &[u8] = b"CON/v1/domain-ref-identity";
const RESERVATION_ID_DOMAIN: &[u8] = b"CON/v1/reservation-id";
const FIRM_EXECUTION_DIGEST_DOMAIN: &[u8] = b"NARYX/firm-cash-carry-execution/v1";
const FIRM_QUOTE_LOCK_SEED: &[u8] = b"firm-quote-lock";
const FIRM_QUOTE_ARGS_DOMAIN: &[u8] = b"NARYX/firm-quote-args/v1";
const RESERVATION_ACTION_ENTRY: u8 = 1;
const RESERVATION_ACTION_EXIT: u8 = 2;
pub const FIRM_FIXED_ACCOUNT_COUNT: usize = 51 + PERP_VENUE_ACCOUNT_COUNT;
pub const FIRM_AUXILIARY_PROGRAM_COUNT: usize = 2;
pub const MAX_FIRM_RISE_EXTRA_ACCOUNTS: usize =
    64 - FIRM_FIXED_ACCOUNT_COUNT - FIRM_AUXILIARY_PROGRAM_COUNT;

fn firm_quote_args_hash(quote: &CashCarryQuoteArgs) -> Result<[u8; 32]> {
    let mut bytes = Vec::new();
    quote.serialize(&mut bytes)?;
    Ok(hashv(&[FIRM_QUOTE_ARGS_DOMAIN, &bytes]).to_bytes())
}

#[account]
#[derive(InitSpace)]
pub struct FirmQuoteLock {
    pub domain: DomainRef,
    pub solver: Pubkey,
    pub reservation: Pubkey,
    pub reservation_id: [u8; 32],
    pub reservation_policy_hash: [u8; 32],
    pub order_hash: [u8; 32],
    pub quote_hash: [u8; 32],
    pub route_hash: [u8; 32],
    pub quote_args_hash: [u8; 32],
    pub series_manifest_hash: [u8; 32],
    pub execution_class_manifest_hash: [u8; 32],
    pub fill_commitment: [u8; 32],
    pub package_size_units: u64,
    pub base_atoms: u64,
    pub quote_atoms: u64,
    pub expiry_slot: u64,
    pub consumed: bool,
    pub bump: u8,
}

#[derive(AnchorSerialize)]
struct ConsumeReservationArgs {
    package_nonce: u64,
    order_hash: [u8; 32],
    quote_hash: [u8; 32],
    route_hash: [u8; 32],
}

#[derive(AnchorDeserialize)]
struct ReservationClassWire {
    version: u16,
    domain: DomainRef,
    domain_identity: [u8; 32],
    reservation_program: Pubkey,
    reservation_program_data: Pubkey,
    reservation_code_identity: [u8; 32],
    policy_hash: [u8; 32],
    base_mint: Pubkey,
    quote_mint: Pubkey,
    core_program: Pubkey,
    core_program_data: Pubkey,
    core_code_identity: [u8; 32],
    consumer_program: Pubkey,
    consumer_program_data: Pubkey,
    consumer_code_identity: [u8; 32],
    max_ttl_slots: u64,
    max_base_atoms: u64,
    max_solver_reserved_base_atoms: u64,
    bump: u8,
}

#[derive(AnchorDeserialize, PartialEq, Eq)]
enum ReservationStateWire {
    Funded,
    Live,
    Consumed,
    Released,
}

#[derive(AnchorDeserialize)]
struct FirmReservationWire {
    version: u16,
    reservation_class: Pubkey,
    domain: DomainRef,
    reservation_id: [u8; 32],
    solver_id: ProtocolId,
    solver: Pubkey,
    strategy_authority: Pubkey,
    package_nonce: u64,
    order_hash: [u8; 32],
    quote_hash: [u8; 32],
    route_hash: [u8; 32],
    reservation_nonce: [u8; 32],
    base_mint: Pubkey,
    quote_mint: Pubkey,
    solver_reclaim_base: Pubkey,
    solver_quote: Pubkey,
    strategy_base: Pubkey,
    strategy_quote: Pubkey,
    base_atoms: u64,
    quote_atoms: u64,
    expiry_slot: u64,
    action: u8,
    state: ReservationStateWire,
    bump: u8,
    vault_bump: u8,
}

#[derive(Accounts)]
#[instruction(order_hash: [u8; 32], quote_hash: [u8; 32], route_hash: [u8; 32], quote: CashCarryQuoteArgs)]
pub struct LockFirmQuote<'info> {
    #[account(mut)]
    pub solver: Signer<'info>,
    #[account(seeds = [PROTOCOL_CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, ProtocolConfig>>,
    /// CHECK: The reservation program owns and authenticates the state.
    pub reservation: UncheckedAccount<'info>,
    /// CHECK: The reservation program owns and authenticates the class.
    pub reservation_class: UncheckedAccount<'info>,
    #[account(
        init, payer = solver, space = 8 + FirmQuoteLock::INIT_SPACE,
        seeds = [FIRM_QUOTE_LOCK_SEED, quote.reservation_id.as_ref()], bump
    )]
    pub quote_lock: Box<Account<'info, FirmQuoteLock>>,
    pub system_program: Program<'info, System>,
}

pub fn lock_firm_quote_handler<'info>(
    ctx: Context<'info, LockFirmQuote<'info>>,
    order_hash: [u8; 32],
    quote_hash: [u8; 32],
    route_hash: [u8; 32],
    quote: CashCarryQuoteArgs,
) -> Result<()> {
    require!(
        order_hash != [0; 32] && quote_hash != [0; 32] && route_hash != [0; 32],
        ErrorCode::CashCarryHashZero
    );
    require!(
        (cfg!(feature = "devnet-test-perp") || !ctx.accounts.config.entry_paused)
            && quote.expected_quote_mode == PACKAGE_BOOK_QUOTE_MODE_FIRM_ONCHAIN
            && quote.expected_reservation_policy_hash != [0; 32]
            && quote.reservation_id != [0; 32]
            && quote.expected_fill_commitment != [0; 32]
            && quote.package_size_units != 0,
        ErrorCode::CashCarryQuoteParameterInvalid
    );
    let slot = Clock::get()?.slot;
    require!(
        slot < quote.expected_expiry_slot,
        ErrorCode::CashCarryQuoteParameterInvalid
    );
    let domain = &ctx.accounts.config.domain;
    require_keys_eq!(
        *ctx.accounts.reservation.owner,
        INVENTORY_RESERVATION_PROGRAM_ID,
        ErrorCode::CashCarryQuoteAccountMismatch
    );
    require_keys_eq!(
        *ctx.accounts.reservation_class.owner,
        INVENTORY_RESERVATION_PROGRAM_ID,
        ErrorCode::CashCarryQuoteAccountMismatch
    );
    let reservation_data = ctx.accounts.reservation.try_borrow_data()?;
    let discriminator = hashv(&[b"account:FirmReservation"]).to_bytes();
    require!(
        reservation_data.len() >= 8 && reservation_data[..8] == discriminator[..8],
        ErrorCode::CashCarryQuoteAccountMismatch
    );
    let reservation = FirmReservationWire::deserialize(&mut &reservation_data[8..])
        .map_err(|_| error!(ErrorCode::CashCarryQuoteAccountMismatch))?;
    let (expected_reservation, _) = Pubkey::find_program_address(
        &[
            RESERVATION_SEED,
            ctx.accounts.reservation_class.key().as_ref(),
            ctx.accounts.solver.key().as_ref(),
            quote.reservation_id.as_ref(),
        ],
        &INVENTORY_RESERVATION_PROGRAM_ID,
    );
    require_keys_eq!(
        ctx.accounts.reservation.key(),
        expected_reservation,
        ErrorCode::CashCarryQuoteAccountMismatch
    );
    require!(
        reservation.domain == *domain
            && reservation.reservation_class == ctx.accounts.reservation_class.key()
            && reservation.reservation_id == quote.reservation_id
            && reservation.solver == ctx.accounts.solver.key()
            && reservation.order_hash == order_hash
            && reservation.quote_hash == quote_hash
            && reservation.route_hash == route_hash
            && reservation.expiry_slot == quote.expected_expiry_slot
            && reservation.state == ReservationStateWire::Live,
        ErrorCode::CashCarryQuoteAccountMismatch
    );
    // The firm exit lane: a buy-back reservation locks only a bid, an entry reservation only an
    // ask, and only entry locks are blocked by the entry pause.
    #[cfg(feature = "devnet-test-perp")]
    {
        let exit = reservation.action == RESERVATION_ACTION_EXIT;
        require!(
            (exit && quote.expected_side == PACKAGE_BOOK_QUOTE_SIDE_BID)
                || (reservation.action == RESERVATION_ACTION_ENTRY
                    && quote.expected_side == PACKAGE_BOOK_QUOTE_SIDE_ASK
                    && !ctx.accounts.config.entry_paused),
            ErrorCode::CashCarryQuoteParameterInvalid
        );
    }
    let class_data = ctx.accounts.reservation_class.try_borrow_data()?;
    let class_discriminator = hashv(&[b"account:ReservationClass"]).to_bytes();
    require!(
        class_data.len() >= 8 && class_data[..8] == class_discriminator[..8],
        ErrorCode::CashCarryQuoteAccountMismatch
    );
    let class = ReservationClassWire::deserialize(&mut &class_data[8..])
        .map_err(|_| error!(ErrorCode::CashCarryQuoteAccountMismatch))?;
    require!(
        class.domain == *domain
            && class.policy_hash == quote.expected_reservation_policy_hash
            && class.base_mint == reservation.base_mint
            && class.quote_mint == reservation.quote_mint,
        ErrorCode::CashCarryQuoteAccountMismatch
    );
    require!(
        ctx.remaining_accounts.len() == PACKAGE_BOOK_ACCOUNT_COUNT,
        ErrorCode::CashCarryQuoteAccountMismatch
    );
    validate_package_book_accounts(
        &ctx.accounts.config,
        ctx.remaining_accounts,
        domain,
        ctx.accounts.solver.key(),
        &quote,
    )?;
    let book = ctx.remaining_accounts;
    let instruction = Instruction {
        program_id: crate::constants::PACKAGE_BOOK_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new_readonly(ctx.accounts.quote_lock.key(), true),
            AccountMeta::new_readonly(book[2].key(), false),
            AccountMeta::new_readonly(book[3].key(), false),
            AccountMeta::new_readonly(ctx.accounts.config.key(), false),
            AccountMeta::new_readonly(book[2].key(), false),
            AccountMeta::new_readonly(book[3].key(), false),
            AccountMeta::new_readonly(book[4].key(), false),
            AccountMeta::new(book[5].key(), false),
            AccountMeta::new(book[6].key(), false),
        ],
        data: encode_consume_capacity_instruction(order_hash, quote_hash, route_hash, &quote)?,
    };
    let bump = [ctx.bumps.quote_lock];
    let signer: &[&[u8]] = &[
        FIRM_QUOTE_LOCK_SEED,
        quote.reservation_id.as_ref(),
        bump.as_ref(),
    ];
    invoke_signed(
        &instruction,
        &[
            ctx.accounts.quote_lock.to_account_info(),
            book[2].clone(),
            book[3].clone(),
            ctx.accounts.config.to_account_info(),
            book[2].clone(),
            book[3].clone(),
            book[4].clone(),
            book[5].clone(),
            book[6].clone(),
            book[0].clone(),
        ],
        &[signer],
    )?;
    let (program, bytes) =
        get_return_data().ok_or_else(|| error!(ErrorCode::CashCarryQuoteReturnDataInvalid))?;
    require_keys_eq!(
        program,
        crate::constants::PACKAGE_BOOK_PROGRAM_ID,
        ErrorCode::CashCarryQuoteReturnDataInvalid
    );
    require!(
        bytes.len() == 32 && bytes.as_slice() == quote.expected_fill_commitment.as_ref(),
        ErrorCode::CashCarryQuoteReturnDataInvalid
    );
    let quote_args_hash = firm_quote_args_hash(&quote)?;
    ctx.accounts.quote_lock.set_inner(FirmQuoteLock {
        domain: domain.clone(),
        solver: ctx.accounts.solver.key(),
        reservation: ctx.accounts.reservation.key(),
        reservation_id: quote.reservation_id,
        reservation_policy_hash: quote.expected_reservation_policy_hash,
        order_hash,
        quote_hash,
        route_hash,
        quote_args_hash,
        series_manifest_hash: quote.series_manifest_hash,
        execution_class_manifest_hash: quote.execution_class_manifest_hash,
        fill_commitment: quote.expected_fill_commitment,
        package_size_units: quote.package_size_units,
        base_atoms: reservation.base_atoms,
        quote_atoms: reservation.quote_atoms,
        expiry_slot: quote.expected_expiry_slot,
        consumed: false,
        bump: ctx.bumps.quote_lock,
    });
    Ok(())
}

#[derive(Accounts)]
#[instruction(order_hash: [u8; HASH_BYTE_LENGTH], quote_hash: [u8; HASH_BYTE_LENGTH], route_hash: [u8; HASH_BYTE_LENGTH], args: CashCarryExecutionArgs)]
pub struct ExecuteFirmCashAndCarry<'info> {
    #[account(mut)]
    pub trader: Signer<'info>,
    #[account(seeds = [PROTOCOL_CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, ProtocolConfig>>,
    #[account(seeds = [SOLVER_REGISTRY_SEED], bump = solver_registry.bump)]
    pub solver_registry: Box<Account<'info, SolverRegistry>>,
    pub risk: CashCarryRiskDomainAccounts<'info>,
    /// CHECK: The system ownership and active solver registry membership are checked here.
    #[account(
        mut,
        owner = system_program::ID,
        constraint = solver_registry.is_active(&solver.key()) @ ErrorCode::CashCarrySolverInvalid
    )]
    pub solver: UncheckedAccount<'info>,
    #[account(
        init, payer = trader, space = 8 + CashCarryExecutionReceipt::INIT_SPACE,
        seeds = [CASH_CARRY_RECEIPT_SEED, trader.key().as_ref(), order_hash.as_ref()], bump
    )]
    pub receipt: Box<Account<'info, CashCarryExecutionReceipt>>,
    #[account(
        init, payer = trader, space = 8 + CashCarryNonce::INIT_SPACE,
        seeds = [CASH_CARRY_NONCE_SEED, trader.key().as_ref(), args.nonce.to_be_bytes().as_ref()], bump
    )]
    pub nonce_marker: Box<Account<'info, CashCarryNonce>>,
    #[account(
        init_if_needed, payer = trader, space = 8 + OpenCashCarryPackage::INIT_SPACE,
        seeds = [CASH_CARRY_OPEN_SEED, trader.key().as_ref(), rise_strategy.key().as_ref()], bump
    )]
    pub open_package: Box<Account<'info, OpenCashCarryPackage>>,
    #[account(
        seeds = [CASH_CARRY_EXECUTOR_SEED, trader.key().as_ref(), rise_strategy.key().as_ref()],
        bump = executor_authority.bump,
        has_one = trader @ ErrorCode::CashCarryStrategyAuthorityInvalid,
        has_one = rise_strategy @ ErrorCode::CashCarryStrategyAuthorityInvalid
    )]
    pub executor_authority: Box<Account<'info, CashCarryStrategyAuthority>>,
    pub resources: CashCarryResourceAccounts<'info>,
    pub firm: FirmSettlementAccounts<'info>,
    #[account(mut, seeds = [FIRM_QUOTE_LOCK_SEED, quote_lock.reservation_id.as_ref()], bump = quote_lock.bump)]
    pub quote_lock: Box<Account<'info, FirmQuoteLock>>,
    pub series_index: Box<Account<'info, CashCarrySeriesBindingIndex>>,
    pub series_record: Box<Account<'info, CashCarrySeriesBindingRecord>>,
    pub perp_adapter_program: Program<'info, PerpAdapterProgram>,
    /// CHECK: The admitted adapter record pins this ProgramData and its bytes.
    pub perp_adapter_program_data: UncheckedAccount<'info>,
    /// CHECK: The admitted venue record pins this executable program.
    #[account(address = PERP_VENUE_PROGRAM_ID, executable)]
    pub perp_venue_program: UncheckedAccount<'info>,
    /// CHECK: The admitted venue record pins this ProgramData and its bytes.
    pub perp_venue_program_data: UncheckedAccount<'info>,
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
pub struct FirmSettlementAccounts<'info> {
    /// CHECK: The fixed reservation ID, upgradeable loader and code bytes are checked.
    #[account(address = INVENTORY_RESERVATION_PROGRAM_ID, executable)]
    pub reservation_program: UncheckedAccount<'info>,
    /// CHECK: The fixed reservation program's ProgramData and code bytes are checked.
    pub reservation_program_data: UncheckedAccount<'info>,
    /// CHECK: The current executing program and ProgramData are checked.
    pub core_program: UncheckedAccount<'info>,
    /// CHECK: The current executing program and ProgramData are checked.
    pub core_program_data: UncheckedAccount<'info>,
    /// CHECK: The reservation CPI validates the class and all reservation seeds.
    pub reservation_class: UncheckedAccount<'info>,
    /// CHECK: The reservation CPI validates the capacity account and mutates it.
    #[account(mut)]
    pub reservation_capacity: UncheckedAccount<'info>,
    /// CHECK: The reservation CPI validates live state and exact commitments.
    #[account(mut)]
    pub reservation: UncheckedAccount<'info>,
    /// CHECK: The reservation CPI validates the live pair and closes it.
    #[account(mut)]
    pub live_pair: UncheckedAccount<'info>,
    #[account(mut)]
    pub reservation_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub solver_quote: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub trader_base: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub trader_quote: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub executor_base: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub executor_quote: Box<Account<'info, TokenAccount>>,
}

pub(crate) fn handler<'info>(
    ctx: Context<'info, ExecuteFirmCashAndCarry<'info>>,
    order_hash: [u8; 32],
    quote_hash: [u8; 32],
    route_hash: [u8; 32],
    args: CashCarryExecutionArgs,
    quote: CashCarryQuoteArgs,
    firm_quote_atoms: u64,
) -> Result<()> {
    validate_basic_inputs(order_hash, quote_hash, route_hash, &args)?;
    #[cfg(feature = "devnet-test-perp")]
    if args.action == CashCarryAction::Exit {
        return execute_firm_exit(
            ctx,
            order_hash,
            quote_hash,
            route_hash,
            args,
            quote,
            firm_quote_atoms,
        );
    }
    require!(
        args.action == CashCarryAction::Entry && !args.recovery && args.spot_sqrt_price_limit == 1,
        ErrorCode::CashCarryQuoteActionInvalid
    );
    validate_firm_quote_args(&args, &quote, firm_quote_atoms)?;
    require!(
        ctx.remaining_accounts.len() <= MAX_FIRM_RISE_EXTRA_ACCOUNTS,
        ErrorCode::CashCarryQuoteAccountMismatch
    );
    let execution_slot = Clock::get()?.slot;
    validate_expiry(execution_slot, args.expiry_slot)?;
    require!(
        !ctx.accounts.config.entry_paused,
        ErrorCode::CashCarryEntryPaused
    );
    require!(
        ctx.accounts.open_package.version == 0,
        ErrorCode::CashCarryPackageAlreadyOpen
    );
    let domain = ctx.accounts.config.domain.clone();
    let resources = &ctx.accounts.resources;
    let admission = reconstruct_admission(resources, &args, domain.clone())?;
    validate_cash_carry_admission(
        &ctx.accounts.config,
        &admission,
        &CashCarryResources {
            spot_adapter: &resources.spot_adapter_record,
            perp_adapter: &resources.perp_adapter_record,
            spot_market: &resources.spot_market_record,
            perp_market: &resources.perp_market_record,
            spot_venue: &resources.spot_venue_record,
            perp_venue: &resources.perp_venue_record,
            base_asset: &resources.base_asset_record,
            quote_asset: &resources.quote_asset_record,
        },
    )?;
    validate_resource_indices(resources, true)?;
    validate_cash_carry_risk_domain(
        &ctx.accounts.risk.risk_domain_index,
        &ctx.accounts.risk.risk_domain_record,
        ctx.accounts.risk.risk_domain_record.key(),
        &resources.quote_asset_record.manifest.identity,
        resources.spot_adapter_record.manifest.identity.subject_id,
        resources.perp_adapter_record.manifest.identity.subject_id,
        &ctx.accounts.open_package,
        &args,
        &domain,
    )?;
    let risk_policy = &ctx.accounts.risk.risk_domain_record.policy;
    let risk_series = risk_policy
        .eligible_series
        .get(usize::from(args.risk_series_index))
        .ok_or_else(|| error!(ErrorCode::RiskDomainSeriesUnsupported))?
        .clone();
    validate_strategy_authority(
        &ctx.accounts.executor_authority,
        &domain,
        ctx.accounts.trader.key(),
        resources.base_asset_record.manifest.subject_address,
        resources.quote_asset_record.manifest.subject_address,
        ctx.accounts.rise_strategy.key(),
    )?;
    validate_firm_accounts(
        &ctx.accounts,
        &quote,
        firm_quote_atoms,
        order_hash,
        quote_hash,
        route_hash,
        &args,
        execution_slot,
    )?;

    validate_quote_series_binding_pair(
        &ctx.accounts.config,
        resources,
        &ctx.accounts.series_index,
        &ctx.accounts.series_record,
        &args,
        &quote,
    )?;
    let quote_account_keys = [
        ctx.accounts.quote_lock.key(),
        ctx.accounts.series_index.key(),
        ctx.accounts.series_record.key(),
    ];
    let quote_evidence = QuoteEvidence {
        intent_commitment: quote_intent_commitment(
            &domain,
            &ctx.accounts.solver.key(),
            &ctx.accounts.quote_lock.key(),
            order_hash,
            quote_hash,
            route_hash,
            &quote,
            &quote_account_keys,
        ),
        fill_commitment: quote.expected_fill_commitment,
    };
    let resource_commitment =
        resource_admission_commitment(&admission, &resource_record_keys(resources));
    let economic_commitment = economic_package_commitment(
        &admission,
        &[
            resources.perp_adapter_record.key(),
            resources.perp_market_record.key(),
            resources.perp_venue_record.key(),
            resources.base_asset_record.key(),
            resources.quote_asset_record.key(),
        ],
    );
    let route_commitment = firm_route_accounts_commitment(&ctx);
    let package_commitment = hash_pubkeys(
        PACKAGE_ACCOUNTS_DOMAIN,
        &[
            ctx.accounts.firm.trader_base.key(),
            ctx.accounts.firm.trader_quote.key(),
            ctx.accounts.rise_strategy.key(),
        ],
    );
    let quoted_digest = quoted_execution_digest(
        &domain,
        order_hash,
        quote_hash,
        route_hash,
        &args,
        resource_commitment,
        &firm_execution_account_keys(&ctx),
        quote_evidence,
    );
    let digest = hashv(&[
        FIRM_EXECUTION_DIGEST_DOMAIN,
        &quoted_digest,
        &firm_quote_atoms.to_be_bytes(),
    ])
    .to_bytes();
    require_solver_signature(
        &ctx.accounts.runtime.instructions_sysvar,
        &ctx.accounts.solver.key(),
        &digest,
    )?;
    let (perp_base_lots, perp_limit_ticks, spot_quote_limit_atoms) =
        execution_units(&admission, resources)?;
    require!(
        firm_quote_atoms <= spot_quote_limit_atoms,
        ErrorCode::CashCarryPostconditionFailed
    );
    let (pre_rise_base_lots, pre_collateral) =
        perp_position_and_collateral(&ctx.accounts.rise_strategy, &ctx.accounts.rise)?;
    validate_preconditions(&args, pre_rise_base_lots, pre_collateral, perp_base_lots)?;

    let pre_base = ctx.accounts.firm.trader_base.amount;
    let pre_quote = ctx.accounts.firm.trader_quote.amount;
    fund_executor_quote(&ctx, firm_quote_atoms)?;
    consume_reservation(
        &ctx,
        b"consume_reservation",
        order_hash,
        quote_hash,
        route_hash,
        args.nonce,
    )?;
    ctx.accounts.firm.executor_base.reload()?;
    ctx.accounts.firm.executor_quote.reload()?;
    validate_reservation_delivery(
        args.spot_quantity_atoms,
        ctx.accounts.firm.executor_base.amount,
        ctx.accounts.firm.executor_quote.amount,
    )?;
    deliver_base(&ctx, args.spot_quantity_atoms)?;
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
    )?;
    ctx.accounts.firm.trader_base.reload()?;
    ctx.accounts.firm.trader_quote.reload()?;
    ctx.accounts.firm.executor_base.reload()?;
    require!(
        ctx.accounts.firm.executor_base.amount == 0,
        ErrorCode::CashCarryPostconditionFailed
    );
    let (post_rise_base_lots, post_collateral) =
        perp_position_and_collateral(&ctx.accounts.rise_strategy, &ctx.accounts.rise)?;
    let spot_quote_delta_atoms = enforce_postconditions(
        &args,
        pre_base,
        ctx.accounts.firm.trader_base.amount,
        pre_quote,
        ctx.accounts.firm.trader_quote.amount,
        pre_rise_base_lots,
        post_rise_base_lots,
        post_collateral,
        perp_base_lots,
        spot_quote_limit_atoms,
    )?;
    require!(
        spot_quote_delta_atoms == firm_quote_atoms,
        ErrorCode::CashCarryPostconditionFailed
    );
    ctx.accounts.quote_lock.consumed = true;

    let entry_receipt = ctx.accounts.receipt.key();
    ctx.accounts.receipt.set_inner(CashCarryExecutionReceipt {
        domain: domain.clone(),
        order_hash,
        quote_hash,
        route_hash,
        trader: ctx.accounts.trader.key(),
        solver: ctx.accounts.solver.key(),
        nonce: args.nonce,
        execution_digest: digest,
        quote_intent_commitment: quote_evidence.intent_commitment,
        package_fill_commitment: quote_evidence.fill_commitment,
        action: args.action.discriminant(),
        recovery: false,
        spot_quantity_atoms: args.spot_quantity_atoms,
        perp_quantity_atoms: args.perp_quantity_atoms,
        spot_quote_delta_atoms,
        pre_base_balance: pre_base,
        post_base_balance: ctx.accounts.firm.trader_base.amount,
        pre_quote_balance: pre_quote,
        post_quote_balance: ctx.accounts.firm.trader_quote.amount,
        pre_rise_base_lots,
        post_rise_base_lots,
        pre_rise_collateral_quote_lots: pre_collateral,
        post_rise_collateral_quote_lots: post_collateral,
        execution_slot,
        resource_admission_commitment: resource_commitment,
        route_accounts_commitment: route_commitment,
        entry_receipt,
        risk_domain_id: args.risk_domain_id,
        risk_policy_version: args.risk_policy_version,
        risk_policy_manifest_hash: risk_policy.manifest_hash,
        risk_series: risk_series.clone(),
        bump: ctx.bumps.receipt,
    });
    ctx.accounts.nonce_marker.set_inner(CashCarryNonce {
        order_hash,
        execution_digest: digest,
        bump: ctx.bumps.nonce_marker,
    });
    ctx.accounts.open_package.set_inner(OpenCashCarryPackage {
        version: OPEN_PACKAGE_VERSION,
        domain: domain.clone(),
        trader: ctx.accounts.trader.key(),
        entry_receipt,
        entry_route_hash: route_hash,
        quote_intent_commitment: quote_evidence.intent_commitment,
        package_fill_commitment: quote_evidence.fill_commitment,
        entry_resource_admission_commitment: resource_commitment,
        entry_route_accounts_commitment: route_commitment,
        economic_package_commitment: economic_commitment,
        package_accounts_commitment: package_commitment,
        spot_quantity_atoms: args.spot_quantity_atoms,
        perp_quantity_atoms: args.perp_quantity_atoms,
        risk_domain_id: args.risk_domain_id,
        risk_policy_version: args.risk_policy_version,
        risk_policy_manifest_hash: risk_policy.manifest_hash,
        risk_series: risk_series.clone(),
        bump: ctx.bumps.open_package,
    });
    emit!(CashCarryExecutionRecorded {
        receipt: entry_receipt,
        domain,
        order_hash,
        quote_hash,
        route_hash,
        trader: ctx.accounts.trader.key(),
        solver: ctx.accounts.solver.key(),
        nonce: args.nonce,
        execution_digest: digest,
        quote_intent_commitment: quote_evidence.intent_commitment,
        package_fill_commitment: quote_evidence.fill_commitment,
        action: args.action.discriminant(),
        recovery: false,
        spot_quantity_atoms: args.spot_quantity_atoms,
        perp_quantity_atoms: args.perp_quantity_atoms,
        spot_quote_delta_atoms,
        pre_base_balance: pre_base,
        post_base_balance: ctx.accounts.firm.trader_base.amount,
        pre_quote_balance: pre_quote,
        post_quote_balance: ctx.accounts.firm.trader_quote.amount,
        pre_rise_base_lots,
        post_rise_base_lots,
        pre_rise_collateral_quote_lots: pre_collateral,
        post_rise_collateral_quote_lots: post_collateral,
        execution_slot,
        resource_admission_commitment: resource_commitment,
        route_accounts_commitment: route_commitment,
        entry_receipt,
        risk_domain_id: args.risk_domain_id,
        risk_policy_version: args.risk_policy_version,
        risk_policy_manifest_hash: risk_policy.manifest_hash,
        risk_series,
    });
    Ok(())
}

/// Firm exit of an open package against a live buy-back reservation. The perp short is closed
/// reduce-only, the trader's exact spot base moves through the executor to the solver, and the
/// solver's escrowed firm quote moves through the executor to the trader, all in this instruction.
/// Postconditions: spot base out equals the package quantity, quote in equals the firm amount and is
/// at least the signed minimum, the perp position is flat, and the open package closes with an exit
/// receipt. Exits are not blocked by the entry pause.
#[cfg(feature = "devnet-test-perp")]
fn execute_firm_exit<'info>(
    ctx: Context<'info, ExecuteFirmCashAndCarry<'info>>,
    order_hash: [u8; 32],
    quote_hash: [u8; 32],
    route_hash: [u8; 32],
    args: CashCarryExecutionArgs,
    quote: CashCarryQuoteArgs,
    firm_quote_atoms: u64,
) -> Result<()> {
    require!(
        args.action == CashCarryAction::Exit && !args.recovery && args.spot_sqrt_price_limit == 1,
        ErrorCode::CashCarryQuoteActionInvalid
    );
    validate_firm_quote_args(&args, &quote, firm_quote_atoms)?;
    require!(
        ctx.remaining_accounts.len() <= MAX_FIRM_RISE_EXTRA_ACCOUNTS,
        ErrorCode::CashCarryQuoteAccountMismatch
    );
    let execution_slot = Clock::get()?.slot;
    validate_expiry(execution_slot, args.expiry_slot)?;
    let domain = ctx.accounts.config.domain.clone();
    let open = &ctx.accounts.open_package;
    require!(
        open.version == OPEN_PACKAGE_VERSION && open.trader == ctx.accounts.trader.key(),
        ErrorCode::CashCarryPackageNotOpen
    );
    // The reservation class and quote lock are bound to the active domain; a package opened under
    // an earlier domain exits through the public or recovery path instead.
    require!(
        open.domain == domain,
        ErrorCode::CashCarryOpenPackageMismatch
    );
    let resources = &ctx.accounts.resources;
    let admission = reconstruct_admission(resources, &args, domain.clone())?;
    validate_cash_carry_exit_admission(
        &domain,
        &admission,
        &CashCarryResources {
            spot_adapter: &resources.spot_adapter_record,
            perp_adapter: &resources.perp_adapter_record,
            spot_market: &resources.spot_market_record,
            perp_market: &resources.perp_market_record,
            spot_venue: &resources.spot_venue_record,
            perp_venue: &resources.perp_venue_record,
            base_asset: &resources.base_asset_record,
            quote_asset: &resources.quote_asset_record,
        },
    )?;
    validate_resource_indices(resources, false)?;
    validate_cash_carry_risk_domain(
        &ctx.accounts.risk.risk_domain_index,
        &ctx.accounts.risk.risk_domain_record,
        ctx.accounts.risk.risk_domain_record.key(),
        &resources.quote_asset_record.manifest.identity,
        resources.spot_adapter_record.manifest.identity.subject_id,
        resources.perp_adapter_record.manifest.identity.subject_id,
        &ctx.accounts.open_package,
        &args,
        &domain,
    )?;
    let risk_policy = &ctx.accounts.risk.risk_domain_record.policy;
    let risk_series = risk_policy
        .eligible_series
        .get(usize::from(args.risk_series_index))
        .ok_or_else(|| error!(ErrorCode::RiskDomainSeriesUnsupported))?
        .clone();
    validate_strategy_authority(
        &ctx.accounts.executor_authority,
        &domain,
        ctx.accounts.trader.key(),
        resources.base_asset_record.manifest.subject_address,
        resources.quote_asset_record.manifest.subject_address,
        ctx.accounts.rise_strategy.key(),
    )?;
    validate_firm_accounts(
        &ctx.accounts,
        &quote,
        firm_quote_atoms,
        order_hash,
        quote_hash,
        route_hash,
        &args,
        execution_slot,
    )?;
    validate_quote_series_binding_pair(
        &ctx.accounts.config,
        resources,
        &ctx.accounts.series_index,
        &ctx.accounts.series_record,
        &args,
        &quote,
    )?;
    let economic_commitment = economic_package_commitment(
        &admission,
        &[
            resources.perp_adapter_record.key(),
            resources.perp_market_record.key(),
            resources.perp_venue_record.key(),
            resources.base_asset_record.key(),
            resources.quote_asset_record.key(),
        ],
    );
    let package_commitment = hash_pubkeys(
        PACKAGE_ACCOUNTS_DOMAIN,
        &[
            ctx.accounts.firm.trader_base.key(),
            ctx.accounts.firm.trader_quote.key(),
            ctx.accounts.rise_strategy.key(),
        ],
    );
    validate_open_package_identity(
        &ctx.accounts.open_package,
        ctx.accounts.trader.key(),
        economic_commitment,
        package_commitment,
        args.spot_quantity_atoms,
        args.perp_quantity_atoms,
    )?;
    let quote_account_keys = [
        ctx.accounts.quote_lock.key(),
        ctx.accounts.series_index.key(),
        ctx.accounts.series_record.key(),
    ];
    let quote_evidence = QuoteEvidence {
        intent_commitment: quote_intent_commitment(
            &domain,
            &ctx.accounts.solver.key(),
            &ctx.accounts.quote_lock.key(),
            order_hash,
            quote_hash,
            route_hash,
            &quote,
            &quote_account_keys,
        ),
        fill_commitment: quote.expected_fill_commitment,
    };
    let resource_commitment =
        resource_admission_commitment(&admission, &resource_record_keys(resources));
    let route_commitment = firm_route_accounts_commitment(&ctx);
    let quoted_digest = quoted_execution_digest(
        &domain,
        order_hash,
        quote_hash,
        route_hash,
        &args,
        resource_commitment,
        &firm_execution_account_keys(&ctx),
        quote_evidence,
    );
    let digest = hashv(&[
        FIRM_EXECUTION_DIGEST_DOMAIN,
        &quoted_digest,
        &firm_quote_atoms.to_be_bytes(),
    ])
    .to_bytes();
    require_solver_signature(
        &ctx.accounts.runtime.instructions_sysvar,
        &ctx.accounts.solver.key(),
        &digest,
    )?;
    let (perp_base_lots, perp_limit_ticks, min_spot_quote_out_atoms) =
        execution_units(&admission, resources)?;
    require!(
        firm_quote_atoms >= min_spot_quote_out_atoms,
        ErrorCode::CashCarryPostconditionFailed
    );
    let (pre_rise_base_lots, pre_collateral) =
        perp_position_and_collateral(&ctx.accounts.rise_strategy, &ctx.accounts.rise)?;
    validate_preconditions(&args, pre_rise_base_lots, pre_collateral, perp_base_lots)?;

    let pre_base = ctx.accounts.firm.trader_base.amount;
    let pre_quote = ctx.accounts.firm.trader_quote.amount;
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
    )?;
    move_trader_base_to_executor(&ctx, args.spot_quantity_atoms)?;
    consume_reservation(
        &ctx,
        b"consume_exit_reservation",
        order_hash,
        quote_hash,
        route_hash,
        args.nonce,
    )?;
    ctx.accounts.firm.executor_base.reload()?;
    ctx.accounts.firm.executor_quote.reload()?;
    validate_buy_back_delivery(
        firm_quote_atoms,
        ctx.accounts.firm.executor_base.amount,
        ctx.accounts.firm.executor_quote.amount,
    )?;
    deliver_quote(&ctx, firm_quote_atoms)?;
    ctx.accounts.firm.trader_base.reload()?;
    ctx.accounts.firm.trader_quote.reload()?;
    ctx.accounts.firm.executor_base.reload()?;
    ctx.accounts.firm.executor_quote.reload()?;
    require!(
        ctx.accounts.firm.executor_base.amount == 0 && ctx.accounts.firm.executor_quote.amount == 0,
        ErrorCode::CashCarryPostconditionFailed
    );
    let (post_rise_base_lots, post_collateral) =
        perp_position_and_collateral(&ctx.accounts.rise_strategy, &ctx.accounts.rise)?;
    let spot_quote_delta_atoms = enforce_postconditions(
        &args,
        pre_base,
        ctx.accounts.firm.trader_base.amount,
        pre_quote,
        ctx.accounts.firm.trader_quote.amount,
        pre_rise_base_lots,
        post_rise_base_lots,
        post_collateral,
        perp_base_lots,
        min_spot_quote_out_atoms,
    )?;
    require!(
        spot_quote_delta_atoms == firm_quote_atoms,
        ErrorCode::CashCarryPostconditionFailed
    );
    ctx.accounts.quote_lock.consumed = true;

    let entry_receipt = ctx.accounts.open_package.entry_receipt;
    ctx.accounts.receipt.set_inner(CashCarryExecutionReceipt {
        domain: domain.clone(),
        order_hash,
        quote_hash,
        route_hash,
        trader: ctx.accounts.trader.key(),
        solver: ctx.accounts.solver.key(),
        nonce: args.nonce,
        execution_digest: digest,
        quote_intent_commitment: quote_evidence.intent_commitment,
        package_fill_commitment: quote_evidence.fill_commitment,
        action: args.action.discriminant(),
        recovery: false,
        spot_quantity_atoms: args.spot_quantity_atoms,
        perp_quantity_atoms: args.perp_quantity_atoms,
        spot_quote_delta_atoms,
        pre_base_balance: pre_base,
        post_base_balance: ctx.accounts.firm.trader_base.amount,
        pre_quote_balance: pre_quote,
        post_quote_balance: ctx.accounts.firm.trader_quote.amount,
        pre_rise_base_lots,
        post_rise_base_lots,
        pre_rise_collateral_quote_lots: pre_collateral,
        post_rise_collateral_quote_lots: post_collateral,
        execution_slot,
        resource_admission_commitment: resource_commitment,
        route_accounts_commitment: route_commitment,
        entry_receipt,
        risk_domain_id: args.risk_domain_id,
        risk_policy_version: args.risk_policy_version,
        risk_policy_manifest_hash: risk_policy.manifest_hash,
        risk_series: risk_series.clone(),
        bump: ctx.bumps.receipt,
    });
    ctx.accounts.nonce_marker.set_inner(CashCarryNonce {
        order_hash,
        execution_digest: digest,
        bump: ctx.bumps.nonce_marker,
    });
    emit!(CashCarryExecutionRecorded {
        receipt: ctx.accounts.receipt.key(),
        domain,
        order_hash,
        quote_hash,
        route_hash,
        trader: ctx.accounts.trader.key(),
        solver: ctx.accounts.solver.key(),
        nonce: args.nonce,
        execution_digest: digest,
        quote_intent_commitment: quote_evidence.intent_commitment,
        package_fill_commitment: quote_evidence.fill_commitment,
        action: args.action.discriminant(),
        recovery: false,
        spot_quantity_atoms: args.spot_quantity_atoms,
        perp_quantity_atoms: args.perp_quantity_atoms,
        spot_quote_delta_atoms,
        pre_base_balance: pre_base,
        post_base_balance: ctx.accounts.firm.trader_base.amount,
        pre_quote_balance: pre_quote,
        post_quote_balance: ctx.accounts.firm.trader_quote.amount,
        pre_rise_base_lots,
        post_rise_base_lots,
        pre_rise_collateral_quote_lots: pre_collateral,
        post_rise_collateral_quote_lots: post_collateral,
        execution_slot,
        resource_admission_commitment: resource_commitment,
        route_accounts_commitment: route_commitment,
        entry_receipt,
        risk_domain_id: args.risk_domain_id,
        risk_policy_version: args.risk_policy_version,
        risk_policy_manifest_hash: risk_policy.manifest_hash,
        risk_series,
    });
    ctx.accounts
        .open_package
        .close(ctx.accounts.trader.to_account_info())
}

/// After the buy-back CPI the executor holds exactly the firm quote and no base.
#[cfg_attr(not(feature = "devnet-test-perp"), allow(dead_code))]
fn validate_buy_back_delivery(
    firm_quote_atoms: u64,
    executor_base_atoms: u64,
    executor_quote_atoms: u64,
) -> Result<()> {
    require!(
        firm_quote_atoms != 0
            && executor_base_atoms == 0
            && executor_quote_atoms == firm_quote_atoms,
        ErrorCode::CashCarryPostconditionFailed
    );
    Ok(())
}

#[cfg(feature = "devnet-test-perp")]
fn move_trader_base_to_executor(ctx: &Context<ExecuteFirmCashAndCarry>, amount: u64) -> Result<()> {
    token::transfer(
        CpiContext::new(
            ctx.accounts.runtime.token_program.key(),
            Transfer {
                from: ctx.accounts.firm.trader_base.to_account_info(),
                to: ctx.accounts.firm.executor_base.to_account_info(),
                authority: ctx.accounts.trader.to_account_info(),
            },
        ),
        amount,
    )
}

#[cfg(feature = "devnet-test-perp")]
fn deliver_quote(ctx: &Context<ExecuteFirmCashAndCarry>, amount: u64) -> Result<()> {
    let accounts = &ctx.accounts;
    let trader = accounts.trader.key();
    let strategy = accounts.rise_strategy.key();
    let bump = [accounts.executor_authority.bump];
    let signer: &[&[u8]] = &[
        CASH_CARRY_EXECUTOR_SEED,
        trader.as_ref(),
        strategy.as_ref(),
        bump.as_ref(),
    ];
    token::transfer(
        CpiContext::new_with_signer(
            accounts.runtime.token_program.key(),
            Transfer {
                from: accounts.firm.executor_quote.to_account_info(),
                to: accounts.firm.trader_quote.to_account_info(),
                authority: accounts.executor_authority.to_account_info(),
            },
            &[signer],
        ),
        amount,
    )
}

fn validate_firm_quote_args(
    execution: &CashCarryExecutionArgs,
    quote: &CashCarryQuoteArgs,
    firm_quote_atoms: u64,
) -> Result<()> {
    require!(
        firm_quote_atoms != 0
            && quote.expected_quote_mode == PACKAGE_BOOK_QUOTE_MODE_FIRM_ONCHAIN
            && quote.expected_reservation_policy_hash != [0; 32]
            && quote.reservation_id != [0; 32]
            && quote.package_book_code_identity != [0; 32]
            && quote.series_manifest_hash != [0; 32]
            && quote.execution_class_manifest_hash != [0; 32]
            && quote.expected_settlement_class_identity_hash != [0; 32]
            && quote.expected_fill_commitment != [0; 32]
            && quote.expected_reference_sequence != 0
            && quote.expected_shard_sequence != 0
            && quote.level_id != 0
            && quote.expected_level_sequence != 0
            && quote.expected_side
                == match execution.action {
                    CashCarryAction::Entry => PACKAGE_BOOK_QUOTE_SIDE_ASK,
                    CashCarryAction::Exit => PACKAGE_BOOK_QUOTE_SIDE_BID,
                }
            && quote.package_size_units != 0
            && quote.expected_max_fee_atoms == 0
            && quote.expected_expiry_slot != 0
            && quote.expected_expiry_slot <= execution.expiry_slot,
        ErrorCode::CashCarryQuoteParameterInvalid
    );
    Ok(())
}

fn validate_reservation_delivery(
    expected_base_atoms: u64,
    executor_base_atoms: u64,
    executor_quote_atoms: u64,
) -> Result<()> {
    require!(
        expected_base_atoms != 0
            && executor_base_atoms == expected_base_atoms
            && executor_quote_atoms == 0,
        ErrorCode::CashCarryPostconditionFailed
    );
    Ok(())
}

fn validate_firm_accounts(
    accounts: &ExecuteFirmCashAndCarry,
    quote: &CashCarryQuoteArgs,
    firm_quote_atoms: u64,
    order_hash: [u8; 32],
    quote_hash: [u8; 32],
    route_hash: [u8; 32],
    execution: &CashCarryExecutionArgs,
    current_slot: u64,
) -> Result<()> {
    let resources = &accounts.resources;
    let firm = &accounts.firm;
    require!(
        resources
            .spot_adapter_record
            .manifest
            .adapter_class
            .as_ref()
            .map(|class| class.id.as_str())
            == Some(FIRM_RESERVATION_SPOT_ADAPTER_CLASS_ID),
        ErrorCode::CashCarryResourceAccountMismatch
    );
    let base_mint = resources.base_asset_record.manifest.subject_address;
    let quote_mint = resources.quote_asset_record.manifest.subject_address;
    require!(
        base_mint != quote_mint && firm_quote_atoms != 0,
        ErrorCode::CashCarryTokenAccountMismatch
    );
    require_keys_eq!(
        resources.base_asset_record.manifest.program_id,
        token::ID,
        ErrorCode::CashCarryTokenAccountMismatch
    );
    require_keys_eq!(
        resources.quote_asset_record.manifest.program_id,
        token::ID,
        ErrorCode::CashCarryTokenAccountMismatch
    );
    let exit = execution.action == CashCarryAction::Exit;
    // The solver settlement slot receives quote on entry and the bought-back base on exit; the
    // reservation vault escrows the opposite asset.
    let (solver_settlement_mint, vault_mint, vault_atoms, reservation_action) = if exit {
        (
            base_mint,
            quote_mint,
            firm_quote_atoms,
            RESERVATION_ACTION_EXIT,
        )
    } else {
        (
            quote_mint,
            base_mint,
            execution.spot_quantity_atoms,
            RESERVATION_ACTION_ENTRY,
        )
    };
    for (account, owner, mint) in [
        (&firm.trader_base, accounts.trader.key(), base_mint),
        (&firm.trader_quote, accounts.trader.key(), quote_mint),
        (
            &firm.executor_base,
            accounts.executor_authority.key(),
            base_mint,
        ),
        (
            &firm.executor_quote,
            accounts.executor_authority.key(),
            quote_mint,
        ),
        (
            &firm.solver_quote,
            accounts.solver.key(),
            solver_settlement_mint,
        ),
    ] {
        require_keys_eq!(
            account.owner,
            owner,
            ErrorCode::CashCarryTokenAccountMismatch
        );
        require_keys_eq!(account.mint, mint, ErrorCode::CashCarryTokenAccountMismatch);
        require_keys_eq!(
            account.key(),
            get_associated_token_address(&owner, &mint),
            ErrorCode::CashCarryTokenAccountMismatch
        );
    }
    require!(
        firm.executor_base.amount == 0 && firm.executor_quote.amount == 0,
        ErrorCode::CashCarryTokenAccountMismatch
    );
    require_keys_eq!(
        firm.core_program.key(),
        crate::id(),
        ErrorCode::CashCarryQuoteAccountMismatch
    );
    let core_code = live_program_code_identity(&firm.core_program, &firm.core_program_data)?;
    let reservation_code =
        live_program_code_identity(&firm.reservation_program, &firm.reservation_program_data)?;
    let domain = &accounts.config.domain;
    let domain_identity = hashv(&[
        RESERVATION_DOMAIN_IDENTITY_DOMAIN,
        &domain.canonical_bytes(),
    ])
    .to_bytes();
    let (class, class_bump) = Pubkey::find_program_address(
        &[
            RESERVATION_CLASS_SEED,
            domain_identity.as_ref(),
            domain.domain_manifest_version().to_be_bytes().as_ref(),
            domain.domain_manifest_hash().as_ref(),
            base_mint.as_ref(),
            quote_mint.as_ref(),
            firm.core_program.key().as_ref(),
        ],
        &INVENTORY_RESERVATION_PROGRAM_ID,
    );
    require_keys_eq!(
        firm.reservation_class.key(),
        class,
        ErrorCode::CashCarryQuoteAccountMismatch
    );
    require_keys_eq!(
        *firm.reservation_class.owner,
        INVENTORY_RESERVATION_PROGRAM_ID,
        ErrorCode::CashCarryQuoteAccountMismatch
    );
    let class_data = firm.reservation_class.try_borrow_data()?;
    let discriminator = hashv(&[b"account:ReservationClass"]).to_bytes();
    require!(
        class_data.len() >= 8 && class_data[..8] == discriminator[..8],
        ErrorCode::CashCarryQuoteAccountMismatch
    );
    let class_wire = ReservationClassWire::deserialize(&mut &class_data[8..])
        .map_err(|_| error!(ErrorCode::CashCarryQuoteAccountMismatch))?;
    let policy_hash = reservation_policy_hash(
        firm.reservation_program.key(),
        firm.reservation_program_data.key(),
        reservation_code,
        class,
        RESERVATION_CLASS_VERSION,
        domain,
        base_mint,
        quote_mint,
        firm.core_program.key(),
        firm.core_program_data.key(),
        core_code,
    );
    require!(
        policy_hash == quote.expected_reservation_policy_hash,
        ErrorCode::CashCarryQuoteAccountMismatch
    );
    require!(
        class_wire.version == RESERVATION_CLASS_VERSION
            && class_wire.domain == *domain
            && class_wire.domain_identity == domain_identity
            && class_wire.reservation_program == firm.reservation_program.key()
            && class_wire.reservation_program_data == firm.reservation_program_data.key()
            && class_wire.reservation_code_identity == reservation_code
            && class_wire.policy_hash == policy_hash
            && class_wire.base_mint == base_mint
            && class_wire.quote_mint == quote_mint
            && class_wire.core_program == firm.core_program.key()
            && class_wire.core_program_data == firm.core_program_data.key()
            && class_wire.core_code_identity == core_code
            && class_wire.consumer_program == firm.core_program.key()
            && class_wire.consumer_program_data == firm.core_program_data.key()
            && class_wire.consumer_code_identity == core_code
            && class_wire.max_ttl_slots != 0
            && class_wire.max_base_atoms != 0
            && class_wire.max_solver_reserved_base_atoms >= class_wire.max_base_atoms
            && class_wire.bump == class_bump,
        ErrorCode::CashCarryQuoteAccountMismatch
    );
    let solver = accounts.solver.key();
    let (reservation, reservation_bump) = Pubkey::find_program_address(
        &[
            RESERVATION_SEED,
            class.as_ref(),
            solver.as_ref(),
            quote.reservation_id.as_ref(),
        ],
        &INVENTORY_RESERVATION_PROGRAM_ID,
    );
    let capacity = Pubkey::find_program_address(
        &[RESERVATION_CAPACITY_SEED, class.as_ref(), solver.as_ref()],
        &INVENTORY_RESERVATION_PROGRAM_ID,
    )
    .0;
    let live_pair = Pubkey::find_program_address(
        &[
            LIVE_PAIR_SEED,
            class.as_ref(),
            solver.as_ref(),
            accounts.executor_authority.key().as_ref(),
        ],
        &INVENTORY_RESERVATION_PROGRAM_ID,
    )
    .0;
    let (vault, vault_bump) = Pubkey::find_program_address(
        &[
            RESERVATION_VAULT_SEED,
            class.as_ref(),
            solver.as_ref(),
            quote.reservation_id.as_ref(),
        ],
        &INVENTORY_RESERVATION_PROGRAM_ID,
    );
    require_keys_eq!(
        firm.reservation.key(),
        reservation,
        ErrorCode::CashCarryQuoteAccountMismatch
    );
    require_keys_eq!(
        firm.reservation_capacity.key(),
        capacity,
        ErrorCode::CashCarryQuoteAccountMismatch
    );
    require_keys_eq!(
        firm.live_pair.key(),
        live_pair,
        ErrorCode::CashCarryQuoteAccountMismatch
    );
    require_keys_eq!(
        firm.reservation_vault.key(),
        vault,
        ErrorCode::CashCarryQuoteAccountMismatch
    );
    require_keys_eq!(
        firm.reservation_vault.mint,
        vault_mint,
        ErrorCode::CashCarryTokenAccountMismatch
    );
    require_keys_eq!(
        firm.reservation_vault.owner,
        reservation,
        ErrorCode::CashCarryTokenAccountMismatch
    );
    for account in [
        &firm.reservation_capacity,
        &firm.reservation,
        &firm.live_pair,
    ] {
        require_keys_eq!(
            *account.owner,
            INVENTORY_RESERVATION_PROGRAM_ID,
            ErrorCode::CashCarryQuoteAccountMismatch
        );
    }
    let reservation_data = firm.reservation.try_borrow_data()?;
    let reservation_discriminator = hashv(&[b"account:FirmReservation"]).to_bytes();
    require!(
        reservation_data.len() >= 8 && reservation_data[..8] == reservation_discriminator[..8],
        ErrorCode::CashCarryQuoteAccountMismatch
    );
    let reservation_wire = FirmReservationWire::deserialize(&mut &reservation_data[8..])
        .map_err(|_| error!(ErrorCode::CashCarryQuoteAccountMismatch))?;
    let canonical_id = hashv(&[
        RESERVATION_ID_DOMAIN,
        &domain.canonical_bytes(),
        &reservation_wire.solver_id.canonical_bytes(),
        &order_hash,
        &reservation_wire.reservation_nonce,
    ])
    .to_bytes();
    require!(
        reservation_wire.version == RESERVATION_CLASS_VERSION
            && reservation_wire.reservation_class == class
            && reservation_wire.domain == *domain
            && reservation_wire.reservation_id == quote.reservation_id
            && reservation_wire.reservation_id == canonical_id
            && reservation_wire.reservation_nonce != [0; 32]
            && reservation_wire.solver == solver
            && reservation_wire.strategy_authority == accounts.executor_authority.key()
            && reservation_wire.package_nonce == execution.nonce
            && reservation_wire.order_hash == order_hash
            && reservation_wire.quote_hash == quote_hash
            && reservation_wire.route_hash == route_hash
            && reservation_wire.base_mint == base_mint
            && reservation_wire.quote_mint == quote_mint
            && reservation_wire.solver_reclaim_base
                == get_associated_token_address(&solver, &base_mint)
            && reservation_wire.solver_quote == get_associated_token_address(&solver, &quote_mint)
            && reservation_wire.strategy_base == firm.executor_base.key()
            && reservation_wire.strategy_quote == firm.executor_quote.key()
            && reservation_wire.base_atoms == execution.spot_quantity_atoms
            && reservation_wire.quote_atoms == firm_quote_atoms
            && reservation_wire.expiry_slot == quote.expected_expiry_slot
            && current_slot < reservation_wire.expiry_slot
            && reservation_wire.action == reservation_action
            && reservation_wire.state == ReservationStateWire::Live
            && reservation_wire.bump == reservation_bump
            && reservation_wire.vault_bump == vault_bump
            && firm.reservation_vault.amount == vault_atoms,
        ErrorCode::CashCarryQuoteAccountMismatch
    );
    validate_quote_lock(
        &accounts.quote_lock,
        domain,
        solver,
        reservation,
        policy_hash,
        order_hash,
        quote_hash,
        route_hash,
        execution,
        quote,
        firm_quote_atoms,
        current_slot,
    )?;
    for record in [
        &resources.spot_adapter_record,
        &resources.spot_venue_record,
        &resources.spot_market_record,
    ] {
        verify_code_identity(
            &record.manifest,
            &firm.reservation_program,
            &firm.reservation_program_data,
        )?;
    }
    require_keys_eq!(
        resources.spot_adapter_record.manifest.subject_address,
        firm.reservation_program.key(),
        ErrorCode::CashCarryResourceAccountMismatch
    );
    require_keys_eq!(
        resources.spot_venue_record.manifest.subject_address,
        class,
        ErrorCode::CashCarryResourceAccountMismatch
    );
    require_keys_eq!(
        resources.spot_market_record.manifest.subject_address,
        class,
        ErrorCode::CashCarryResourceAccountMismatch
    );
    verify_code_identity(
        &resources.perp_adapter_record.manifest,
        &accounts.perp_adapter_program,
        &accounts.perp_adapter_program_data,
    )?;
    for record in [&resources.perp_venue_record, &resources.perp_market_record] {
        verify_code_identity(
            &record.manifest,
            &accounts.perp_venue_program,
            &accounts.perp_venue_program_data,
        )?;
    }
    validate_perp_accounts(
        &accounts.rise_strategy,
        &accounts.rise,
        resources.perp_venue_record.manifest.subject_address,
        resources.perp_market_record.manifest.subject_address,
    )
}

#[allow(clippy::too_many_arguments)]
fn validate_quote_lock(
    lock: &FirmQuoteLock,
    domain: &DomainRef,
    solver: Pubkey,
    reservation: Pubkey,
    policy_hash: [u8; 32],
    order_hash: [u8; 32],
    quote_hash: [u8; 32],
    route_hash: [u8; 32],
    execution: &CashCarryExecutionArgs,
    quote: &CashCarryQuoteArgs,
    firm_quote_atoms: u64,
    current_slot: u64,
) -> Result<()> {
    let quote_args_hash = firm_quote_args_hash(quote)?;
    require!(
        !lock.consumed
            && lock.domain == *domain
            && lock.solver == solver
            && lock.reservation == reservation
            && lock.reservation_id == quote.reservation_id
            && lock.reservation_policy_hash == policy_hash
            && lock.order_hash == order_hash
            && lock.quote_hash == quote_hash
            && lock.route_hash == route_hash
            && lock.quote_args_hash == quote_args_hash
            && lock.series_manifest_hash == quote.series_manifest_hash
            && lock.execution_class_manifest_hash == quote.execution_class_manifest_hash
            && lock.fill_commitment == quote.expected_fill_commitment
            && lock.package_size_units == quote.package_size_units
            && lock.base_atoms == execution.spot_quantity_atoms
            && lock.quote_atoms == firm_quote_atoms
            && lock.expiry_slot == quote.expected_expiry_slot
            && current_slot < lock.expiry_slot,
        ErrorCode::CashCarryQuoteAccountMismatch
    );
    Ok(())
}

fn firm_route_accounts_commitment(ctx: &Context<ExecuteFirmCashAndCarry>) -> [u8; 32] {
    let accounts = &ctx.accounts;
    let mut keys = vec![
        accounts.firm.trader_base.key(),
        accounts.firm.trader_quote.key(),
        accounts.firm.executor_base.key(),
        accounts.firm.executor_quote.key(),
        accounts.firm.solver_quote.key(),
        accounts.firm.reservation_class.key(),
        accounts.firm.reservation_capacity.key(),
        accounts.firm.reservation.key(),
        accounts.firm.live_pair.key(),
        accounts.firm.reservation_vault.key(),
        accounts.quote_lock.key(),
        accounts.series_index.key(),
        accounts.series_record.key(),
        accounts.risk.risk_domain_index.key(),
        accounts.risk.risk_domain_record.key(),
        accounts.rise_strategy.key(),
    ];
    keys.extend(perp_venue_account_keys(&accounts.rise));
    keys.extend(ctx.remaining_accounts.iter().map(AccountInfo::key));
    hash_pubkeys(ROUTE_ACCOUNTS_DOMAIN, &keys)
}

fn firm_execution_account_keys(ctx: &Context<ExecuteFirmCashAndCarry>) -> Vec<Pubkey> {
    let accounts = &ctx.accounts;
    let resources = &accounts.resources;
    let mut keys = vec![
        crate::id(),
        accounts.trader.key(),
        accounts.config.key(),
        accounts.solver_registry.key(),
        accounts.risk.risk_domain_index.key(),
        accounts.risk.risk_domain_record.key(),
        accounts.solver.key(),
        accounts.receipt.key(),
        accounts.nonce_marker.key(),
        accounts.open_package.key(),
        accounts.executor_authority.key(),
        resources.spot_adapter_index.key(),
        resources.perp_adapter_index.key(),
        resources.spot_market_index.key(),
        resources.perp_market_index.key(),
        resources.spot_venue_index.key(),
        resources.perp_venue_index.key(),
        resources.base_asset_index.key(),
        resources.quote_asset_index.key(),
    ];
    keys.extend(resource_record_keys(resources));
    keys.extend([
        accounts.firm.reservation_program.key(),
        accounts.firm.reservation_program_data.key(),
        accounts.firm.core_program.key(),
        accounts.firm.core_program_data.key(),
        accounts.perp_adapter_program.key(),
        accounts.perp_adapter_program_data.key(),
        accounts.perp_venue_program.key(),
        accounts.perp_venue_program_data.key(),
        accounts.firm.reservation_class.key(),
        accounts.firm.reservation_capacity.key(),
        accounts.firm.reservation.key(),
        accounts.firm.live_pair.key(),
        accounts.firm.reservation_vault.key(),
        accounts.firm.solver_quote.key(),
        accounts.firm.trader_base.key(),
        accounts.firm.trader_quote.key(),
        accounts.firm.executor_base.key(),
        accounts.firm.executor_quote.key(),
        accounts.quote_lock.key(),
        accounts.series_index.key(),
        accounts.series_record.key(),
        accounts.rise_strategy.key(),
    ]);
    keys.extend(perp_venue_account_keys(&accounts.rise));
    keys.extend([
        accounts.runtime.token_program.key(),
        accounts.runtime.instructions_sysvar.key(),
        accounts.system_program.key(),
    ]);
    keys.extend(ctx.remaining_accounts.iter().map(AccountInfo::key));
    keys
}

fn fund_executor_quote(ctx: &Context<ExecuteFirmCashAndCarry>, amount: u64) -> Result<()> {
    token::transfer(
        CpiContext::new(
            ctx.accounts.runtime.token_program.key(),
            Transfer {
                from: ctx.accounts.firm.trader_quote.to_account_info(),
                to: ctx.accounts.firm.executor_quote.to_account_info(),
                authority: ctx.accounts.trader.to_account_info(),
            },
        ),
        amount,
    )
}

fn consume_reservation(
    ctx: &Context<ExecuteFirmCashAndCarry>,
    instruction_name: &[u8],
    order_hash: [u8; 32],
    quote_hash: [u8; 32],
    route_hash: [u8; 32],
    package_nonce: u64,
) -> Result<()> {
    let accounts = &ctx.accounts;
    let firm = &accounts.firm;
    let mut data = hashv(&[b"global:", instruction_name]).to_bytes()[..8].to_vec();
    ConsumeReservationArgs {
        package_nonce,
        order_hash,
        quote_hash,
        route_hash,
    }
    .serialize(&mut data)?;
    let instruction = Instruction {
        program_id: INVENTORY_RESERVATION_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(accounts.solver.key(), false),
            AccountMeta::new_readonly(accounts.executor_authority.key(), true),
            AccountMeta::new_readonly(firm.core_program.key(), false),
            AccountMeta::new_readonly(firm.core_program_data.key(), false),
            AccountMeta::new_readonly(accounts.config.key(), false),
            AccountMeta::new_readonly(firm.core_program.key(), false),
            AccountMeta::new_readonly(firm.core_program_data.key(), false),
            AccountMeta::new_readonly(firm.reservation_class.key(), false),
            AccountMeta::new(firm.reservation_capacity.key(), false),
            AccountMeta::new(firm.reservation.key(), false),
            AccountMeta::new(firm.live_pair.key(), false),
            AccountMeta::new(firm.reservation_vault.key(), false),
            AccountMeta::new(firm.solver_quote.key(), false),
            AccountMeta::new(firm.executor_base.key(), false),
            AccountMeta::new(firm.executor_quote.key(), false),
            AccountMeta::new_readonly(accounts.runtime.token_program.key(), false),
        ],
        data,
    };
    let trader = accounts.trader.key();
    let strategy = accounts.rise_strategy.key();
    let bump = [accounts.executor_authority.bump];
    let signer: &[&[u8]] = &[
        CASH_CARRY_EXECUTOR_SEED,
        trader.as_ref(),
        strategy.as_ref(),
        bump.as_ref(),
    ];
    invoke_signed(
        &instruction,
        &[
            accounts.solver.to_account_info(),
            accounts.executor_authority.to_account_info(),
            firm.core_program.to_account_info(),
            firm.core_program_data.to_account_info(),
            accounts.config.to_account_info(),
            firm.core_program.to_account_info(),
            firm.core_program_data.to_account_info(),
            firm.reservation_class.to_account_info(),
            firm.reservation_capacity.to_account_info(),
            firm.reservation.to_account_info(),
            firm.live_pair.to_account_info(),
            firm.reservation_vault.to_account_info(),
            firm.solver_quote.to_account_info(),
            firm.executor_base.to_account_info(),
            firm.executor_quote.to_account_info(),
            accounts.runtime.token_program.to_account_info(),
            firm.reservation_program.to_account_info(),
        ],
        &[signer],
    )?;
    Ok(())
}

fn deliver_base(ctx: &Context<ExecuteFirmCashAndCarry>, amount: u64) -> Result<()> {
    let accounts = &ctx.accounts;
    let trader = accounts.trader.key();
    let strategy = accounts.rise_strategy.key();
    let bump = [accounts.executor_authority.bump];
    let signer: &[&[u8]] = &[
        CASH_CARRY_EXECUTOR_SEED,
        trader.as_ref(),
        strategy.as_ref(),
        bump.as_ref(),
    ];
    token::transfer(
        CpiContext::new_with_signer(
            accounts.runtime.token_program.key(),
            Transfer {
                from: accounts.firm.executor_base.to_account_info(),
                to: accounts.firm.trader_base.to_account_info(),
                authority: accounts.executor_authority.to_account_info(),
            },
            &[signer],
        ),
        amount,
    )
}

fn execute_rise<'info>(
    ctx: &Context<'info, ExecuteFirmCashAndCarry<'info>>,
    args: PerpMarketOrderArgs,
    entry: bool,
) -> Result<()> {
    let accounts = &ctx.accounts;
    let trader = accounts.trader.key();
    let strategy = accounts.rise_strategy.key();
    let bump = [accounts.executor_authority.bump];
    let signer: &[&[u8]] = &[
        CASH_CARRY_EXECUTOR_SEED,
        trader.as_ref(),
        strategy.as_ref(),
        bump.as_ref(),
    ];
    invoke_perp_order(
        PerpOrderContext {
            strategy: accounts.rise_strategy.to_account_info(),
            controller: accounts.executor_authority.to_account_info(),
            adapter_program: accounts.perp_adapter_program.key(),
            venue_program: accounts.perp_venue_program.to_account_info(),
            perp: &accounts.rise,
            token_program: accounts.runtime.token_program.to_account_info(),
            remaining_accounts: ctx.remaining_accounts,
        },
        &[signer],
        args,
        entry,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn execution() -> CashCarryExecutionArgs {
        CashCarryExecutionArgs {
            action: CashCarryAction::Entry,
            recovery: false,
            spot_quantity_atoms: 100,
            perp_quantity_atoms: 100,
            spot_limit_quote_atoms_per_base_lot: 10,
            perp_limit_quote_atoms_per_base_lot: 10,
            package_notional_atoms: 1000,
            spot_sqrt_price_limit: 1,
            minimum_rise_collateral_quote_lots: 1,
            client_order_id: 1,
            expiry_slot: 100,
            nonce: 7,
            risk_domain_id: [31; 32],
            risk_policy_version: 1,
            risk_series_index: 0,
            risk_net_quote_atoms: 100,
            risk_margin_quote_atoms: 200,
            risk_recovery_reserve_quote_atoms: 50,
            risk_observation_age_ms: 100,
            risk_time_to_unwind_ms: 2_000,
        }
    }

    fn quote() -> CashCarryQuoteArgs {
        CashCarryQuoteArgs {
            package_book_code_identity: [1; 32],
            series_manifest_hash: [2; 32],
            execution_class_manifest_hash: [3; 32],
            expected_reference_sequence: 1,
            expected_shard_sequence: 1,
            slot_index: 0,
            level_id: 1,
            expected_level_sequence: 1,
            expected_side: PACKAGE_BOOK_QUOTE_SIDE_ASK,
            package_size_units: 1,
            expected_package_price: 5,
            expected_max_fee_atoms: 0,
            expected_expiry_slot: 99,
            expected_settlement_class_identity_hash: [4; 32],
            expected_quote_mode: PACKAGE_BOOK_QUOTE_MODE_FIRM_ONCHAIN,
            expected_reservation_policy_hash: [5; 32],
            reservation_id: [6; 32],
            expected_fill_commitment: [7; 32],
        }
    }

    #[test]
    fn firm_quote_requires_pinned_policy_reservation_and_expiry() {
        let execution = execution();
        let valid = quote();
        assert!(validate_firm_quote_args(&execution, &valid, 25).is_ok());
        let mut wrong = valid.clone();
        wrong.expected_quote_mode = 1;
        assert!(validate_firm_quote_args(&execution, &wrong, 25).is_err());
        wrong = valid.clone();
        wrong.expected_reservation_policy_hash = [0; 32];
        assert!(validate_firm_quote_args(&execution, &wrong, 25).is_err());
        wrong = valid.clone();
        wrong.reservation_id = [0; 32];
        assert!(validate_firm_quote_args(&execution, &wrong, 25).is_err());
        wrong = valid.clone();
        wrong.expected_expiry_slot = 101;
        assert!(validate_firm_quote_args(&execution, &wrong, 25).is_err());
        assert!(validate_firm_quote_args(&execution, &valid, 0).is_err());
    }

    #[test]
    fn reservation_delivery_requires_exact_base_and_zero_quote_residual() {
        assert!(validate_reservation_delivery(100, 100, 0).is_ok());
        assert!(validate_reservation_delivery(100, 99, 0).is_err());
        assert!(validate_reservation_delivery(100, 101, 0).is_err());
        assert!(validate_reservation_delivery(100, 100, 1).is_err());
        assert!(validate_reservation_delivery(0, 0, 0).is_err());
    }

    #[test]
    fn quote_lock_binds_reservation_quote_amount_and_one_time_entry() {
        let domain = DomainRef::new("solana:test", 1, [1; 32]).unwrap();
        let solver = Pubkey::new_unique();
        let reservation = Pubkey::new_unique();
        let execution = execution();
        let quote = quote();
        let order_hash = [8; 32];
        let quote_hash = [9; 32];
        let route_hash = [10; 32];
        let mut lock = FirmQuoteLock {
            domain: domain.clone(),
            solver,
            reservation,
            reservation_id: quote.reservation_id,
            reservation_policy_hash: quote.expected_reservation_policy_hash,
            order_hash,
            quote_hash,
            route_hash,
            quote_args_hash: firm_quote_args_hash(&quote).unwrap(),
            series_manifest_hash: quote.series_manifest_hash,
            execution_class_manifest_hash: quote.execution_class_manifest_hash,
            fill_commitment: quote.expected_fill_commitment,
            package_size_units: quote.package_size_units,
            base_atoms: execution.spot_quantity_atoms,
            quote_atoms: 25,
            expiry_slot: quote.expected_expiry_slot,
            consumed: false,
            bump: 1,
        };
        let check = |lock: &FirmQuoteLock, quote: &CashCarryQuoteArgs, amount: u64, slot: u64| {
            validate_quote_lock(
                lock,
                &domain,
                solver,
                reservation,
                quote.expected_reservation_policy_hash,
                order_hash,
                quote_hash,
                route_hash,
                &execution,
                quote,
                amount,
                slot,
            )
        };
        assert!(check(&lock, &quote, 25, 98).is_ok());
        assert!(check(&lock, &quote, 24, 98).is_err());
        assert!(check(&lock, &quote, 25, 99).is_err());
        let mut changed_quote = quote.clone();
        changed_quote.expected_package_price += 1;
        assert!(check(&lock, &changed_quote, 25, 98).is_err());
        lock.route_hash = [11; 32];
        assert!(check(&lock, &quote, 25, 98).is_err());
        lock.route_hash = route_hash;
        lock.consumed = true;
        assert!(check(&lock, &quote, 25, 98).is_err());
    }

    #[test]
    fn firm_exit_requires_bid_and_exact_buy_back_delivery() {
        let mut exit = execution();
        exit.action = CashCarryAction::Exit;
        let mut bid = quote();
        bid.expected_side = PACKAGE_BOOK_QUOTE_SIDE_BID;
        assert!(validate_firm_quote_args(&exit, &bid, 25).is_ok());
        assert!(validate_firm_quote_args(&exit, &quote(), 25).is_err());
        assert!(validate_firm_quote_args(&execution(), &bid, 25).is_err());
        assert!(validate_buy_back_delivery(25, 0, 25).is_ok());
        assert!(validate_buy_back_delivery(25, 0, 24).is_err());
        assert!(validate_buy_back_delivery(25, 0, 26).is_err());
        assert!(validate_buy_back_delivery(25, 1, 25).is_err());
        assert!(validate_buy_back_delivery(0, 0, 0).is_err());
    }

    #[cfg(not(feature = "devnet-test-perp"))]
    #[test]
    fn firm_rise_account_limit_reserves_auxiliary_programs() {
        assert_eq!(FIRM_FIXED_ACCOUNT_COUNT, 59);
        assert_eq!(FIRM_AUXILIARY_PROGRAM_COUNT, 2);
        assert_eq!(MAX_FIRM_RISE_EXTRA_ACCOUNTS, 3);
        assert_eq!(
            FIRM_FIXED_ACCOUNT_COUNT + FIRM_AUXILIARY_PROGRAM_COUNT + MAX_FIRM_RISE_EXTRA_ACCOUNTS,
            64
        );
    }
}

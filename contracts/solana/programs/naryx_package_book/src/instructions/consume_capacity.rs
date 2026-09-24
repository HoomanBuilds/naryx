use anchor_lang::{prelude::*, solana_program::program::set_return_data};
use naryx_core::{
    constants::PROTOCOL_CONFIG_SEED, program::NaryxCore, state::ProtocolConfig, DomainRef,
    ProtocolId,
};
use solana_sha256_hasher::hashv;

use crate::{
    constants::{
        FILL_COMMITMENT_DOMAIN, LEVEL_ACTIVE, MAX_QUOTE_LEVELS, PACKAGE_BOOK_CLASS_SEED,
        PACKAGE_BOOK_VERSION, PACKAGE_QUOTE_SHARD_SEED, QUOTE_LEVEL_PAGE_SEED,
        QUOTE_MODE_EXECUTION_COMMITMENT, QUOTE_MODE_FIRM_ONCHAIN,
    },
    error::ErrorCode,
    events::PackageFillCommitted,
    instructions::verify_program_identities,
    state::{PackageBookClass, PackageQuoteShard, QuoteLevel, QuoteLevelPage},
};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct ConsumeCapacityArgs {
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
    pub order_hash: [u8; 32],
    pub quote_hash: [u8; 32],
    pub route_hash: [u8; 32],
}

#[derive(Accounts)]
pub struct ConsumeCapacity<'info> {
    pub consumer_authority: Signer<'info>,
    pub core_program: Program<'info, NaryxCore>,
    /// CHECK: Pinned code identity is checked against live ProgramData bytes.
    pub core_program_data: UncheckedAccount<'info>,
    #[account(
        seeds = [PROTOCOL_CONFIG_SEED],
        bump = protocol_config.bump,
        seeds::program = core_program.key()
    )]
    pub protocol_config: Box<Account<'info, ProtocolConfig>>,
    /// CHECK: Exact executable program and code identity are checked.
    pub consumer_program: UncheckedAccount<'info>,
    /// CHECK: Pinned code identity is checked against live ProgramData bytes.
    pub consumer_program_data: UncheckedAccount<'info>,
    #[account(
        seeds = [
            PACKAGE_BOOK_CLASS_SEED,
            package_book_class.domain_identity_hash.as_ref(),
            package_book_class.domain_manifest_version.to_le_bytes().as_ref(),
            package_book_class.domain_manifest_hash.as_ref()
        ],
        bump = package_book_class.bump
    )]
    pub package_book_class: Box<Account<'info, PackageBookClass>>,
    #[account(
        mut,
        seeds = [
            PACKAGE_QUOTE_SHARD_SEED,
            package_book_class.key().as_ref(),
            shard.solver.as_ref(),
            shard.series_manifest_hash.as_ref(),
            shard.execution_class_manifest_hash.as_ref()
        ],
        bump = shard.bump,
        has_one = package_book_class
    )]
    pub shard: Box<Account<'info, PackageQuoteShard>>,
    #[account(
        mut,
        seeds = [QUOTE_LEVEL_PAGE_SEED, shard.key().as_ref()],
        bump = shard.level_page_bump
    )]
    pub level_page: AccountLoader<'info, QuoteLevelPage>,
}

#[allow(clippy::too_many_arguments)]
pub fn fill_commitment(
    domain: &DomainRef,
    shard_key: &Pubkey,
    solver: &Pubkey,
    solver_id: &ProtocolId,
    consumer_authority: &Pubkey,
    series_manifest_hash: &[u8; 32],
    execution_class_manifest_hash: &[u8; 32],
    reference_state_hash: &[u8; 32],
    level: &QuoteLevel,
    reference_sequence: u64,
    shard_sequence: u64,
    package_size_units: u64,
    package_price: i128,
    reservation_id: &[u8; 32],
    order_hash: &[u8; 32],
    quote_hash: &[u8; 32],
    route_hash: &[u8; 32],
) -> [u8; 32] {
    let domain_bytes = domain.canonical_bytes();
    let solver_id_bytes = solver_id.canonical_bytes();
    let mut bytes = Vec::with_capacity(
        FILL_COMMITMENT_DOMAIN.len()
            + domain_bytes.len()
            + solver_id_bytes.len()
            + 32 * 12
            + 8 * 7
            + 16
            + 2,
    );
    bytes.extend_from_slice(FILL_COMMITMENT_DOMAIN);
    bytes.extend_from_slice(&domain_bytes);
    bytes.extend_from_slice(shard_key.as_ref());
    bytes.extend_from_slice(solver.as_ref());
    bytes.extend_from_slice(&solver_id_bytes);
    bytes.extend_from_slice(consumer_authority.as_ref());
    bytes.extend_from_slice(series_manifest_hash);
    bytes.extend_from_slice(execution_class_manifest_hash);
    bytes.extend_from_slice(reference_state_hash);
    bytes.extend_from_slice(&level.level_id.to_be_bytes());
    bytes.extend_from_slice(&level.level_sequence.to_be_bytes());
    bytes.extend_from_slice(&reference_sequence.to_be_bytes());
    bytes.extend_from_slice(&shard_sequence.to_be_bytes());
    bytes.extend_from_slice(&level.epoch.to_be_bytes());
    bytes.push(level.side);
    bytes.extend_from_slice(&package_size_units.to_be_bytes());
    bytes.extend_from_slice(&package_price.to_be_bytes());
    bytes.extend_from_slice(&level.max_fee_atoms.to_be_bytes());
    bytes.extend_from_slice(&level.settlement_class_identity_hash);
    bytes.push(level.quote_mode);
    bytes.extend_from_slice(&level.reservation_policy_hash);
    bytes.extend_from_slice(reservation_id);
    bytes.extend_from_slice(order_hash);
    bytes.extend_from_slice(quote_hash);
    bytes.extend_from_slice(route_hash);
    hashv(&[bytes.as_ref()]).to_bytes()
}

pub fn validate_level_expectations(
    level: &QuoteLevel,
    args: &ConsumeCapacityArgs,
    package_price: i128,
    firm_onchain_enabled: bool,
) -> Result<()> {
    require!(
        level.level_sequence == args.expected_level_sequence
            && level.side == args.expected_side
            && level.expiry_slot == args.expected_expiry_slot
            && level.settlement_class_identity_hash == args.expected_settlement_class_identity_hash
            && level.quote_mode == args.expected_quote_mode
            && level.reservation_policy_hash == args.expected_reservation_policy_hash
            && package_price == args.expected_package_price
            && level.max_fee_atoms == args.expected_max_fee_atoms,
        ErrorCode::AccountBindingMismatch
    );
    match level.quote_mode {
        QUOTE_MODE_EXECUTION_COMMITMENT => require!(
            args.reservation_id == [0u8; 32],
            ErrorCode::ReservationIdInvalid
        ),
        QUOTE_MODE_FIRM_ONCHAIN => {
            require!(firm_onchain_enabled, ErrorCode::FirmOnchainDisabled);
            require!(
                args.reservation_id != [0u8; 32],
                ErrorCode::ReservationIdInvalid
            );
        }
        _ => return err!(ErrorCode::QuoteModeUnsupported),
    }
    Ok(())
}

pub fn handler(ctx: Context<ConsumeCapacity>, args: ConsumeCapacityArgs) -> Result<()> {
    let class = &ctx.accounts.package_book_class;
    let shard = &mut ctx.accounts.shard;
    require!(
        class.version == PACKAGE_BOOK_VERSION && shard.is_v1(),
        ErrorCode::ClassParameterInvalid
    );
    require!(
        shard.domain == class.domain
            && shard.core_program == class.core_program
            && shard.core_program_data == class.core_program_data
            && shard.core_code_identity == class.core_code_identity
            && shard.consumer_program == class.consumer_program
            && shard.consumer_program_data == class.consumer_program_data
            && shard.consumer_code_identity == class.consumer_code_identity,
        ErrorCode::AccountBindingMismatch
    );
    verify_program_identities(
        shard,
        &ctx.accounts.core_program.to_account_info(),
        &ctx.accounts.core_program_data,
        &ctx.accounts.consumer_program,
        &ctx.accounts.consumer_program_data,
    )?;
    require!(
        ctx.accounts.protocol_config.domain == shard.domain,
        ErrorCode::DomainInactive
    );
    require!(
        ctx.accounts.consumer_authority.to_account_info().owner == &shard.consumer_program
            && !ctx.accounts.consumer_authority.key().is_on_curve(),
        ErrorCode::ConsumerAuthorityInvalid
    );
    require!(!shard.killed, ErrorCode::ShardKilled);
    let current_slot = Clock::get()?.slot;
    shard.validate_fresh(current_slot)?;
    require!(
        args.expected_reference_sequence == shard.reference_sequence,
        ErrorCode::SequenceMismatch
    );
    require!(
        args.order_hash != [0u8; 32]
            && args.quote_hash != [0u8; 32]
            && args.route_hash != [0u8; 32],
        ErrorCode::CommitmentZero
    );
    let index = usize::from(args.slot_index);
    require!(index < MAX_QUOTE_LEVELS, ErrorCode::LevelSlotInvalid);
    let mut level_page = ctx.accounts.level_page.load_mut()?;
    require!(
        level_page.version == PACKAGE_BOOK_VERSION && level_page.shard == shard.key(),
        ErrorCode::AccountBindingMismatch
    );
    let level = level_page.levels[index];
    require!(
        level.active == LEVEL_ACTIVE
            && level.epoch == shard.epoch
            && level.level_id == args.level_id
            && level.level_sequence == args.expected_level_sequence,
        ErrorCode::LevelInactive
    );
    let package_price = shard
        .reference_package_price
        .checked_add(level.reference_offset)
        .ok_or_else(|| error!(ErrorCode::ArithmeticFailure))?;
    validate_level_expectations(&level, &args, package_price, class.firm_onchain_enabled)?;
    let next_shard_sequence = shard.next_shard_sequence(args.expected_shard_sequence)?;
    let consumed_level = shard.consume_level(
        &mut level_page.levels,
        args.slot_index,
        args.level_id,
        args.expected_level_sequence,
        args.package_size_units,
        current_slot,
    )?;
    shard.shard_sequence = next_shard_sequence;
    let commitment = fill_commitment(
        &shard.domain,
        &shard.key(),
        &shard.solver,
        &shard.solver_id,
        &ctx.accounts.consumer_authority.key(),
        &shard.series_manifest_hash,
        &shard.execution_class_manifest_hash,
        &shard.reference_state_hash,
        &consumed_level,
        shard.reference_sequence,
        shard.shard_sequence,
        args.package_size_units,
        package_price,
        &args.reservation_id,
        &args.order_hash,
        &args.quote_hash,
        &args.route_hash,
    );
    emit!(PackageFillCommitted {
        fill_commitment: commitment,
        domain: shard.domain.clone(),
        shard: shard.key(),
        solver: shard.solver,
        consumer_authority: ctx.accounts.consumer_authority.key(),
        series_manifest_hash: shard.series_manifest_hash,
        execution_class_manifest_hash: shard.execution_class_manifest_hash,
        level_id: consumed_level.level_id,
        level_sequence: consumed_level.level_sequence,
        reference_sequence: shard.reference_sequence,
        shard_sequence: shard.shard_sequence,
        epoch: consumed_level.epoch,
        side: consumed_level.side,
        package_size_units: args.package_size_units,
        package_price,
        max_fee_atoms: consumed_level.max_fee_atoms,
        settlement_class_identity_hash: consumed_level.settlement_class_identity_hash,
        quote_mode: consumed_level.quote_mode,
        reservation_policy_hash: consumed_level.reservation_policy_hash,
        reservation_id: args.reservation_id,
        order_hash: args.order_hash,
        quote_hash: args.quote_hash,
        route_hash: args.route_hash,
    });
    set_return_data(&commitment);
    Ok(())
}

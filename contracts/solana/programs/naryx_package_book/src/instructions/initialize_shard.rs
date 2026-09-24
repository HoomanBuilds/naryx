use anchor_lang::prelude::*;
use naryx_core::{
    constants::PROTOCOL_CONFIG_SEED, program::NaryxCore, state::ProtocolConfig, ProtocolId,
};

use crate::{
    constants::{
        MAX_QUOTE_LEVELS, PACKAGE_BOOK_CLASS_SEED, PACKAGE_BOOK_VERSION, PACKAGE_QUOTE_SHARD_SEED,
        QUOTE_LEVEL_PAGE_SEED,
    },
    error::ErrorCode,
    events::PackageQuoteShardInitialized,
    instructions::live_code_identity,
    state::{PackageBookClass, PackageQuoteShard, QuoteLevel, QuoteLevelPage},
};

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InitializeShardArgs {
    pub solver_id: ProtocolId,
    pub series_manifest_hash: [u8; 32],
    pub execution_class_manifest_hash: [u8; 32],
    pub reference_package_price: i128,
    pub reference_state_hash: [u8; 32],
    pub heartbeat_expiry_slot: u64,
}

#[derive(Accounts)]
#[instruction(args: InitializeShardArgs)]
pub struct InitializeShard<'info> {
    #[account(mut)]
    pub solver: Signer<'info>,
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
        init,
        payer = solver,
        space = 8 + PackageQuoteShard::INIT_SPACE,
        seeds = [
            PACKAGE_QUOTE_SHARD_SEED,
            package_book_class.key().as_ref(),
            solver.key().as_ref(),
            args.series_manifest_hash.as_ref(),
            args.execution_class_manifest_hash.as_ref()
        ],
        bump
    )]
    pub shard: Box<Account<'info, PackageQuoteShard>>,
    #[account(
        init,
        payer = solver,
        space = 8 + core::mem::size_of::<QuoteLevelPage>(),
        seeds = [QUOTE_LEVEL_PAGE_SEED, shard.key().as_ref()],
        bump
    )]
    pub level_page: AccountLoader<'info, QuoteLevelPage>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<InitializeShard>, args: InitializeShardArgs) -> Result<()> {
    let class = &ctx.accounts.package_book_class;
    require!(
        class.version == PACKAGE_BOOK_VERSION,
        ErrorCode::ClassParameterInvalid
    );
    require!(
        ctx.accounts.protocol_config.domain == class.domain,
        ErrorCode::DomainInactive
    );
    require_keys_eq!(
        ctx.accounts.core_program.key(),
        class.core_program,
        ErrorCode::AccountBindingMismatch
    );
    require_keys_eq!(
        ctx.accounts.core_program_data.key(),
        class.core_program_data,
        ErrorCode::CodeIdentityMismatch
    );
    require!(
        live_code_identity(
            &ctx.accounts.core_program.to_account_info(),
            &ctx.accounts.core_program_data,
        )? == class.core_code_identity,
        ErrorCode::CodeIdentityMismatch
    );
    require_keys_eq!(
        ctx.accounts.consumer_program.key(),
        class.consumer_program,
        ErrorCode::AccountBindingMismatch
    );
    require_keys_eq!(
        ctx.accounts.consumer_program_data.key(),
        class.consumer_program_data,
        ErrorCode::CodeIdentityMismatch
    );
    require!(
        live_code_identity(
            &ctx.accounts.consumer_program,
            &ctx.accounts.consumer_program_data,
        )? == class.consumer_code_identity,
        ErrorCode::CodeIdentityMismatch
    );
    require!(
        !args.solver_id.as_str().is_empty()
            && args.solver_id.as_str().is_ascii()
            && args.solver_id.as_str().len() <= naryx_core::wire::PROTOCOL_ID_MAX_BYTES,
        ErrorCode::SolverIdInvalid
    );
    require!(
        args.series_manifest_hash != [0u8; 32] && args.execution_class_manifest_hash != [0u8; 32],
        ErrorCode::IdentityHashZero
    );
    require!(
        args.reference_state_hash != [0u8; 32],
        ErrorCode::ReferenceStateHashZero
    );
    class.validate_reference_price(args.reference_package_price)?;
    class.validate_heartbeat(Clock::get()?.slot, args.heartbeat_expiry_slot)?;

    let shard_key = ctx.accounts.shard.key();
    ctx.accounts.shard.set_inner(PackageQuoteShard {
        version: PACKAGE_BOOK_VERSION,
        domain: class.domain.clone(),
        package_book_class: class.key(),
        solver: ctx.accounts.solver.key(),
        solver_id: args.solver_id,
        series_manifest_hash: args.series_manifest_hash,
        execution_class_manifest_hash: args.execution_class_manifest_hash,
        core_program: class.core_program,
        core_program_data: class.core_program_data,
        core_code_identity: class.core_code_identity,
        consumer_program: class.consumer_program,
        consumer_program_data: class.consumer_program_data,
        consumer_code_identity: class.consumer_code_identity,
        reference_package_price: args.reference_package_price,
        reference_state_hash: args.reference_state_hash,
        reference_sequence: 1,
        shard_sequence: 1,
        heartbeat_expiry_slot: args.heartbeat_expiry_slot,
        epoch: 1,
        killed: false,
        level_count: 0,
        level_page_bump: ctx.bumps.level_page,
        bump: ctx.bumps.shard,
    });
    let mut page = ctx.accounts.level_page.load_init()?;
    page.shard = shard_key;
    page.version = PACKAGE_BOOK_VERSION;
    page.bump = ctx.bumps.level_page;
    page.reserved = [0u8; 13];
    page.levels = [QuoteLevel::EMPTY; MAX_QUOTE_LEVELS];
    emit!(PackageQuoteShardInitialized {
        shard: shard_key,
        solver: ctx.accounts.solver.key(),
        series_manifest_hash: args.series_manifest_hash,
        execution_class_manifest_hash: args.execution_class_manifest_hash,
    });
    Ok(())
}

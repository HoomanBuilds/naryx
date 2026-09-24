use anchor_lang::prelude::*;
use naryx_core::{constants::PROTOCOL_CONFIG_SEED, program::NaryxCore, state::ProtocolConfig};

use crate::{
    constants::{PACKAGE_BOOK_CLASS_SEED, PACKAGE_BOOK_VERSION},
    error::ErrorCode,
    instructions::live_code_identity,
    program::NaryxPackageBook,
    state::{domain_ref_identity, PackageBookClass},
};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct InitializeClassArgs {
    pub domain_identity_hash: [u8; 32],
    pub domain_manifest_version: u32,
    pub domain_manifest_hash: [u8; 32],
    pub max_heartbeat_ttl_slots: u64,
    pub max_level_ttl_slots: u64,
    pub max_abs_reference_price: i128,
    pub max_abs_reference_offset: i128,
    pub max_fee_atoms: u64,
    pub firm_onchain_enabled: bool,
}

#[derive(Accounts)]
#[instruction(args: InitializeClassArgs)]
pub struct InitializeClass<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub initializer: Signer<'info>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key()))]
    pub program: Program<'info, NaryxPackageBook>,
    #[account(constraint = program_data.upgrade_authority_address == Some(initializer.key()))]
    pub program_data: Account<'info, ProgramData>,
    pub core_program: Program<'info, NaryxCore>,
    /// CHECK: Upgradeable loader ownership, deterministic address, and bytes are checked.
    pub core_program_data: UncheckedAccount<'info>,
    #[account(
        seeds = [PROTOCOL_CONFIG_SEED],
        bump = protocol_config.bump,
        seeds::program = core_program.key()
    )]
    pub protocol_config: Box<Account<'info, ProtocolConfig>>,
    /// CHECK: Executability, loader ownership, and ProgramData are checked.
    pub consumer_program: UncheckedAccount<'info>,
    /// CHECK: Upgradeable loader ownership, deterministic address, and bytes are checked.
    pub consumer_program_data: UncheckedAccount<'info>,
    #[account(
        init,
        payer = payer,
        space = 8 + PackageBookClass::INIT_SPACE,
        seeds = [
            PACKAGE_BOOK_CLASS_SEED,
            args.domain_identity_hash.as_ref(),
            args.domain_manifest_version.to_le_bytes().as_ref(),
            args.domain_manifest_hash.as_ref()
        ],
        bump
    )]
    pub package_book_class: Box<Account<'info, PackageBookClass>>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<InitializeClass>, args: InitializeClassArgs) -> Result<()> {
    require!(
        args.domain_manifest_version
            == ctx
                .accounts
                .protocol_config
                .domain
                .domain_manifest_version()
            && args.domain_manifest_hash
                == ctx.accounts.protocol_config.domain.domain_manifest_hash(),
        ErrorCode::DomainInactive
    );
    require!(
        args.domain_identity_hash == domain_ref_identity(&ctx.accounts.protocol_config.domain),
        ErrorCode::DomainInactive
    );
    require!(
        args.max_heartbeat_ttl_slots != 0
            && args.max_level_ttl_slots != 0
            && args.max_level_ttl_slots <= args.max_heartbeat_ttl_slots
            && args.max_abs_reference_price > 0
            && args.max_abs_reference_offset > 0,
        ErrorCode::ClassParameterInvalid
    );
    args.max_abs_reference_price
        .checked_add(args.max_abs_reference_offset)
        .ok_or_else(|| error!(ErrorCode::ClassParameterInvalid))?;
    let core_code_identity = live_code_identity(
        &ctx.accounts.core_program.to_account_info(),
        &ctx.accounts.core_program_data,
    )?;
    let consumer_code_identity = live_code_identity(
        &ctx.accounts.consumer_program,
        &ctx.accounts.consumer_program_data,
    )?;
    if args.firm_onchain_enabled {
        require_keys_eq!(
            ctx.accounts.consumer_program.key(),
            ctx.accounts.core_program.key(),
            ErrorCode::ClassParameterInvalid
        );
        require_keys_eq!(
            ctx.accounts.consumer_program_data.key(),
            ctx.accounts.core_program_data.key(),
            ErrorCode::ClassParameterInvalid
        );
        require!(
            consumer_code_identity == core_code_identity,
            ErrorCode::CodeIdentityMismatch
        );
    }
    ctx.accounts.package_book_class.set_inner(PackageBookClass {
        version: PACKAGE_BOOK_VERSION,
        domain: ctx.accounts.protocol_config.domain.clone(),
        domain_identity_hash: args.domain_identity_hash,
        domain_manifest_version: args.domain_manifest_version,
        domain_manifest_hash: args.domain_manifest_hash,
        core_program: ctx.accounts.core_program.key(),
        core_program_data: ctx.accounts.core_program_data.key(),
        core_code_identity,
        consumer_program: ctx.accounts.consumer_program.key(),
        consumer_program_data: ctx.accounts.consumer_program_data.key(),
        consumer_code_identity,
        max_heartbeat_ttl_slots: args.max_heartbeat_ttl_slots,
        max_level_ttl_slots: args.max_level_ttl_slots,
        max_abs_reference_price: args.max_abs_reference_price,
        max_abs_reference_offset: args.max_abs_reference_offset,
        max_fee_atoms: args.max_fee_atoms,
        firm_onchain_enabled: args.firm_onchain_enabled,
        bump: ctx.bumps.package_book_class,
    });
    Ok(())
}

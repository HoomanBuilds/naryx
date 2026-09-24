use anchor_lang::prelude::*;
use anchor_spl::token::Mint;
use naryx_core::{constants::PROTOCOL_CONFIG_SEED, program::NaryxCore, state::ProtocolConfig};

use crate::{
    constants::{RESERVATION_CLASS_SEED, RESERVATION_VERSION},
    error::ErrorCode,
    instructions::{domain_ref_identity, live_code_identity},
    program::NaryxInventoryReservation,
    state::ReservationClass,
};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct InitializeClassArgs {
    pub domain_identity: [u8; 32],
    pub max_ttl_slots: u64,
    pub max_base_atoms: u64,
    pub max_solver_reserved_base_atoms: u64,
}

#[derive(Accounts)]
#[instruction(args: InitializeClassArgs)]
pub struct InitializeClass<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub initializer: Signer<'info>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key()))]
    pub program: Program<'info, NaryxInventoryReservation>,
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
    /// CHECK: Executability, upgradeable loader ownership, and ProgramData are checked.
    pub consumer_program: UncheckedAccount<'info>,
    /// CHECK: Upgradeable loader ownership, deterministic address, and bytes are checked.
    pub consumer_program_data: UncheckedAccount<'info>,
    pub base_mint: Box<Account<'info, Mint>>,
    pub quote_mint: Box<Account<'info, Mint>>,
    #[account(
        init,
        payer = payer,
        space = 8 + ReservationClass::INIT_SPACE,
        seeds = [
            RESERVATION_CLASS_SEED,
            args.domain_identity.as_ref(),
            protocol_config.domain.domain_manifest_version().to_be_bytes().as_ref(),
            protocol_config.domain.domain_manifest_hash().as_ref(),
            base_mint.key().as_ref(),
            quote_mint.key().as_ref(),
            consumer_program.key().as_ref()
        ],
        bump
    )]
    pub reservation_class: Box<Account<'info, ReservationClass>>,
    pub system_program: Program<'info, System>,
}

pub fn initialize_class_handler(
    ctx: Context<InitializeClass>,
    args: InitializeClassArgs,
) -> Result<()> {
    require!(
        args.domain_identity == domain_ref_identity(&ctx.accounts.protocol_config.domain),
        ErrorCode::ClassParameterInvalid
    );
    require_keys_neq!(
        ctx.accounts.base_mint.key(),
        ctx.accounts.quote_mint.key(),
        ErrorCode::ClassParameterInvalid
    );
    require!(
        args.max_ttl_slots != 0
            && args.max_base_atoms != 0
            && args.max_solver_reserved_base_atoms >= args.max_base_atoms,
        ErrorCode::ClassParameterInvalid
    );

    let core_code_identity = live_code_identity(
        &ctx.accounts.core_program.to_account_info(),
        &ctx.accounts.core_program_data,
    )?;
    let consumer_code_identity = live_code_identity(
        &ctx.accounts.consumer_program,
        &ctx.accounts.consumer_program_data,
    )?;

    ctx.accounts.reservation_class.set_inner(ReservationClass {
        version: RESERVATION_VERSION,
        domain: ctx.accounts.protocol_config.domain.clone(),
        domain_identity: args.domain_identity,
        base_mint: ctx.accounts.base_mint.key(),
        quote_mint: ctx.accounts.quote_mint.key(),
        core_program: ctx.accounts.core_program.key(),
        core_program_data: ctx.accounts.core_program_data.key(),
        core_code_identity,
        consumer_program: ctx.accounts.consumer_program.key(),
        consumer_program_data: ctx.accounts.consumer_program_data.key(),
        consumer_code_identity,
        max_ttl_slots: args.max_ttl_slots,
        max_base_atoms: args.max_base_atoms,
        max_solver_reserved_base_atoms: args.max_solver_reserved_base_atoms,
        bump: ctx.bumps.reservation_class,
    });
    Ok(())
}

use anchor_lang::prelude::*;
use anchor_spl::token::{self, CloseAccount, Token, TokenAccount, Transfer};
use naryx_core::{constants::PROTOCOL_CONFIG_SEED, program::NaryxCore, state::ProtocolConfig};

use crate::{
    constants::{
        LIVE_PAIR_SEED, RESERVATION_CAPACITY_SEED, RESERVATION_CLASS_SEED, RESERVATION_SEED,
        RESERVATION_VAULT_SEED,
    },
    error::ErrorCode,
    events::ReservationConsumed,
    instructions::{verify_consumer_identity, verify_core_identity},
    state::{
        validate_entry_deltas, FirmReservation, LivePair, ReservationCapacity, ReservationClass,
    },
};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct ConsumeReservationArgs {
    pub package_nonce: u64,
    pub order_hash: [u8; 32],
    pub quote_hash: [u8; 32],
    pub route_hash: [u8; 32],
}

#[derive(Accounts)]
pub struct ConsumeReservation<'info> {
    #[account(mut)]
    pub solver: SystemAccount<'info>,
    pub strategy_authority: Signer<'info>,
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
            RESERVATION_CLASS_SEED,
            reservation_class.domain_identity.as_ref(),
            reservation_class.domain.domain_manifest_version().to_be_bytes().as_ref(),
            reservation_class.domain.domain_manifest_hash().as_ref(),
            reservation_class.base_mint.as_ref(),
            reservation_class.quote_mint.as_ref(),
            reservation_class.consumer_program.as_ref()
        ],
        bump = reservation_class.bump
    )]
    pub reservation_class: Box<Account<'info, ReservationClass>>,
    #[account(
        mut,
        seeds = [
            RESERVATION_CAPACITY_SEED,
            reservation_class.key().as_ref(),
            solver.key().as_ref()
        ],
        bump = capacity.bump,
        has_one = reservation_class,
        has_one = solver
    )]
    pub capacity: Box<Account<'info, ReservationCapacity>>,
    #[account(
        mut,
        seeds = [
            RESERVATION_SEED,
            reservation_class.key().as_ref(),
            solver.key().as_ref(),
            reservation.reservation_id.as_ref()
        ],
        bump = reservation.bump,
        has_one = reservation_class,
        has_one = solver,
        has_one = strategy_authority
    )]
    pub reservation: Box<Account<'info, FirmReservation>>,
    #[account(
        mut,
        close = solver,
        seeds = [
            LIVE_PAIR_SEED,
            reservation_class.key().as_ref(),
            solver.key().as_ref(),
            strategy_authority.key().as_ref()
        ],
        bump = live_pair.bump,
        has_one = reservation_class,
        has_one = solver,
        has_one = strategy_authority,
        constraint = live_pair.reservation_id == reservation.reservation_id @ ErrorCode::AccountBindingMismatch
    )]
    pub live_pair: Box<Account<'info, LivePair>>,
    #[account(
        mut,
        seeds = [
            RESERVATION_VAULT_SEED,
            reservation_class.key().as_ref(),
            solver.key().as_ref(),
            reservation.reservation_id.as_ref()
        ],
        bump = reservation.vault_bump,
        token::mint = reservation_class.base_mint,
        token::authority = reservation
    )]
    pub vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = reservation.solver_quote)]
    pub solver_quote: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = reservation.strategy_base)]
    pub strategy_base: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = reservation.strategy_quote)]
    pub strategy_quote: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

pub fn consume_reservation_handler(
    ctx: Context<ConsumeReservation>,
    args: ConsumeReservationArgs,
) -> Result<()> {
    let class = &ctx.accounts.reservation_class;
    let reservation_class = class.key();
    let reservation = &mut ctx.accounts.reservation;
    require!(
        class.is_current_entry() && reservation.is_current_entry(),
        ErrorCode::ClassParameterInvalid
    );
    verify_core_identity(
        class,
        &ctx.accounts.core_program.to_account_info(),
        &ctx.accounts.core_program_data,
    )?;
    verify_consumer_identity(
        class,
        &ctx.accounts.consumer_program,
        &ctx.accounts.consumer_program_data,
    )?;
    require!(
        ctx.accounts.protocol_config.domain == class.domain && reservation.domain == class.domain,
        ErrorCode::DomainInactive
    );
    require!(
        reservation.base_mint == class.base_mint
            && reservation.quote_mint == class.quote_mint
            && ctx.accounts.solver_quote.mint == class.quote_mint
            && ctx.accounts.strategy_base.mint == class.base_mint
            && ctx.accounts.strategy_quote.mint == class.quote_mint,
        ErrorCode::AccountBindingMismatch
    );
    require!(
        !ctx.accounts.protocol_config.entry_paused,
        ErrorCode::EntryPaused
    );
    require!(
        ctx.accounts.strategy_authority.to_account_info().owner == &class.consumer_program
            && !ctx.accounts.strategy_authority.key().is_on_curve(),
        ErrorCode::ConsumerAuthorityInvalid
    );
    require!(
        ctx.accounts.vault.amount == reservation.base_atoms,
        ErrorCode::TokenDeltaMismatch
    );

    let base_atoms = reservation.base_atoms;
    let quote_atoms = reservation.quote_atoms;
    let reservation_id = reservation.reservation_id;
    let reservation_bump = reservation.bump;
    reservation.consume(
        reservation_class,
        args.package_nonce,
        args.order_hash,
        args.quote_hash,
        args.route_hash,
        Clock::get()?.slot,
    )?;
    ctx.accounts.capacity.release(base_atoms)?;

    let strategy_base_before = ctx.accounts.strategy_base.amount;
    let strategy_quote_before = ctx.accounts.strategy_quote.amount;
    let solver_quote_before = ctx.accounts.solver_quote.amount;
    let vault_before = ctx.accounts.vault.amount;

    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            Transfer {
                from: ctx.accounts.strategy_quote.to_account_info(),
                to: ctx.accounts.solver_quote.to_account_info(),
                authority: ctx.accounts.strategy_authority.to_account_info(),
            },
        ),
        quote_atoms,
    )?;
    let solver_key = ctx.accounts.solver.key();
    let signer_seeds: &[&[u8]] = &[
        RESERVATION_SEED,
        reservation_class.as_ref(),
        solver_key.as_ref(),
        reservation_id.as_ref(),
        &[reservation_bump],
    ];
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.strategy_base.to_account_info(),
                authority: ctx.accounts.reservation.to_account_info(),
            },
            &[signer_seeds],
        ),
        base_atoms,
    )?;

    ctx.accounts.strategy_base.reload()?;
    ctx.accounts.strategy_quote.reload()?;
    ctx.accounts.solver_quote.reload()?;
    ctx.accounts.vault.reload()?;
    validate_entry_deltas(
        base_atoms,
        quote_atoms,
        strategy_base_before,
        ctx.accounts.strategy_base.amount,
        strategy_quote_before,
        ctx.accounts.strategy_quote.amount,
        solver_quote_before,
        ctx.accounts.solver_quote.amount,
        vault_before,
        ctx.accounts.vault.amount,
    )?;

    token::close_account(CpiContext::new_with_signer(
        ctx.accounts.token_program.key(),
        CloseAccount {
            account: ctx.accounts.vault.to_account_info(),
            destination: ctx.accounts.solver.to_account_info(),
            authority: ctx.accounts.reservation.to_account_info(),
        },
        &[signer_seeds],
    ))?;
    emit!(ReservationConsumed {
        reservation_class,
        reservation_id,
        quote_hash: args.quote_hash,
        base_atoms,
        quote_atoms,
    });
    Ok(())
}

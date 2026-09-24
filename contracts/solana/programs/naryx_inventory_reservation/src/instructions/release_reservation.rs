use anchor_lang::prelude::*;
use anchor_spl::token::{self, CloseAccount, Token, TokenAccount, Transfer};

use crate::{
    constants::{
        LIVE_PAIR_SEED, RESERVATION_CAPACITY_SEED, RESERVATION_CLASS_SEED, RESERVATION_SEED,
        RESERVATION_VAULT_SEED,
    },
    error::ErrorCode,
    events::ReservationReleased,
    state::{FirmReservation, LivePair, ReservationCapacity, ReservationClass},
};

#[derive(Accounts)]
pub struct ReleaseReservation<'info> {
    #[account(mut)]
    pub solver: SystemAccount<'info>,
    /// CHECK: The immutable reservation key is the only accepted strategy binding.
    #[account(address = reservation.strategy_authority)]
    pub strategy_authority: UncheckedAccount<'info>,
    #[account(seeds = [RESERVATION_CLASS_SEED], bump = reservation_class.bump)]
    pub reservation_class: Box<Account<'info, ReservationClass>>,
    #[account(
        mut,
        seeds = [RESERVATION_CAPACITY_SEED, solver.key().as_ref()],
        bump = capacity.bump,
        constraint = capacity.solver == solver.key() @ ErrorCode::AccountBindingMismatch
    )]
    pub capacity: Box<Account<'info, ReservationCapacity>>,
    #[account(
        mut,
        seeds = [RESERVATION_SEED, solver.key().as_ref(), reservation.reservation_id.as_ref()],
        bump = reservation.bump,
        has_one = solver
    )]
    pub reservation: Box<Account<'info, FirmReservation>>,
    #[account(
        mut,
        close = solver,
        seeds = [LIVE_PAIR_SEED, solver.key().as_ref(), strategy_authority.key().as_ref()],
        bump = live_pair.bump,
        constraint = live_pair.reservation_id == reservation.reservation_id @ ErrorCode::AccountBindingMismatch
    )]
    pub live_pair: Box<Account<'info, LivePair>>,
    #[account(
        mut,
        seeds = [RESERVATION_VAULT_SEED, solver.key().as_ref(), reservation.reservation_id.as_ref()],
        bump = reservation.vault_bump,
        token::mint = reservation_class.base_mint,
        token::authority = reservation
    )]
    pub vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = reservation.solver_reclaim_base)]
    pub solver_reclaim_base: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

pub fn release_reservation_handler(ctx: Context<ReleaseReservation>) -> Result<()> {
    let reservation = &mut ctx.accounts.reservation;
    require!(
        ctx.accounts.vault.amount == reservation.base_atoms,
        ErrorCode::TokenDeltaMismatch
    );

    let base_atoms = reservation.base_atoms;
    let reservation_id = reservation.reservation_id;
    let reservation_bump = reservation.bump;
    reservation.release(Clock::get()?.slot)?;
    ctx.accounts.capacity.release(base_atoms)?;

    let reclaim_before = ctx.accounts.solver_reclaim_base.amount;
    let vault_before = ctx.accounts.vault.amount;
    let solver_key = ctx.accounts.solver.key();
    let signer_seeds: &[&[u8]] = &[
        RESERVATION_SEED,
        solver_key.as_ref(),
        reservation_id.as_ref(),
        &[reservation_bump],
    ];
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.solver_reclaim_base.to_account_info(),
                authority: ctx.accounts.reservation.to_account_info(),
            },
            &[signer_seeds],
        ),
        base_atoms,
    )?;
    ctx.accounts.solver_reclaim_base.reload()?;
    ctx.accounts.vault.reload()?;
    require!(
        ctx.accounts
            .solver_reclaim_base
            .amount
            .checked_sub(reclaim_before)
            == Some(base_atoms)
            && vault_before.checked_sub(ctx.accounts.vault.amount) == Some(base_atoms)
            && ctx.accounts.vault.amount == 0,
        ErrorCode::TokenDeltaMismatch
    );

    token::close_account(CpiContext::new_with_signer(
        ctx.accounts.token_program.key(),
        CloseAccount {
            account: ctx.accounts.vault.to_account_info(),
            destination: ctx.accounts.solver.to_account_info(),
            authority: ctx.accounts.reservation.to_account_info(),
        },
        &[signer_seeds],
    ))?;
    emit!(ReservationReleased {
        reservation_id,
        base_atoms,
    });
    Ok(())
}

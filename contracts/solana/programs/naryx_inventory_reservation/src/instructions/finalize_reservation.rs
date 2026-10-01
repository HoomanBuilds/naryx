use anchor_lang::prelude::*;

use crate::{
    constants::{RESERVATION_CLASS_SEED, RESERVATION_SEED},
    error::ErrorCode,
    events::ReservationFinalized,
    state::{FirmReservation, ReservationClass},
};

#[derive(Accounts)]
pub struct FinalizeReservation<'info> {
    pub solver: Signer<'info>,
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
    pub reservation_class: Account<'info, ReservationClass>,
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
        has_one = solver
    )]
    pub reservation: Account<'info, FirmReservation>,
}

pub fn finalize_reservation_handler(
    ctx: Context<FinalizeReservation>,
    quote_hash: [u8; 32],
) -> Result<()> {
    require!(
        ctx.accounts.reservation_class.is_current_entry()
            && (ctx.accounts.reservation.is_current_entry()
                || ctx.accounts.reservation.is_current_exit()),
        ErrorCode::ClassParameterInvalid
    );
    let reservation_class = ctx.accounts.reservation_class.key();
    ctx.accounts
        .reservation
        .finalize(reservation_class, quote_hash, Clock::get()?.slot)?;
    emit!(ReservationFinalized {
        reservation_class,
        reservation_id: ctx.accounts.reservation.reservation_id,
        quote_hash,
    });
    Ok(())
}

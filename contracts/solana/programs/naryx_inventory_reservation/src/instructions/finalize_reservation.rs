use anchor_lang::prelude::*;

use crate::{constants::RESERVATION_SEED, events::ReservationFinalized, state::FirmReservation};

#[derive(Accounts)]
pub struct FinalizeReservation<'info> {
    pub solver: Signer<'info>,
    #[account(
        mut,
        seeds = [RESERVATION_SEED, solver.key().as_ref(), reservation.reservation_id.as_ref()],
        bump = reservation.bump,
        has_one = solver
    )]
    pub reservation: Account<'info, FirmReservation>,
}

pub fn finalize_reservation_handler(
    ctx: Context<FinalizeReservation>,
    quote_hash: [u8; 32],
) -> Result<()> {
    ctx.accounts
        .reservation
        .finalize(quote_hash, Clock::get()?.slot)?;
    emit!(ReservationFinalized {
        reservation_id: ctx.accounts.reservation.reservation_id,
        quote_hash,
    });
    Ok(())
}

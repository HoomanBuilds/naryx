pub mod constants;
pub mod error;
pub mod events;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("8Dby697KuRBW1TsGucdXdQugVoko4WoJXRUTZdHfy4Dx");

#[program]
pub mod naryx_inventory_reservation {
    use super::*;

    pub fn initialize_class(
        ctx: Context<InitializeClass>,
        args: InitializeClassArgs,
    ) -> Result<()> {
        initialize_class::initialize_class_handler(ctx, args)
    }

    pub fn fund_reservation(
        ctx: Context<FundReservation>,
        args: FundReservationArgs,
    ) -> Result<()> {
        fund_reservation::fund_reservation_handler(ctx, args)
    }

    pub fn finalize_reservation(
        ctx: Context<FinalizeReservation>,
        quote_hash: [u8; 32],
    ) -> Result<()> {
        finalize_reservation::finalize_reservation_handler(ctx, quote_hash)
    }

    pub fn consume_reservation(
        ctx: Context<ConsumeReservation>,
        args: ConsumeReservationArgs,
    ) -> Result<()> {
        consume_reservation::consume_reservation_handler(ctx, args)
    }

    pub fn release_reservation(ctx: Context<ReleaseReservation>) -> Result<()> {
        release_reservation::release_reservation_handler(ctx)
    }

    pub fn fund_exit_reservation(
        ctx: Context<FundExitReservation>,
        args: FundReservationArgs,
    ) -> Result<()> {
        exit_reservation::fund_exit_reservation_handler(ctx, args)
    }

    pub fn consume_exit_reservation(
        ctx: Context<ConsumeExitReservation>,
        args: ConsumeReservationArgs,
    ) -> Result<()> {
        exit_reservation::consume_exit_reservation_handler(ctx, args)
    }

    pub fn release_exit_reservation(ctx: Context<ReleaseExitReservation>) -> Result<()> {
        exit_reservation::release_exit_reservation_handler(ctx)
    }
}

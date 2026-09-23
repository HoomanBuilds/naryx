use anchor_lang::prelude::*;

use crate::{
    constants::PROTOCOL_CONFIG_SEED,
    error::ErrorCode,
    events::{EntryPaused, UnpauseCancelled},
    state::ProtocolConfig,
};

#[derive(Accounts)]
pub struct PauseEntry<'info> {
    pub pauser: Signer<'info>,
    #[account(
        mut,
        seeds = [PROTOCOL_CONFIG_SEED],
        bump = config.bump,
        has_one = pauser @ ErrorCode::UnauthorizedRole
    )]
    pub config: Account<'info, ProtocolConfig>,
}

pub(crate) fn handler(ctx: Context<PauseEntry>) -> Result<()> {
    let config = &mut ctx.accounts.config;

    // Pausing again is accepted only to revoke a scheduled unpause. Leaving that schedule in
    // place would let the executor reopen entry at its old slot after the pauser closed it.
    require!(
        !config.entry_paused || config.pending_unpause_slot.is_some(),
        ErrorCode::EntryAlreadyPaused
    );

    config.entry_paused = true;
    if let Some(activation_slot) = config.pending_unpause_slot.take() {
        emit!(UnpauseCancelled {
            config: config.key(),
            actor: ctx.accounts.pauser.key(),
            activation_slot,
        });
    }

    emit!(EntryPaused {
        config: config.key(),
        pauser: ctx.accounts.pauser.key(),
    });

    Ok(())
}

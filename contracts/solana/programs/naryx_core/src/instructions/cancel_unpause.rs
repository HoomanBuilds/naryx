use anchor_lang::prelude::*;

use crate::{
    constants::PROTOCOL_CONFIG_SEED, error::ErrorCode, events::UnpauseCancelled,
    state::ProtocolConfig,
};

#[derive(Accounts)]
pub struct CancelUnpause<'info> {
    pub canceller: Signer<'info>,
    #[account(
        mut,
        seeds = [PROTOCOL_CONFIG_SEED],
        bump = config.bump,
        has_one = canceller @ ErrorCode::UnauthorizedRole
    )]
    pub config: Account<'info, ProtocolConfig>,
}

pub(crate) fn handler(ctx: Context<CancelUnpause>) -> Result<()> {
    let activation_slot = ctx
        .accounts
        .config
        .pending_unpause_slot
        .take()
        .ok_or_else(|| error!(ErrorCode::UnpauseNotScheduled))?;

    emit!(UnpauseCancelled {
        config: ctx.accounts.config.key(),
        actor: ctx.accounts.canceller.key(),
        activation_slot,
    });

    Ok(())
}

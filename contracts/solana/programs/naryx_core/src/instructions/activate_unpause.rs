use anchor_lang::prelude::*;

use crate::{
    constants::PROTOCOL_CONFIG_SEED, error::ErrorCode, events::EntryUnpaused, state::ProtocolConfig,
};

#[derive(Accounts)]
pub struct ActivateUnpause<'info> {
    pub executor: Signer<'info>,
    #[account(
        mut,
        seeds = [PROTOCOL_CONFIG_SEED],
        bump = config.bump,
        has_one = executor @ ErrorCode::UnauthorizedRole
    )]
    pub config: Account<'info, ProtocolConfig>,
}

pub(crate) fn handler(ctx: Context<ActivateUnpause>) -> Result<()> {
    let slot = Clock::get()?.slot;
    let config = &mut ctx.accounts.config;

    let activation_slot = config
        .pending_unpause_slot
        .ok_or_else(|| error!(ErrorCode::UnpauseNotScheduled))?;
    require_gte!(slot, activation_slot, ErrorCode::UnpauseNotReady);

    config.entry_paused = false;
    config.pending_unpause_slot = None;

    emit!(EntryUnpaused {
        config: config.key(),
        executor: ctx.accounts.executor.key(),
    });

    Ok(())
}

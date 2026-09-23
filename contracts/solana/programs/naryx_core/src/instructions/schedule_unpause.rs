use anchor_lang::prelude::*;

use crate::{
    constants::PROTOCOL_CONFIG_SEED, error::ErrorCode, events::UnpauseScheduled,
    state::ProtocolConfig,
};

#[derive(Accounts)]
pub struct ScheduleUnpause<'info> {
    pub proposer: Signer<'info>,
    #[account(
        mut,
        seeds = [PROTOCOL_CONFIG_SEED],
        bump = config.bump,
        has_one = proposer @ ErrorCode::UnauthorizedRole
    )]
    pub config: Account<'info, ProtocolConfig>,
}

pub(crate) fn handler(ctx: Context<ScheduleUnpause>) -> Result<()> {
    let slot = Clock::get()?.slot;
    let config = &mut ctx.accounts.config;

    require!(config.entry_paused, ErrorCode::EntryNotPaused);
    require!(
        config.pending_unpause_slot.is_none(),
        ErrorCode::UnpauseAlreadyScheduled
    );

    let activation_slot = slot
        .checked_add(config.config_delay_slots)
        .ok_or_else(|| error!(ErrorCode::ActivationSlotOverflow))?;
    config.pending_unpause_slot = Some(activation_slot);

    emit!(UnpauseScheduled {
        config: config.key(),
        proposer: ctx.accounts.proposer.key(),
        activation_slot,
    });

    Ok(())
}

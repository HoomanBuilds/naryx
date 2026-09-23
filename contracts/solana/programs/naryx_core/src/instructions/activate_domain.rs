use anchor_lang::prelude::*;

use crate::{
    constants::PROTOCOL_CONFIG_SEED, error::ErrorCode, events::DomainActivated,
    state::ProtocolConfig,
};

#[derive(Accounts)]
pub struct ActivateDomain<'info> {
    pub executor: Signer<'info>,
    #[account(
        mut,
        seeds = [PROTOCOL_CONFIG_SEED],
        bump = config.bump,
        has_one = executor @ ErrorCode::UnauthorizedRole
    )]
    pub config: Account<'info, ProtocolConfig>,
}

pub(crate) fn handler(ctx: Context<ActivateDomain>) -> Result<()> {
    let slot = Clock::get()?.slot;
    let config = &mut ctx.accounts.config;

    let pending = config
        .pending_domain
        .clone()
        .ok_or_else(|| error!(ErrorCode::DomainProposalMissing))?;
    require_gte!(
        slot,
        pending.activation_slot,
        ErrorCode::DomainProposalNotReady
    );

    config.pending_domain = None;
    let previous = core::mem::replace(&mut config.domain, pending.domain.clone());

    emit!(DomainActivated {
        config: config.key(),
        executor: ctx.accounts.executor.key(),
        previous,
        current: pending.domain,
    });

    Ok(())
}

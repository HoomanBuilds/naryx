use anchor_lang::prelude::*;

use crate::{
    constants::PROTOCOL_CONFIG_SEED, error::ErrorCode, events::DomainProposalCancelled,
    state::ProtocolConfig,
};

#[derive(Accounts)]
pub struct CancelDomainProposal<'info> {
    pub canceller: Signer<'info>,
    #[account(
        mut,
        seeds = [PROTOCOL_CONFIG_SEED],
        bump = config.bump,
        has_one = canceller @ ErrorCode::UnauthorizedRole
    )]
    pub config: Account<'info, ProtocolConfig>,
}

pub(crate) fn handler(ctx: Context<CancelDomainProposal>) -> Result<()> {
    let pending = ctx
        .accounts
        .config
        .pending_domain
        .take()
        .ok_or_else(|| error!(ErrorCode::DomainProposalMissing))?;

    emit!(DomainProposalCancelled {
        config: ctx.accounts.config.key(),
        canceller: ctx.accounts.canceller.key(),
        domain: pending.domain,
        activation_slot: pending.activation_slot,
    });

    Ok(())
}

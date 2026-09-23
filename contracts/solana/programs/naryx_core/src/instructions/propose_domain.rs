use anchor_lang::prelude::*;

use crate::{
    constants::PROTOCOL_CONFIG_SEED,
    error::ErrorCode,
    events::DomainProposed,
    state::{PendingDomain, ProtocolConfig},
    wire::{DomainRef, HASH_BYTE_LENGTH},
};

#[derive(Accounts)]
pub struct ProposeDomain<'info> {
    pub proposer: Signer<'info>,
    #[account(
        mut,
        seeds = [PROTOCOL_CONFIG_SEED],
        bump = config.bump,
        has_one = proposer @ ErrorCode::UnauthorizedRole
    )]
    pub config: Account<'info, ProtocolConfig>,
}

pub(crate) fn handler(
    ctx: Context<ProposeDomain>,
    domain_manifest_version: u32,
    domain_manifest_hash: [u8; HASH_BYTE_LENGTH],
) -> Result<()> {
    let slot = Clock::get()?.slot;
    let config = &mut ctx.accounts.config;

    require!(
        config.pending_domain.is_none(),
        ErrorCode::DomainProposalExists
    );
    require_gt!(
        domain_manifest_version,
        config.domain.domain_manifest_version(),
        ErrorCode::DomainManifestVersionNotIncreasing
    );

    let domain = DomainRef::new(
        config.domain.domain_id(),
        domain_manifest_version,
        domain_manifest_hash,
    )?;

    let activation_slot = slot
        .checked_add(config.config_delay_slots)
        .ok_or_else(|| error!(ErrorCode::ActivationSlotOverflow))?;

    config.pending_domain = Some(PendingDomain {
        domain: domain.clone(),
        activation_slot,
    });

    emit!(DomainProposed {
        config: config.key(),
        proposer: ctx.accounts.proposer.key(),
        domain,
        activation_slot,
    });

    Ok(())
}

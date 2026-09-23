use anchor_lang::prelude::*;

use crate::{
    constants::PROTOCOL_CONFIG_SEED,
    error::ErrorCode,
    events::ProtocolConfigInitialized,
    program::NaryxCore,
    state::{ProtocolConfig, PROTOCOL_CONFIG_VERSION},
    wire::{DomainRef, ProtocolId, HASH_BYTE_LENGTH},
};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct GovernanceRoles {
    pub proposer: Pubkey,
    pub canceller: Pubkey,
    pub executor: Pubkey,
    pub pauser: Pubkey,
}

impl GovernanceRoles {
    fn validate(&self) -> Result<()> {
        let keys = [self.proposer, self.canceller, self.executor, self.pauser];
        for (index, key) in keys.iter().enumerate() {
            require_keys_neq!(*key, Pubkey::default(), ErrorCode::GovernanceRoleKeyZero);
            require!(
                !keys[..index].contains(key),
                ErrorCode::GovernanceRoleDuplicate
            );
        }
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub initializer: Signer<'info>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key()))]
    pub program: Program<'info, NaryxCore>,
    #[account(
        constraint = program_data.upgrade_authority_address == Some(initializer.key())
    )]
    pub program_data: Account<'info, ProgramData>,
    #[account(
        init,
        payer = payer,
        space = 8 + ProtocolConfig::INIT_SPACE,
        seeds = [PROTOCOL_CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, ProtocolConfig>,
    pub system_program: Program<'info, System>,
}

pub(crate) fn handler(
    ctx: Context<Initialize>,
    environment: String,
    domain_id: String,
    domain_manifest_version: u32,
    domain_manifest_hash: [u8; HASH_BYTE_LENGTH],
    config_delay_slots: u64,
    roles: GovernanceRoles,
) -> Result<()> {
    let environment = ProtocolId::new(&environment)?;
    let domain = DomainRef::new(&domain_id, domain_manifest_version, domain_manifest_hash)?;
    require!(config_delay_slots != 0, ErrorCode::ConfigDelayZero);
    roles.validate()?;

    ctx.accounts.config.set_inner(ProtocolConfig {
        config_version: PROTOCOL_CONFIG_VERSION,
        environment: environment.clone(),
        domain: domain.clone(),
        pending_domain: None,
        proposer: roles.proposer,
        canceller: roles.canceller,
        executor: roles.executor,
        pauser: roles.pauser,
        config_delay_slots,
        entry_paused: true,
        pending_unpause_slot: None,
        bump: ctx.bumps.config,
    });

    emit!(ProtocolConfigInitialized {
        config: ctx.accounts.config.key(),
        initializer: ctx.accounts.initializer.key(),
        environment,
        domain,
        config_delay_slots,
        proposer: roles.proposer,
        canceller: roles.canceller,
        executor: roles.executor,
        pauser: roles.pauser,
    });

    Ok(())
}

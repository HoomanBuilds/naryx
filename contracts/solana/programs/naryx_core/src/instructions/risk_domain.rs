use anchor_lang::prelude::*;

use crate::{
    constants::{PROTOCOL_CONFIG_SEED, RISK_DOMAIN_INDEX_SEED, RISK_DOMAIN_RECORD_SEED},
    error::ErrorCode,
    events::{
        RiskDomainEntryPaused, RiskDomainPolicyActivated, RiskDomainPolicyCancelled,
        RiskDomainPolicyProposed, RiskDomainResumeActivated, RiskDomainResumeCancelled,
        RiskDomainResumeProposed,
    },
    state::{Lifecycle, ProtocolConfig, RiskDomainIndex, RiskDomainPolicyV1, RiskDomainRecord},
    wire::HASH_BYTE_LENGTH,
};

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ProposeRiskDomainArgs {
    pub risk_domain_id: [u8; HASH_BYTE_LENGTH],
    pub policy: RiskDomainPolicyV1,
}

#[derive(Accounts)]
#[instruction(args: ProposeRiskDomainArgs)]
pub struct ProposeInitialRiskDomain<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub proposer: Signer<'info>,
    #[account(
        seeds = [PROTOCOL_CONFIG_SEED],
        bump = config.bump,
        has_one = proposer @ ErrorCode::UnauthorizedRole
    )]
    pub config: Box<Account<'info, ProtocolConfig>>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + RiskDomainIndex::INIT_SPACE,
        seeds = [RISK_DOMAIN_INDEX_SEED, args.risk_domain_id.as_ref()],
        bump
    )]
    pub index: Box<Account<'info, RiskDomainIndex>>,
    #[account(
        init,
        payer = payer,
        space = 8 + RiskDomainRecord::INIT_SPACE,
        seeds = [
            RISK_DOMAIN_RECORD_SEED,
            args.risk_domain_id.as_ref(),
            args.policy.manifest_version.to_be_bytes().as_ref()
        ],
        bump
    )]
    pub record: Box<Account<'info, RiskDomainRecord>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(args: ProposeRiskDomainArgs)]
pub struct ProposeRiskDomainVersion<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub proposer: Signer<'info>,
    #[account(
        seeds = [PROTOCOL_CONFIG_SEED],
        bump = config.bump,
        has_one = proposer @ ErrorCode::UnauthorizedRole
    )]
    pub config: Box<Account<'info, ProtocolConfig>>,
    #[account(
        mut,
        seeds = [RISK_DOMAIN_INDEX_SEED, args.risk_domain_id.as_ref()],
        bump = index.bump
    )]
    pub index: Box<Account<'info, RiskDomainIndex>>,
    #[account(
        init,
        payer = payer,
        space = 8 + RiskDomainRecord::INIT_SPACE,
        seeds = [
            RISK_DOMAIN_RECORD_SEED,
            args.risk_domain_id.as_ref(),
            args.policy.manifest_version.to_be_bytes().as_ref()
        ],
        bump
    )]
    pub record: Box<Account<'info, RiskDomainRecord>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ActivateInitialRiskDomain<'info> {
    pub executor: Signer<'info>,
    #[account(
        seeds = [PROTOCOL_CONFIG_SEED],
        bump = config.bump,
        has_one = executor @ ErrorCode::UnauthorizedRole
    )]
    pub config: Box<Account<'info, ProtocolConfig>>,
    #[account(
        mut,
        seeds = [RISK_DOMAIN_INDEX_SEED, record.risk_domain_id.as_ref()],
        bump = index.bump
    )]
    pub index: Box<Account<'info, RiskDomainIndex>>,
    #[account(
        mut,
        seeds = [
            RISK_DOMAIN_RECORD_SEED,
            record.risk_domain_id.as_ref(),
            record.policy.manifest_version.to_be_bytes().as_ref()
        ],
        bump = record.bump
    )]
    pub record: Box<Account<'info, RiskDomainRecord>>,
}

#[derive(Accounts)]
pub struct ActivateRiskDomainVersion<'info> {
    pub executor: Signer<'info>,
    #[account(
        seeds = [PROTOCOL_CONFIG_SEED],
        bump = config.bump,
        has_one = executor @ ErrorCode::UnauthorizedRole
    )]
    pub config: Box<Account<'info, ProtocolConfig>>,
    #[account(
        mut,
        seeds = [RISK_DOMAIN_INDEX_SEED, record.risk_domain_id.as_ref()],
        bump = index.bump
    )]
    pub index: Box<Account<'info, RiskDomainIndex>>,
    #[account(mut, address = index.active_record @ ErrorCode::RiskDomainIdentityMismatch)]
    pub previous_record: Box<Account<'info, RiskDomainRecord>>,
    #[account(
        mut,
        seeds = [
            RISK_DOMAIN_RECORD_SEED,
            record.risk_domain_id.as_ref(),
            record.policy.manifest_version.to_be_bytes().as_ref()
        ],
        bump = record.bump
    )]
    pub record: Box<Account<'info, RiskDomainRecord>>,
}

#[derive(Accounts)]
pub struct CancelRiskDomainProposal<'info> {
    pub canceller: Signer<'info>,
    #[account(
        seeds = [PROTOCOL_CONFIG_SEED],
        bump = config.bump,
        has_one = canceller @ ErrorCode::UnauthorizedRole
    )]
    pub config: Box<Account<'info, ProtocolConfig>>,
    #[account(
        mut,
        seeds = [RISK_DOMAIN_INDEX_SEED, record.risk_domain_id.as_ref()],
        bump = index.bump
    )]
    pub index: Box<Account<'info, RiskDomainIndex>>,
    #[account(mut, address = index.pending_record @ ErrorCode::RiskDomainIdentityMismatch)]
    pub record: Box<Account<'info, RiskDomainRecord>>,
}

#[derive(Accounts)]
pub struct ControlRiskDomain<'info> {
    pub actor: Signer<'info>,
    #[account(seeds = [PROTOCOL_CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, ProtocolConfig>>,
    #[account(
        mut,
        seeds = [RISK_DOMAIN_INDEX_SEED, record.risk_domain_id.as_ref()],
        bump = index.bump
    )]
    pub index: Box<Account<'info, RiskDomainIndex>>,
    #[account(mut, address = index.active_record @ ErrorCode::RiskDomainIdentityMismatch)]
    pub record: Box<Account<'info, RiskDomainRecord>>,
}

pub(crate) fn propose_initial(
    ctx: Context<ProposeInitialRiskDomain>,
    args: ProposeRiskDomainArgs,
) -> Result<()> {
    require!(
        ctx.accounts.index.risk_domain_id == [0u8; HASH_BYTE_LENGTH],
        ErrorCode::RiskDomainIdentityMismatch
    );
    initialize_index(
        &mut ctx.accounts.index,
        args.risk_domain_id,
        ctx.bumps.index,
    );
    let record_key = ctx.accounts.record.key();
    propose(
        &ctx.accounts.config,
        &mut ctx.accounts.index,
        &mut ctx.accounts.record,
        args,
        ctx.bumps.record,
        record_key,
        ctx.accounts.proposer.key(),
    )
}

pub(crate) fn propose_version(
    ctx: Context<ProposeRiskDomainVersion>,
    args: ProposeRiskDomainArgs,
) -> Result<()> {
    require!(
        ctx.accounts.index.risk_domain_id == args.risk_domain_id,
        ErrorCode::RiskDomainIdentityMismatch
    );
    let record_key = ctx.accounts.record.key();
    propose(
        &ctx.accounts.config,
        &mut ctx.accounts.index,
        &mut ctx.accounts.record,
        args,
        ctx.bumps.record,
        record_key,
        ctx.accounts.proposer.key(),
    )
}

fn initialize_index(index: &mut RiskDomainIndex, risk_domain_id: [u8; 32], bump: u8) {
    index.risk_domain_id = risk_domain_id;
    index.latest_version = 0;
    index.active_record = Pubkey::default();
    index.pending_record = Pubkey::default();
    index.activation_slot = None;
    index.entry_paused = false;
    index.pending_resume_slot = None;
    index.bump = bump;
}

fn propose(
    config: &ProtocolConfig,
    index: &mut RiskDomainIndex,
    record: &mut RiskDomainRecord,
    args: ProposeRiskDomainArgs,
    bump: u8,
    record_key: Pubkey,
    actor: Pubkey,
) -> Result<()> {
    require!(
        args.risk_domain_id != [0u8; HASH_BYTE_LENGTH],
        ErrorCode::RiskDomainIdentityMismatch
    );
    args.policy.validate(&config.domain)?;
    require!(
        index.pending_record == Pubkey::default(),
        ErrorCode::RiskDomainProposalExists
    );
    require_gt!(
        args.policy.manifest_version,
        index.latest_version,
        ErrorCode::RiskDomainVersionNotIncreasing
    );
    let activation_slot = Clock::get()?
        .slot
        .checked_add(config.config_delay_slots)
        .ok_or_else(|| error!(ErrorCode::ActivationSlotOverflow))?;
    record.domain = config.domain.clone();
    record.risk_domain_id = args.risk_domain_id;
    record.policy = args.policy;
    record.lifecycle = Lifecycle::AllPaused;
    record.active = false;
    record.bump = bump;
    index.latest_version = record.policy.manifest_version;
    index.pending_record = record_key;
    index.activation_slot = Some(activation_slot);
    emit!(RiskDomainPolicyProposed {
        actor,
        record: record_key,
        risk_domain_id: record.risk_domain_id,
        manifest_version: record.policy.manifest_version,
        manifest_hash: record.policy.manifest_hash,
        activation_slot,
    });
    Ok(())
}

pub(crate) fn activate_initial(ctx: Context<ActivateInitialRiskDomain>) -> Result<()> {
    require_keys_eq!(
        ctx.accounts.index.active_record,
        Pubkey::default(),
        ErrorCode::RiskDomainIdentityMismatch
    );
    let record_key = ctx.accounts.record.key();
    activate(
        &ctx.accounts.config,
        &mut ctx.accounts.index,
        &mut ctx.accounts.record,
        Pubkey::default(),
        record_key,
        ctx.accounts.executor.key(),
    )
}

pub(crate) fn activate_version(ctx: Context<ActivateRiskDomainVersion>) -> Result<()> {
    require!(
        ctx.accounts.previous_record.active
            && ctx.accounts.previous_record.risk_domain_id == ctx.accounts.record.risk_domain_id,
        ErrorCode::RiskDomainIdentityMismatch
    );
    let previous_record_key = ctx.accounts.previous_record.key();
    let record_key = ctx.accounts.record.key();
    ctx.accounts.previous_record.lifecycle = Lifecycle::ExitOnly;
    activate(
        &ctx.accounts.config,
        &mut ctx.accounts.index,
        &mut ctx.accounts.record,
        previous_record_key,
        record_key,
        ctx.accounts.executor.key(),
    )
}

fn activate(
    config: &ProtocolConfig,
    index: &mut RiskDomainIndex,
    record: &mut RiskDomainRecord,
    previous_record: Pubkey,
    record_key: Pubkey,
    actor: Pubkey,
) -> Result<()> {
    require!(
        record.domain == config.domain
            && index.pending_record == record_key
            && index.risk_domain_id == record.risk_domain_id,
        ErrorCode::RiskDomainIdentityMismatch
    );
    let activation_slot = index
        .activation_slot
        .ok_or_else(|| error!(ErrorCode::RiskDomainProposalMissing))?;
    require_gte!(
        Clock::get()?.slot,
        activation_slot,
        ErrorCode::RiskDomainProposalNotReady
    );
    record.active = true;
    record.lifecycle = if index.entry_paused {
        Lifecycle::EntryPaused
    } else {
        Lifecycle::Active
    };
    index.active_record = record_key;
    index.pending_record = Pubkey::default();
    index.activation_slot = None;
    emit!(RiskDomainPolicyActivated {
        actor,
        record: record_key,
        previous_record,
        risk_domain_id: record.risk_domain_id,
        manifest_version: record.policy.manifest_version,
        manifest_hash: record.policy.manifest_hash,
        lifecycle: record.lifecycle,
    });
    Ok(())
}

pub(crate) fn cancel(ctx: Context<CancelRiskDomainProposal>) -> Result<()> {
    require!(
        ctx.accounts.index.pending_record == ctx.accounts.record.key(),
        ErrorCode::RiskDomainProposalMissing
    );
    ctx.accounts.record.lifecycle = Lifecycle::Deprecated;
    ctx.accounts.index.pending_record = Pubkey::default();
    ctx.accounts.index.activation_slot = None;
    emit!(RiskDomainPolicyCancelled {
        actor: ctx.accounts.canceller.key(),
        record: ctx.accounts.record.key(),
        risk_domain_id: ctx.accounts.record.risk_domain_id,
        manifest_version: ctx.accounts.record.policy.manifest_version,
    });
    Ok(())
}

pub(crate) fn pause(ctx: Context<ControlRiskDomain>) -> Result<()> {
    require_keys_eq!(
        ctx.accounts.actor.key(),
        ctx.accounts.config.pauser,
        ErrorCode::UnauthorizedRole
    );
    require!(
        !ctx.accounts.index.entry_paused,
        ErrorCode::RiskDomainAlreadyPaused
    );
    ctx.accounts.index.entry_paused = true;
    ctx.accounts.index.pending_resume_slot = None;
    ctx.accounts.record.lifecycle = Lifecycle::EntryPaused;
    emit!(RiskDomainEntryPaused {
        actor: ctx.accounts.actor.key(),
        record: ctx.accounts.record.key(),
        risk_domain_id: ctx.accounts.record.risk_domain_id,
    });
    Ok(())
}

pub(crate) fn propose_resume(ctx: Context<ControlRiskDomain>) -> Result<()> {
    require_keys_eq!(
        ctx.accounts.actor.key(),
        ctx.accounts.config.proposer,
        ErrorCode::UnauthorizedRole
    );
    require!(
        ctx.accounts.index.entry_paused,
        ErrorCode::RiskDomainNotPaused
    );
    require!(
        ctx.accounts.index.pending_resume_slot.is_none(),
        ErrorCode::RiskDomainResumeExists
    );
    let activation_slot = Clock::get()?
        .slot
        .checked_add(ctx.accounts.config.config_delay_slots)
        .ok_or_else(|| error!(ErrorCode::ActivationSlotOverflow))?;
    ctx.accounts.index.pending_resume_slot = Some(activation_slot);
    emit!(RiskDomainResumeProposed {
        actor: ctx.accounts.actor.key(),
        record: ctx.accounts.record.key(),
        risk_domain_id: ctx.accounts.record.risk_domain_id,
        activation_slot,
    });
    Ok(())
}

pub(crate) fn cancel_resume(ctx: Context<ControlRiskDomain>) -> Result<()> {
    require_keys_eq!(
        ctx.accounts.actor.key(),
        ctx.accounts.config.canceller,
        ErrorCode::UnauthorizedRole
    );
    require!(
        ctx.accounts.index.pending_resume_slot.is_some(),
        ErrorCode::RiskDomainResumeMissing
    );
    ctx.accounts.index.pending_resume_slot = None;
    emit!(RiskDomainResumeCancelled {
        actor: ctx.accounts.actor.key(),
        record: ctx.accounts.record.key(),
        risk_domain_id: ctx.accounts.record.risk_domain_id,
    });
    Ok(())
}

pub(crate) fn activate_resume(ctx: Context<ControlRiskDomain>) -> Result<()> {
    require_keys_eq!(
        ctx.accounts.actor.key(),
        ctx.accounts.config.executor,
        ErrorCode::UnauthorizedRole
    );
    require!(
        ctx.accounts.record.domain == ctx.accounts.config.domain,
        ErrorCode::RiskDomainDomainMismatch
    );
    let activation_slot = ctx
        .accounts
        .index
        .pending_resume_slot
        .ok_or_else(|| error!(ErrorCode::RiskDomainResumeMissing))?;
    require_gte!(
        Clock::get()?.slot,
        activation_slot,
        ErrorCode::RiskDomainResumeNotReady
    );
    require!(
        ctx.accounts.index.entry_paused,
        ErrorCode::RiskDomainNotPaused
    );
    ctx.accounts.index.entry_paused = false;
    ctx.accounts.index.pending_resume_slot = None;
    ctx.accounts.record.lifecycle = Lifecycle::Active;
    emit!(RiskDomainResumeActivated {
        actor: ctx.accounts.actor.key(),
        record: ctx.accounts.record.key(),
        risk_domain_id: ctx.accounts.record.risk_domain_id,
    });
    Ok(())
}

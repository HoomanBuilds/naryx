use anchor_lang::prelude::*;

use crate::{
    constants::{FEE_POLICY_SEED, PROTOCOL_CONFIG_SEED},
    error::ErrorCode,
    events::{
        FeePolicyActivated, FeePolicyPaused, FeePolicyProposalCancelled, FeePolicyProposed,
        FeePolicyResumeActivated, FeePolicyResumeCancelled, FeePolicyResumeProposed,
    },
    state::{
        domain_ref_identity_hash, FeePolicyDirection, FeePolicyRecord, ManifestRef,
        PendingFeePolicy, ProtocolConfig, HARD_MAX_TOTAL_FEE_BPS,
    },
    wire::HASH_BYTE_LENGTH,
};

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ProposeFeePolicyArgs {
    pub expected_domain_identity_hash: [u8; HASH_BYTE_LENGTH],
    pub direction: FeePolicyDirection,
    pub quote_asset: ManifestRef,
    pub version: u32,
    pub manifest_hash: [u8; HASH_BYTE_LENGTH],
    pub maximum_protocol_fee_bps: u16,
    pub maximum_solver_fee_bps: u16,
    pub protocol_fee_recipient: Pubkey,
}

#[derive(Accounts)]
#[instruction(args: ProposeFeePolicyArgs)]
pub struct ProposeFeePolicy<'info> {
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
        space = 8 + FeePolicyRecord::INIT_SPACE,
        seeds = [
            FEE_POLICY_SEED,
            args.expected_domain_identity_hash.as_ref(),
            args.direction.seed().as_ref(),
            args.quote_asset.subject_id.as_ref()
        ],
        bump
    )]
    pub policy: Box<Account<'info, FeePolicyRecord>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ActivateFeePolicy<'info> {
    pub executor: Signer<'info>,
    #[account(
        seeds = [PROTOCOL_CONFIG_SEED],
        bump = config.bump,
        has_one = executor @ ErrorCode::UnauthorizedRole
    )]
    pub config: Box<Account<'info, ProtocolConfig>>,
    #[account(
        mut,
        seeds = [
            FEE_POLICY_SEED,
            policy.domain_identity_hash.as_ref(),
            policy.direction.seed().as_ref(),
            policy.quote_asset.subject_id.as_ref()
        ],
        bump = policy.bump
    )]
    pub policy: Box<Account<'info, FeePolicyRecord>>,
}

#[derive(Accounts)]
pub struct CancelFeePolicyProposal<'info> {
    pub canceller: Signer<'info>,
    #[account(
        seeds = [PROTOCOL_CONFIG_SEED],
        bump = config.bump,
        has_one = canceller @ ErrorCode::UnauthorizedRole
    )]
    pub config: Box<Account<'info, ProtocolConfig>>,
    #[account(
        mut,
        seeds = [
            FEE_POLICY_SEED,
            policy.domain_identity_hash.as_ref(),
            policy.direction.seed().as_ref(),
            policy.quote_asset.subject_id.as_ref()
        ],
        bump = policy.bump
    )]
    pub policy: Box<Account<'info, FeePolicyRecord>>,
}

#[derive(Accounts)]
pub struct PauseFeePolicy<'info> {
    pub pauser: Signer<'info>,
    #[account(
        seeds = [PROTOCOL_CONFIG_SEED],
        bump = config.bump,
        has_one = pauser @ ErrorCode::UnauthorizedRole
    )]
    pub config: Box<Account<'info, ProtocolConfig>>,
    #[account(
        mut,
        seeds = [
            FEE_POLICY_SEED,
            policy.domain_identity_hash.as_ref(),
            policy.direction.seed().as_ref(),
            policy.quote_asset.subject_id.as_ref()
        ],
        bump = policy.bump
    )]
    pub policy: Box<Account<'info, FeePolicyRecord>>,
}

#[derive(Accounts)]
pub struct ProposeFeePolicyResume<'info> {
    pub proposer: Signer<'info>,
    #[account(
        seeds = [PROTOCOL_CONFIG_SEED],
        bump = config.bump,
        has_one = proposer @ ErrorCode::UnauthorizedRole
    )]
    pub config: Box<Account<'info, ProtocolConfig>>,
    #[account(
        mut,
        seeds = [
            FEE_POLICY_SEED,
            policy.domain_identity_hash.as_ref(),
            policy.direction.seed().as_ref(),
            policy.quote_asset.subject_id.as_ref()
        ],
        bump = policy.bump
    )]
    pub policy: Box<Account<'info, FeePolicyRecord>>,
}

#[derive(Accounts)]
pub struct CancelFeePolicyResume<'info> {
    pub canceller: Signer<'info>,
    #[account(
        seeds = [PROTOCOL_CONFIG_SEED],
        bump = config.bump,
        has_one = canceller @ ErrorCode::UnauthorizedRole
    )]
    pub config: Box<Account<'info, ProtocolConfig>>,
    #[account(
        mut,
        seeds = [
            FEE_POLICY_SEED,
            policy.domain_identity_hash.as_ref(),
            policy.direction.seed().as_ref(),
            policy.quote_asset.subject_id.as_ref()
        ],
        bump = policy.bump
    )]
    pub policy: Box<Account<'info, FeePolicyRecord>>,
}

#[derive(Accounts)]
pub struct ActivateFeePolicyResume<'info> {
    pub executor: Signer<'info>,
    #[account(
        seeds = [PROTOCOL_CONFIG_SEED],
        bump = config.bump,
        has_one = executor @ ErrorCode::UnauthorizedRole
    )]
    pub config: Box<Account<'info, ProtocolConfig>>,
    #[account(
        mut,
        seeds = [
            FEE_POLICY_SEED,
            policy.domain_identity_hash.as_ref(),
            policy.direction.seed().as_ref(),
            policy.quote_asset.subject_id.as_ref()
        ],
        bump = policy.bump
    )]
    pub policy: Box<Account<'info, FeePolicyRecord>>,
}

pub(crate) fn propose(ctx: Context<ProposeFeePolicy>, args: ProposeFeePolicyArgs) -> Result<()> {
    args.quote_asset.validate()?;
    require!(
        args.expected_domain_identity_hash == domain_ref_identity_hash(&ctx.accounts.config.domain),
        ErrorCode::FeePolicyIdentityMismatch
    );
    require!(args.version != 0, ErrorCode::FeePolicyVersionZero);
    require!(
        args.manifest_hash != [0u8; HASH_BYTE_LENGTH],
        ErrorCode::FeePolicyHashZero
    );
    require_keys_neq!(
        args.protocol_fee_recipient,
        Pubkey::default(),
        ErrorCode::FeePolicyRecipientInvalid
    );
    require!(
        u32::from(args.maximum_protocol_fee_bps) + u32::from(args.maximum_solver_fee_bps)
            <= u32::from(HARD_MAX_TOTAL_FEE_BPS),
        ErrorCode::FeePolicyCapTooHigh
    );

    let policy = &mut ctx.accounts.policy;
    if policy.quote_asset.subject_id == [0u8; HASH_BYTE_LENGTH] {
        policy.domain = ctx.accounts.config.domain.clone();
        policy.domain_identity_hash = args.expected_domain_identity_hash;
        policy.direction = args.direction;
        policy.quote_asset = args.quote_asset.clone();
        policy.active_version = 0;
        policy.active_manifest_hash = [0u8; HASH_BYTE_LENGTH];
        policy.maximum_protocol_fee_bps = 0;
        policy.maximum_solver_fee_bps = 0;
        policy.protocol_fee_recipient = Pubkey::default();
        policy.paused = false;
        policy.pending = None;
        policy.pending_resume_slot = None;
        policy.bump = ctx.bumps.policy;
    } else {
        policy.validate_identity(
            &ctx.accounts.config.domain,
            args.direction,
            &args.quote_asset,
        )?;
    }
    require!(policy.pending.is_none(), ErrorCode::FeePolicyProposalExists);
    require_gt!(
        args.version,
        policy.active_version,
        ErrorCode::FeePolicyVersionNotIncreasing
    );
    let activation_slot = Clock::get()?
        .slot
        .checked_add(ctx.accounts.config.config_delay_slots)
        .ok_or_else(|| error!(ErrorCode::ActivationSlotOverflow))?;
    policy.pending = Some(PendingFeePolicy {
        version: args.version,
        manifest_hash: args.manifest_hash,
        maximum_protocol_fee_bps: args.maximum_protocol_fee_bps,
        maximum_solver_fee_bps: args.maximum_solver_fee_bps,
        protocol_fee_recipient: args.protocol_fee_recipient,
        activation_slot,
    });
    emit!(FeePolicyProposed {
        actor: ctx.accounts.proposer.key(),
        policy: policy.key(),
        direction: args.direction,
        quote_asset: args.quote_asset,
        version: args.version,
        manifest_hash: args.manifest_hash,
        maximum_protocol_fee_bps: args.maximum_protocol_fee_bps,
        maximum_solver_fee_bps: args.maximum_solver_fee_bps,
        protocol_fee_recipient: args.protocol_fee_recipient,
        activation_slot,
    });
    Ok(())
}

pub(crate) fn activate(ctx: Context<ActivateFeePolicy>) -> Result<()> {
    require!(
        ctx.accounts.policy.domain == ctx.accounts.config.domain,
        ErrorCode::FeePolicyIdentityMismatch
    );
    let pending = ctx
        .accounts
        .policy
        .pending
        .clone()
        .ok_or_else(|| error!(ErrorCode::FeePolicyProposalMissing))?;
    require_gte!(
        Clock::get()?.slot,
        pending.activation_slot,
        ErrorCode::FeePolicyProposalNotReady
    );
    require_gt!(
        pending.version,
        ctx.accounts.policy.active_version,
        ErrorCode::FeePolicyVersionNotIncreasing
    );
    let policy = &mut ctx.accounts.policy;
    policy.active_version = pending.version;
    policy.active_manifest_hash = pending.manifest_hash;
    policy.maximum_protocol_fee_bps = pending.maximum_protocol_fee_bps;
    policy.maximum_solver_fee_bps = pending.maximum_solver_fee_bps;
    policy.protocol_fee_recipient = pending.protocol_fee_recipient;
    policy.pending = None;
    emit!(FeePolicyActivated {
        actor: ctx.accounts.executor.key(),
        policy: policy.key(),
        version: policy.active_version,
        manifest_hash: policy.active_manifest_hash,
        maximum_protocol_fee_bps: policy.maximum_protocol_fee_bps,
        maximum_solver_fee_bps: policy.maximum_solver_fee_bps,
        protocol_fee_recipient: policy.protocol_fee_recipient,
        paused: policy.paused,
    });
    Ok(())
}

pub(crate) fn cancel(ctx: Context<CancelFeePolicyProposal>) -> Result<()> {
    require!(
        ctx.accounts.policy.pending.is_some(),
        ErrorCode::FeePolicyProposalMissing
    );
    ctx.accounts.policy.pending = None;
    emit!(FeePolicyProposalCancelled {
        actor: ctx.accounts.canceller.key(),
        policy: ctx.accounts.policy.key(),
    });
    Ok(())
}

pub(crate) fn pause(ctx: Context<PauseFeePolicy>) -> Result<()> {
    require!(
        ctx.accounts.policy.active_version != 0,
        ErrorCode::FeePolicyUnknown
    );
    require!(
        !ctx.accounts.policy.paused,
        ErrorCode::FeePolicyAlreadyPaused
    );
    ctx.accounts.policy.paused = true;
    ctx.accounts.policy.pending_resume_slot = None;
    emit!(FeePolicyPaused {
        actor: ctx.accounts.pauser.key(),
        policy: ctx.accounts.policy.key(),
    });
    Ok(())
}

pub(crate) fn propose_resume(ctx: Context<ProposeFeePolicyResume>) -> Result<()> {
    require!(
        ctx.accounts.policy.active_version != 0,
        ErrorCode::FeePolicyUnknown
    );
    require!(ctx.accounts.policy.paused, ErrorCode::FeePolicyNotPaused);
    require!(
        ctx.accounts.policy.pending_resume_slot.is_none(),
        ErrorCode::FeePolicyResumeExists
    );
    let activation_slot = Clock::get()?
        .slot
        .checked_add(ctx.accounts.config.config_delay_slots)
        .ok_or_else(|| error!(ErrorCode::ActivationSlotOverflow))?;
    ctx.accounts.policy.pending_resume_slot = Some(activation_slot);
    emit!(FeePolicyResumeProposed {
        actor: ctx.accounts.proposer.key(),
        policy: ctx.accounts.policy.key(),
        activation_slot,
    });
    Ok(())
}

pub(crate) fn cancel_resume(ctx: Context<CancelFeePolicyResume>) -> Result<()> {
    require!(
        ctx.accounts.policy.pending_resume_slot.is_some(),
        ErrorCode::FeePolicyResumeMissing
    );
    ctx.accounts.policy.pending_resume_slot = None;
    emit!(FeePolicyResumeCancelled {
        actor: ctx.accounts.canceller.key(),
        policy: ctx.accounts.policy.key(),
    });
    Ok(())
}

pub(crate) fn activate_resume(ctx: Context<ActivateFeePolicyResume>) -> Result<()> {
    require!(
        ctx.accounts.policy.domain == ctx.accounts.config.domain,
        ErrorCode::FeePolicyIdentityMismatch
    );
    let activation_slot = ctx
        .accounts
        .policy
        .pending_resume_slot
        .ok_or_else(|| error!(ErrorCode::FeePolicyResumeMissing))?;
    require_gte!(
        Clock::get()?.slot,
        activation_slot,
        ErrorCode::FeePolicyResumeNotReady
    );
    require!(ctx.accounts.policy.paused, ErrorCode::FeePolicyNotPaused);
    ctx.accounts.policy.paused = false;
    ctx.accounts.policy.pending_resume_slot = None;
    emit!(FeePolicyResumeActivated {
        actor: ctx.accounts.executor.key(),
        policy: ctx.accounts.policy.key(),
    });
    Ok(())
}

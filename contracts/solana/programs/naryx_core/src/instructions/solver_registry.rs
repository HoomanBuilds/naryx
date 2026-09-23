use anchor_lang::prelude::*;

use crate::{
    constants::{PROTOCOL_CONFIG_SEED, SOLVER_REGISTRY_SEED},
    error::ErrorCode,
    state::{PendingSolver, ProtocolConfig, SolverRegistry},
};

#[derive(Accounts)]
pub struct ProposeSolver<'info> {
    #[account(mut)]
    pub proposer: Signer<'info>,
    #[account(
        seeds = [PROTOCOL_CONFIG_SEED],
        bump = config.bump,
        has_one = proposer @ ErrorCode::UnauthorizedRole
    )]
    pub config: Account<'info, ProtocolConfig>,
    #[account(
        init_if_needed,
        payer = proposer,
        space = 8 + SolverRegistry::INIT_SPACE,
        seeds = [SOLVER_REGISTRY_SEED],
        bump
    )]
    pub registry: Account<'info, SolverRegistry>,
    pub system_program: Program<'info, System>,
}

pub(crate) fn propose(ctx: Context<ProposeSolver>, key: Pubkey) -> Result<()> {
    require_keys_neq!(key, Pubkey::default(), ErrorCode::ConformanceSolverInvalid);
    require!(
        ctx.accounts.registry.pending.is_none(),
        ErrorCode::ConformanceSolverProposalExists
    );
    let activation_slot = Clock::get()?
        .slot
        .checked_add(ctx.accounts.config.config_delay_slots)
        .ok_or_else(|| error!(ErrorCode::ActivationSlotOverflow))?;
    ctx.accounts.registry.pending = Some(PendingSolver {
        key,
        activation_slot,
    });
    ctx.accounts.registry.bump = ctx.bumps.registry;
    Ok(())
}

#[derive(Accounts)]
pub struct ActivateSolver<'info> {
    pub executor: Signer<'info>,
    #[account(
        seeds = [PROTOCOL_CONFIG_SEED],
        bump = config.bump,
        has_one = executor @ ErrorCode::UnauthorizedRole
    )]
    pub config: Account<'info, ProtocolConfig>,
    #[account(mut, seeds = [SOLVER_REGISTRY_SEED], bump = registry.bump)]
    pub registry: Account<'info, SolverRegistry>,
}

pub(crate) fn activate(ctx: Context<ActivateSolver>) -> Result<()> {
    let pending = ctx
        .accounts
        .registry
        .pending
        .clone()
        .ok_or_else(|| error!(ErrorCode::ConformanceSolverProposalMissing))?;
    require_gte!(
        Clock::get()?.slot,
        pending.activation_slot,
        ErrorCode::ConformanceSolverProposalNotReady
    );
    ctx.accounts.registry.active = pending.key;
    ctx.accounts.registry.pending = None;
    Ok(())
}

#[derive(Accounts)]
pub struct CancelSolver<'info> {
    pub canceller: Signer<'info>,
    #[account(
        seeds = [PROTOCOL_CONFIG_SEED],
        bump = config.bump,
        has_one = canceller @ ErrorCode::UnauthorizedRole
    )]
    pub config: Account<'info, ProtocolConfig>,
    #[account(mut, seeds = [SOLVER_REGISTRY_SEED], bump = registry.bump)]
    pub registry: Account<'info, SolverRegistry>,
}

pub(crate) fn cancel(ctx: Context<CancelSolver>) -> Result<()> {
    require!(
        ctx.accounts.registry.pending.take().is_some(),
        ErrorCode::ConformanceSolverProposalMissing
    );
    Ok(())
}

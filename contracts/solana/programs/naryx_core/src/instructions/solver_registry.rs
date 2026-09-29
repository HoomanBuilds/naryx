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
    let activation_slot = Clock::get()?
        .slot
        .checked_add(ctx.accounts.config.config_delay_slots)
        .ok_or_else(|| error!(ErrorCode::ActivationSlotOverflow))?;
    queue_proposal(&mut ctx.accounts.registry, key, activation_slot)?;
    ctx.accounts.registry.bump = ctx.bumps.registry;
    Ok(())
}

fn queue_proposal(registry: &mut SolverRegistry, key: Pubkey, activation_slot: u64) -> Result<()> {
    require_keys_neq!(key, Pubkey::default(), ErrorCode::ConformanceSolverInvalid);
    require!(!registry.is_active(&key), ErrorCode::SolverAlreadyActive);
    require!(
        registry.pending.iter().all(|pending| pending.key != key),
        ErrorCode::ConformanceSolverProposalExists
    );
    require!(
        registry.pending.len() < SolverRegistry::MAX_PENDING,
        ErrorCode::SolverSetFull
    );
    registry.pending.push(PendingSolver {
        key,
        activation_slot,
    });
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

pub(crate) fn activate(ctx: Context<ActivateSolver>, key: Pubkey) -> Result<()> {
    activate_pending(&mut ctx.accounts.registry, key, Clock::get()?.slot)
}

fn activate_pending(registry: &mut SolverRegistry, key: Pubkey, slot: u64) -> Result<()> {
    let index = registry
        .pending
        .iter()
        .position(|pending| pending.key == key)
        .ok_or_else(|| error!(ErrorCode::ConformanceSolverProposalMissing))?;
    require_gte!(
        slot,
        registry.pending[index].activation_slot,
        ErrorCode::ConformanceSolverProposalNotReady
    );
    require!(
        registry.active.len() < SolverRegistry::MAX_ACTIVE,
        ErrorCode::SolverSetFull
    );
    registry.pending.remove(index);
    registry.active.push(key);
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

pub(crate) fn cancel(ctx: Context<CancelSolver>, key: Pubkey) -> Result<()> {
    let registry = &mut ctx.accounts.registry;
    let index = registry
        .pending
        .iter()
        .position(|pending| pending.key == key)
        .ok_or_else(|| error!(ErrorCode::ConformanceSolverProposalMissing))?;
    registry.pending.remove(index);
    Ok(())
}

#[derive(Accounts)]
pub struct RemoveSolver<'info> {
    pub pauser: Signer<'info>,
    #[account(
        seeds = [PROTOCOL_CONFIG_SEED],
        bump = config.bump,
        has_one = pauser @ ErrorCode::UnauthorizedRole
    )]
    pub config: Account<'info, ProtocolConfig>,
    #[account(mut, seeds = [SOLVER_REGISTRY_SEED], bump = registry.bump)]
    pub registry: Account<'info, SolverRegistry>,
}

/// Revokes a solver's settlement authority at once; quotes it already signed stop settling.
pub(crate) fn remove(ctx: Context<RemoveSolver>, key: Pubkey) -> Result<()> {
    remove_active(&mut ctx.accounts.registry, key)
}

fn remove_active(registry: &mut SolverRegistry, key: Pubkey) -> Result<()> {
    let index = registry
        .active
        .iter()
        .position(|active| *active == key)
        .ok_or_else(|| error!(ErrorCode::SolverNotActive))?;
    registry.active.swap_remove(index);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn registry() -> SolverRegistry {
        SolverRegistry {
            active: Vec::new(),
            pending: Vec::new(),
            bump: 255,
        }
    }

    #[test]
    fn additions_wait_for_their_slot_and_removals_are_immediate() {
        let first = Pubkey::new_unique();
        let second = Pubkey::new_unique();
        let mut registry = registry();
        assert!(!registry.is_active(&first));
        queue_proposal(&mut registry, first, 10).unwrap();
        queue_proposal(&mut registry, second, 12).unwrap();
        assert!(queue_proposal(&mut registry, first, 20).is_err());
        assert!(activate_pending(&mut registry, first, 9).is_err());
        activate_pending(&mut registry, first, 10).unwrap();
        activate_pending(&mut registry, second, 12).unwrap();
        assert!(registry.is_active(&first) && registry.is_active(&second));
        assert!(registry.pending.is_empty());
        assert!(queue_proposal(&mut registry, first, 30).is_err());

        remove_active(&mut registry, first).unwrap();
        assert!(!registry.is_active(&first));
        assert!(registry.is_active(&second));
        assert!(remove_active(&mut registry, first).is_err());
        remove_active(&mut registry, second).unwrap();
        assert!(registry.active.is_empty());
        assert!(!registry.is_active(&Pubkey::default()));
    }

    #[test]
    fn the_set_and_the_queue_are_bounded_and_the_default_key_is_refused() {
        let mut registry = registry();
        assert!(queue_proposal(&mut registry, Pubkey::default(), 1).is_err());
        for _ in 0..SolverRegistry::MAX_PENDING {
            queue_proposal(&mut registry, Pubkey::new_unique(), 1).unwrap();
        }
        assert!(queue_proposal(&mut registry, Pubkey::new_unique(), 1).is_err());
        registry.pending.clear();
        registry.active = (0..SolverRegistry::MAX_ACTIVE)
            .map(|_| Pubkey::new_unique())
            .collect();
        let late = Pubkey::new_unique();
        queue_proposal(&mut registry, late, 1).unwrap();
        assert!(activate_pending(&mut registry, late, 1).is_err());
        assert!(!registry.is_active(&late));
    }
}

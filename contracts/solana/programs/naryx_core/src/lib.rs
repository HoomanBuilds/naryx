pub mod constants;
pub mod error;
pub mod events;
pub mod instructions;
pub mod state;
pub mod wire;

use anchor_lang::prelude::*;

pub use {constants::*, instructions::*, wire::*};

declare_id!("8qmA9VuQwAAqQ3F93CAfLNFB3P8M8ygXgvn9xCnZXa2i");

#[cfg(not(feature = "conformance"))]
#[program]
pub mod naryx_core {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        environment: String,
        domain_id: String,
        domain_manifest_version: u32,
        domain_manifest_hash: [u8; HASH_BYTE_LENGTH],
        config_delay_slots: u64,
        roles: GovernanceRoles,
    ) -> Result<()> {
        instructions::initialize::handler(
            ctx,
            environment,
            domain_id,
            domain_manifest_version,
            domain_manifest_hash,
            config_delay_slots,
            roles,
        )
    }

    pub fn propose_domain(
        ctx: Context<ProposeDomain>,
        domain_manifest_version: u32,
        domain_manifest_hash: [u8; HASH_BYTE_LENGTH],
    ) -> Result<()> {
        instructions::propose_domain::handler(ctx, domain_manifest_version, domain_manifest_hash)
    }

    pub fn cancel_domain_proposal(ctx: Context<CancelDomainProposal>) -> Result<()> {
        instructions::cancel_domain_proposal::handler(ctx)
    }

    pub fn activate_domain(ctx: Context<ActivateDomain>) -> Result<()> {
        instructions::activate_domain::handler(ctx)
    }

    pub fn pause_entry(ctx: Context<PauseEntry>) -> Result<()> {
        instructions::pause_entry::handler(ctx)
    }

    pub fn schedule_unpause(ctx: Context<ScheduleUnpause>) -> Result<()> {
        instructions::schedule_unpause::handler(ctx)
    }

    pub fn cancel_unpause(ctx: Context<CancelUnpause>) -> Result<()> {
        instructions::cancel_unpause::handler(ctx)
    }

    pub fn activate_unpause(ctx: Context<ActivateUnpause>) -> Result<()> {
        instructions::activate_unpause::handler(ctx)
    }
}

#[cfg(feature = "conformance")]
#[program]
pub mod naryx_core {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        environment: String,
        domain_id: String,
        domain_manifest_version: u32,
        domain_manifest_hash: [u8; HASH_BYTE_LENGTH],
        config_delay_slots: u64,
        roles: GovernanceRoles,
    ) -> Result<()> {
        instructions::initialize::handler(
            ctx,
            environment,
            domain_id,
            domain_manifest_version,
            domain_manifest_hash,
            config_delay_slots,
            roles,
        )
    }

    pub fn propose_domain(
        ctx: Context<ProposeDomain>,
        domain_manifest_version: u32,
        domain_manifest_hash: [u8; HASH_BYTE_LENGTH],
    ) -> Result<()> {
        instructions::propose_domain::handler(ctx, domain_manifest_version, domain_manifest_hash)
    }

    pub fn cancel_domain_proposal(ctx: Context<CancelDomainProposal>) -> Result<()> {
        instructions::cancel_domain_proposal::handler(ctx)
    }

    pub fn activate_domain(ctx: Context<ActivateDomain>) -> Result<()> {
        instructions::activate_domain::handler(ctx)
    }

    pub fn pause_entry(ctx: Context<PauseEntry>) -> Result<()> {
        instructions::pause_entry::handler(ctx)
    }

    pub fn schedule_unpause(ctx: Context<ScheduleUnpause>) -> Result<()> {
        instructions::schedule_unpause::handler(ctx)
    }

    pub fn cancel_unpause(ctx: Context<CancelUnpause>) -> Result<()> {
        instructions::cancel_unpause::handler(ctx)
    }

    pub fn activate_unpause(ctx: Context<ActivateUnpause>) -> Result<()> {
        instructions::activate_unpause::handler(ctx)
    }

    pub fn execute_conformance_atomic(
        ctx: Context<ExecuteConformanceAtomic>,
        order_hash: [u8; HASH_BYTE_LENGTH],
        quote_hash: [u8; HASH_BYTE_LENGTH],
        route_hash: [u8; HASH_BYTE_LENGTH],
        args: ConformanceExecutionArgs,
    ) -> Result<()> {
        instructions::execute_conformance_atomic::handler(
            ctx, order_hash, quote_hash, route_hash, args,
        )
    }
}

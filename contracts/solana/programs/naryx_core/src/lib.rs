pub mod constants;
pub mod error;
pub mod events;
pub mod instructions;
pub mod reservation_policy;
pub mod state;
pub mod wire;

use anchor_lang::prelude::*;

pub use {
    constants::*,
    instructions::*,
    state::{Lifecycle, ResourceControl},
    wire::*,
};

declare_id!("GpwzEWfFySnTdRp8iTPYz9AmsbePDeeC5ThGhMV5PxPq");

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

    pub fn propose_asset(ctx: Context<ProposeAsset>, args: ProposeAssetArgs) -> Result<()> {
        instructions::resource_registry::propose_asset(ctx, args)
    }

    pub fn propose_venue(ctx: Context<ProposeVenue>, args: ProposeVenueArgs) -> Result<()> {
        instructions::resource_registry::propose_venue(ctx, args)
    }

    pub fn propose_market(ctx: Context<ProposeMarket>, args: ProposeMarketArgs) -> Result<()> {
        instructions::resource_registry::propose_market(ctx, args)
    }

    pub fn propose_adapter(ctx: Context<ProposeAdapter>, args: ProposeAdapterArgs) -> Result<()> {
        instructions::resource_registry::propose_adapter(ctx, args)
    }

    pub fn activate_initial_resource(ctx: Context<ActivateInitialResource>) -> Result<()> {
        instructions::resource_registry::activate_initial_resource(ctx)
    }

    pub fn activate_resource_version(ctx: Context<ActivateResourceVersion>) -> Result<()> {
        instructions::resource_registry::activate_resource_version(ctx)
    }

    pub fn cancel_resource_registration(ctx: Context<CancelResourceRegistration>) -> Result<()> {
        instructions::resource_registry::cancel_resource_registration(ctx)
    }

    pub fn propose_resource_control(
        ctx: Context<ProposeResourceControl>,
        control: ResourceControl,
    ) -> Result<()> {
        instructions::resource_registry::propose_resource_control(ctx, control)
    }

    pub fn cancel_resource_control(ctx: Context<CancelResourceControl>) -> Result<()> {
        instructions::resource_registry::cancel_resource_control(ctx)
    }

    pub fn activate_resource_control(ctx: Context<ActivateResourceControl>) -> Result<()> {
        instructions::resource_registry::activate_resource_control(ctx)
    }

    pub fn tighten_resource_control(
        ctx: Context<TightenResourceControl>,
        control: ResourceControl,
    ) -> Result<()> {
        instructions::resource_registry::tighten_resource_control(ctx, control)
    }

    pub fn propose_initial_cash_carry_series_binding(
        ctx: Context<ProposeInitialCashCarrySeriesBinding>,
        args: ProposeCashCarrySeriesBindingArgs,
    ) -> Result<()> {
        instructions::series_registry::propose_initial(ctx, args)
    }

    pub fn propose_cash_carry_series_binding_version(
        ctx: Context<ProposeCashCarrySeriesBindingVersion>,
        args: ProposeCashCarrySeriesBindingArgs,
    ) -> Result<()> {
        instructions::series_registry::propose_version(ctx, args)
    }

    pub fn activate_initial_cash_carry_series_binding(
        ctx: Context<ActivateInitialCashCarrySeriesBinding>,
    ) -> Result<()> {
        instructions::series_registry::activate_initial(ctx)
    }

    pub fn activate_cash_carry_series_binding_version(
        ctx: Context<ActivateCashCarrySeriesBindingVersion>,
    ) -> Result<()> {
        instructions::series_registry::activate_version(ctx)
    }

    pub fn cancel_cash_carry_series_binding_registration(
        ctx: Context<CancelCashCarrySeriesBindingRegistration>,
    ) -> Result<()> {
        instructions::series_registry::cancel_registration(ctx)
    }

    pub fn propose_cash_carry_series_binding_control(
        ctx: Context<ProposeCashCarrySeriesBindingControl>,
        lifecycle: Lifecycle,
    ) -> Result<()> {
        instructions::series_registry::propose_control(ctx, lifecycle)
    }

    pub fn cancel_cash_carry_series_binding_control(
        ctx: Context<CancelCashCarrySeriesBindingControl>,
    ) -> Result<()> {
        instructions::series_registry::cancel_control(ctx)
    }

    pub fn activate_cash_carry_series_binding_control(
        ctx: Context<ActivateCashCarrySeriesBindingControl>,
    ) -> Result<()> {
        instructions::series_registry::activate_control(ctx)
    }

    pub fn tighten_cash_carry_series_binding(
        ctx: Context<TightenCashCarrySeriesBinding>,
        lifecycle: Lifecycle,
    ) -> Result<()> {
        instructions::series_registry::tighten(ctx, lifecycle)
    }

    pub fn propose_solver(ctx: Context<ProposeSolver>, key: Pubkey) -> Result<()> {
        instructions::solver_registry::propose(ctx, key)
    }

    pub fn activate_solver(ctx: Context<ActivateSolver>, key: Pubkey) -> Result<()> {
        instructions::solver_registry::activate(ctx, key)
    }

    pub fn cancel_solver(ctx: Context<CancelSolver>, key: Pubkey) -> Result<()> {
        instructions::solver_registry::cancel(ctx, key)
    }

    pub fn remove_solver(ctx: Context<RemoveSolver>, key: Pubkey) -> Result<()> {
        instructions::solver_registry::remove(ctx, key)
    }

    pub fn initialize_cash_carry_strategy(ctx: Context<InitializeCashCarryStrategy>) -> Result<()> {
        instructions::cash_carry_strategy::initialize_handler(ctx)
    }

    pub fn execute_cash_and_carry<'info>(
        ctx: Context<'info, ExecuteCashAndCarry<'info>>,
        order_hash: [u8; HASH_BYTE_LENGTH],
        quote_hash: [u8; HASH_BYTE_LENGTH],
        route_hash: [u8; HASH_BYTE_LENGTH],
        args: CashCarryExecutionArgs,
    ) -> Result<()> {
        instructions::execute_cash_and_carry::handler(ctx, order_hash, quote_hash, route_hash, args)
    }

    pub fn execute_quoted_cash_and_carry<'info>(
        ctx: Context<'info, ExecuteCashAndCarry<'info>>,
        order_hash: [u8; HASH_BYTE_LENGTH],
        quote_hash: [u8; HASH_BYTE_LENGTH],
        route_hash: [u8; HASH_BYTE_LENGTH],
        args: CashCarryExecutionArgs,
        quote_args: CashCarryQuoteArgs,
    ) -> Result<()> {
        instructions::execute_cash_and_carry::quoted_handler(
            ctx, order_hash, quote_hash, route_hash, args, quote_args,
        )
    }

    pub fn execute_firm_cash_and_carry<'info>(
        ctx: Context<'info, ExecuteFirmCashAndCarry<'info>>,
        order_hash: [u8; HASH_BYTE_LENGTH],
        quote_hash: [u8; HASH_BYTE_LENGTH],
        route_hash: [u8; HASH_BYTE_LENGTH],
        args: CashCarryExecutionArgs,
        quote_args: CashCarryQuoteArgs,
        firm_quote_atoms: u64,
    ) -> Result<()> {
        instructions::execute_firm_cash_and_carry::handler(
            ctx,
            order_hash,
            quote_hash,
            route_hash,
            args,
            quote_args,
            firm_quote_atoms,
        )
    }

    pub fn lock_firm_quote<'info>(
        ctx: Context<'info, LockFirmQuote<'info>>,
        order_hash: [u8; HASH_BYTE_LENGTH],
        quote_hash: [u8; HASH_BYTE_LENGTH],
        route_hash: [u8; HASH_BYTE_LENGTH],
        quote_args: CashCarryQuoteArgs,
    ) -> Result<()> {
        instructions::execute_firm_cash_and_carry::lock_firm_quote_handler(
            ctx, order_hash, quote_hash, route_hash, quote_args,
        )
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

    pub fn propose_asset(ctx: Context<ProposeAsset>, args: ProposeAssetArgs) -> Result<()> {
        instructions::resource_registry::propose_asset(ctx, args)
    }

    pub fn propose_venue(ctx: Context<ProposeVenue>, args: ProposeVenueArgs) -> Result<()> {
        instructions::resource_registry::propose_venue(ctx, args)
    }

    pub fn propose_market(ctx: Context<ProposeMarket>, args: ProposeMarketArgs) -> Result<()> {
        instructions::resource_registry::propose_market(ctx, args)
    }

    pub fn propose_adapter(ctx: Context<ProposeAdapter>, args: ProposeAdapterArgs) -> Result<()> {
        instructions::resource_registry::propose_adapter(ctx, args)
    }

    pub fn activate_initial_resource(ctx: Context<ActivateInitialResource>) -> Result<()> {
        instructions::resource_registry::activate_initial_resource(ctx)
    }

    pub fn activate_resource_version(ctx: Context<ActivateResourceVersion>) -> Result<()> {
        instructions::resource_registry::activate_resource_version(ctx)
    }

    pub fn cancel_resource_registration(ctx: Context<CancelResourceRegistration>) -> Result<()> {
        instructions::resource_registry::cancel_resource_registration(ctx)
    }

    pub fn propose_resource_control(
        ctx: Context<ProposeResourceControl>,
        control: ResourceControl,
    ) -> Result<()> {
        instructions::resource_registry::propose_resource_control(ctx, control)
    }

    pub fn cancel_resource_control(ctx: Context<CancelResourceControl>) -> Result<()> {
        instructions::resource_registry::cancel_resource_control(ctx)
    }

    pub fn activate_resource_control(ctx: Context<ActivateResourceControl>) -> Result<()> {
        instructions::resource_registry::activate_resource_control(ctx)
    }

    pub fn tighten_resource_control(
        ctx: Context<TightenResourceControl>,
        control: ResourceControl,
    ) -> Result<()> {
        instructions::resource_registry::tighten_resource_control(ctx, control)
    }

    pub fn propose_initial_cash_carry_series_binding(
        ctx: Context<ProposeInitialCashCarrySeriesBinding>,
        args: ProposeCashCarrySeriesBindingArgs,
    ) -> Result<()> {
        instructions::series_registry::propose_initial(ctx, args)
    }

    pub fn propose_cash_carry_series_binding_version(
        ctx: Context<ProposeCashCarrySeriesBindingVersion>,
        args: ProposeCashCarrySeriesBindingArgs,
    ) -> Result<()> {
        instructions::series_registry::propose_version(ctx, args)
    }

    pub fn activate_initial_cash_carry_series_binding(
        ctx: Context<ActivateInitialCashCarrySeriesBinding>,
    ) -> Result<()> {
        instructions::series_registry::activate_initial(ctx)
    }

    pub fn activate_cash_carry_series_binding_version(
        ctx: Context<ActivateCashCarrySeriesBindingVersion>,
    ) -> Result<()> {
        instructions::series_registry::activate_version(ctx)
    }

    pub fn cancel_cash_carry_series_binding_registration(
        ctx: Context<CancelCashCarrySeriesBindingRegistration>,
    ) -> Result<()> {
        instructions::series_registry::cancel_registration(ctx)
    }

    pub fn propose_cash_carry_series_binding_control(
        ctx: Context<ProposeCashCarrySeriesBindingControl>,
        lifecycle: Lifecycle,
    ) -> Result<()> {
        instructions::series_registry::propose_control(ctx, lifecycle)
    }

    pub fn cancel_cash_carry_series_binding_control(
        ctx: Context<CancelCashCarrySeriesBindingControl>,
    ) -> Result<()> {
        instructions::series_registry::cancel_control(ctx)
    }

    pub fn activate_cash_carry_series_binding_control(
        ctx: Context<ActivateCashCarrySeriesBindingControl>,
    ) -> Result<()> {
        instructions::series_registry::activate_control(ctx)
    }

    pub fn tighten_cash_carry_series_binding(
        ctx: Context<TightenCashCarrySeriesBinding>,
        lifecycle: Lifecycle,
    ) -> Result<()> {
        instructions::series_registry::tighten(ctx, lifecycle)
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

    pub fn propose_solver(ctx: Context<ProposeSolver>, key: Pubkey) -> Result<()> {
        instructions::solver_registry::propose(ctx, key)
    }

    pub fn activate_solver(ctx: Context<ActivateSolver>, key: Pubkey) -> Result<()> {
        instructions::solver_registry::activate(ctx, key)
    }

    pub fn cancel_solver(ctx: Context<CancelSolver>, key: Pubkey) -> Result<()> {
        instructions::solver_registry::cancel(ctx, key)
    }

    pub fn remove_solver(ctx: Context<RemoveSolver>, key: Pubkey) -> Result<()> {
        instructions::solver_registry::remove(ctx, key)
    }
}

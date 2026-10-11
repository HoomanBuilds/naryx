pub mod constants;
pub mod error;
pub mod events;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("CDaUbFWSG6rh5mgjAr63157Ha7upZmza5SF47xgSaxqj");

#[program]
pub mod naryx_multi_strategy {
    use super::*;

    pub fn initialize_multi_strategy_account(
        ctx: Context<InitializeMultiStrategyAccount>,
    ) -> Result<()> {
        initialize::initialize_handler(ctx)
    }

    pub fn execute_multi_strategy<'info>(
        ctx: Context<'info, ExecuteMultiStrategy<'info>>,
        execution: StrategyExecutionArgs,
        calls: Vec<StrategyCallArgs>,
    ) -> Result<()> {
        execute::execute_handler(ctx, execution, calls)
    }

    pub fn execute_netting_allocation<'info>(
        ctx: Context<'info, ExecuteMultiStrategy<'info>>,
        execution: StrategyExecutionArgs,
        calls: Vec<StrategyCallArgs>,
        authorization_hash: [u8; 32],
    ) -> Result<()> {
        execute::netting_allocation_handler(ctx, execution, calls, authorization_hash)
    }

    pub fn execute_multi_strategy_recovery<'info>(
        ctx: Context<'info, ExecuteMultiStrategyRecovery<'info>>,
        execution: StrategyExecutionArgs,
        calls: Vec<StrategyCallArgs>,
    ) -> Result<()> {
        execute::recovery_handler(ctx, execution, calls)
    }

    pub fn withdraw_idle_token(ctx: Context<WithdrawIdleToken>, amount: u64) -> Result<()> {
        withdraw::withdraw_handler(ctx, amount)
    }
}

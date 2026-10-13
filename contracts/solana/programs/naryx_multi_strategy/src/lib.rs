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

    pub fn initialize_execution_stage(
        ctx: Context<InitializeExecutionStage>,
        nonce: u64,
        solver: Pubkey,
        expected_hash: [u8; 32],
        payload_len: u16,
        deadline_slot: u64,
    ) -> Result<()> {
        stage::initialize_stage_handler(ctx, nonce, solver, expected_hash, payload_len, deadline_slot)
    }

    pub fn write_execution_stage(
        ctx: Context<WriteExecutionStage>,
        offset: u16,
        bytes: Vec<u8>,
    ) -> Result<()> {
        stage::write_stage_handler(ctx, offset, bytes)
    }

    pub fn seal_execution_stage(ctx: Context<WriteExecutionStage>) -> Result<()> {
        stage::seal_stage_handler(ctx)
    }

    pub fn cancel_execution_stage(ctx: Context<CancelExecutionStage>) -> Result<()> {
        stage::cancel_stage_handler(ctx)
    }

    pub fn execute_staged_multi_strategy<'info>(
        ctx: Context<'info, ExecuteStagedMultiStrategy<'info>>,
        package_id: [u8; 32],
        nonce: u64,
    ) -> Result<()> {
        execute::execute_staged_handler(ctx, package_id, nonce)
    }

    pub fn withdraw_idle_token(ctx: Context<WithdrawIdleToken>, amount: u64) -> Result<()> {
        withdraw::withdraw_handler(ctx, amount)
    }
}

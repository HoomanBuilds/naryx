pub mod error;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;

pub use instructions::*;
pub use naryx_test_perp::{
    read_position_and_collateral, ID as TEST_PERP_PROGRAM_ID, PYTH_RECEIVER_PROGRAM_ID,
};
pub use state::*;

declare_id!("H6YQpuLPKTWq7gVcqTa7c5sax7WubnpgG5cdohgZvxT1");

pub const TEST_PERP_STRATEGY_SEED: &[u8] = b"test-perp-strategy";

#[program]
pub mod naryx_test_perp_adapter {
    use super::*;

    pub fn initialize_test_perp_strategy(
        ctx: Context<InitializeTestPerpStrategy>,
        args: InitializeTestPerpStrategyArgs,
    ) -> Result<()> {
        instructions::initialize(ctx, args)
    }

    pub fn test_perp_enter_short(
        ctx: Context<ExecuteTestPerpOrder>,
        args: TestPerpMarketOrderArgs,
    ) -> Result<()> {
        instructions::execute_order(ctx, args, TestPerpShortAction::Enter).map(|_| ())
    }

    pub fn test_perp_increase_short(
        ctx: Context<ExecuteTestPerpOrder>,
        args: TestPerpMarketOrderArgs,
    ) -> Result<()> {
        instructions::execute_order(ctx, args, TestPerpShortAction::Increase).map(|_| ())
    }

    pub fn test_perp_decrease_short(
        ctx: Context<ExecuteTestPerpOrder>,
        args: TestPerpMarketOrderArgs,
    ) -> Result<()> {
        instructions::execute_order(ctx, args, TestPerpShortAction::Decrease).map(|_| ())
    }

    pub fn test_perp_close_short(
        ctx: Context<ExecuteTestPerpOrder>,
        args: TestPerpMarketOrderArgs,
    ) -> Result<()> {
        instructions::execute_order(ctx, args, TestPerpShortAction::Close).map(|_| ())
    }

    pub fn execute_typed_strategy_leg(
        ctx: Context<ExecuteTestPerpOrder>,
        payload: Vec<u8>,
    ) -> Result<()> {
        instructions::execute_typed(ctx, payload)
    }
}

pub mod error;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;

pub use instructions::*;
pub use naryx_test_perp::{
    read_position_and_collateral, ID as TEST_PERP_PROGRAM_ID, PYTH_RECEIVER_PROGRAM_ID,
};
pub use state::*;

declare_id!("9WNFkLhjjBoqJoKVrykF41HLQtFro7bg3L6shjjHjUT1");

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
        instructions::execute_order(ctx, args, true)
    }

    pub fn test_perp_close_short(
        ctx: Context<ExecuteTestPerpOrder>,
        args: TestPerpMarketOrderArgs,
    ) -> Result<()> {
        instructions::execute_order(ctx, args, false)
    }
}

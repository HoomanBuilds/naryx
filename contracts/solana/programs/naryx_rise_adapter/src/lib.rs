pub mod constants;
pub mod error;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("9FAYFVXcJYqxcpw7bf6eK6iY6SkwYx6T4PT7NF3VjfzQ");

#[program]
pub mod naryx_rise_adapter {
    use super::*;

    pub fn initialize_rise_strategy(
        ctx: Context<InitializeRiseStrategy>,
        args: InitializeRiseStrategyArgs,
    ) -> Result<()> {
        initialize::handler(ctx, args)
    }

    pub fn rise_enter_short<'info>(
        ctx: Context<'info, ExecuteRiseOrder<'info>>,
        args: RiseMarketOrderArgs,
    ) -> Result<()> {
        market_order::enter_short(ctx, args)
    }

    pub fn rise_close_short<'info>(
        ctx: Context<'info, ExecuteRiseOrder<'info>>,
        args: RiseMarketOrderArgs,
    ) -> Result<()> {
        market_order::close_short(ctx, args)
    }

    pub fn execute_typed_strategy_leg<'info>(
        ctx: Context<'info, ExecuteRiseOrder<'info>>,
        payload: Vec<u8>,
    ) -> Result<()> {
        market_order::execute_typed(ctx, payload)
    }
}

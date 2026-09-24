pub mod constants;
pub mod error;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("7USHejoffnm7UgDhSJeF6mjT2gpEAwqRjyVmYXWx1TzP");

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
}

pub mod constants;
pub mod error;
pub mod instructions;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;

declare_id!("J3kJZ6SP1dGW2TLNYfGJrujmecsfkGkeUzcGbR6EJs5w");

#[program]
pub mod naryx_orca_adapter {
    use super::*;

    pub fn swap_exact_output(
        ctx: Context<SwapOrca>,
        amount_out: u64,
        maximum_amount_in: u64,
        sqrt_price_limit: u128,
        a_to_b: bool,
    ) -> Result<()> {
        swap::exact_output(ctx, amount_out, maximum_amount_in, sqrt_price_limit, a_to_b)
    }

    pub fn swap_exact_input(
        ctx: Context<SwapOrca>,
        amount_in: u64,
        minimum_amount_out: u64,
        sqrt_price_limit: u128,
        a_to_b: bool,
    ) -> Result<()> {
        swap::exact_input(ctx, amount_in, minimum_amount_out, sqrt_price_limit, a_to_b)
    }
}

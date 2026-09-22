pub mod constants;
pub mod error;
pub mod instructions;
pub mod state;
pub mod wire;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;

declare_id!("8qmA9VuQwAAqQ3F93CAfLNFB3P8M8ygXgvn9xCnZXa2i");

#[program]
pub mod naryx_core {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        initialize::handler(ctx)
    }
}

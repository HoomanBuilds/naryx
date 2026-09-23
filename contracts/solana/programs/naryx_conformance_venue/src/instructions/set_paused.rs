use anchor_lang::prelude::*;

use crate::{error::ErrorCode, state::MarketConfig};

#[derive(Accounts)]
pub struct SetPaused<'info> {
    #[account(mut, has_one = admin @ ErrorCode::UnauthorizedAdmin)]
    pub market: Account<'info, MarketConfig>,
    pub admin: Signer<'info>,
}

pub fn handler(ctx: Context<SetPaused>, paused: bool) -> Result<()> {
    ctx.accounts.market.paused = paused;
    Ok(())
}

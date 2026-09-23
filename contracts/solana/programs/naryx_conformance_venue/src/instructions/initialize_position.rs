use anchor_lang::prelude::*;

use crate::{constants::POSITION_SEED, state::PerpPosition};

#[derive(Accounts)]
pub struct InitializePosition<'info> {
    #[account(mut)]
    pub trader: Signer<'info>,
    /// CHECK: The market key is stored and checked by every position mutation.
    pub market: UncheckedAccount<'info>,
    #[account(
        init,
        payer = trader,
        space = 8 + PerpPosition::INIT_SPACE,
        seeds = [POSITION_SEED, market.key().as_ref(), trader.key().as_ref()],
        bump
    )]
    pub position: Account<'info, PerpPosition>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<InitializePosition>) -> Result<()> {
    let position = &mut ctx.accounts.position;
    position.market = ctx.accounts.market.key();
    position.trader = ctx.accounts.trader.key();
    position.short_base_atoms = 0;
    position.collateral_quote_atoms = 0;
    position.bump = ctx.bumps.position;
    Ok(())
}

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::{
    constants::MARKET_SEED,
    error::ErrorCode,
    math::mul_div_floor,
    state::{MarketConfig, PerpPosition},
};

#[derive(Accounts)]
pub struct CloseShortExact<'info> {
    pub trader: Signer<'info>,
    #[account(constraint = !market.paused @ ErrorCode::MarketPaused)]
    pub market: Account<'info, MarketConfig>,
    #[account(
        mut,
        constraint = position.market == market.key() @ ErrorCode::MarketMismatch,
        constraint = position.trader == trader.key() @ ErrorCode::PositionOwnerMismatch
    )]
    pub position: Account<'info, PerpPosition>,
    #[account(
        mut,
        constraint = trader_quote.mint == market.quote_mint @ ErrorCode::MintMismatch,
        constraint = trader_quote.owner == trader.key() @ ErrorCode::PositionOwnerMismatch
    )]
    pub trader_quote: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = perp_quote_vault.key() == market.perp_quote_vault @ ErrorCode::VaultMismatch,
        constraint = perp_quote_vault.mint == market.quote_mint @ ErrorCode::MintMismatch,
        constraint = perp_quote_vault.owner == market.key() @ ErrorCode::VaultMismatch
    )]
    pub perp_quote_vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

pub fn handler(
    ctx: Context<CloseShortExact>,
    base_atoms: u64,
    min_collateral_return_atoms: u64,
) -> Result<()> {
    require!(base_atoms != 0, ErrorCode::TradeAmountZero);
    let market = &ctx.accounts.market;
    let position = &mut ctx.accounts.position;
    require!(
        base_atoms <= position.short_base_atoms,
        ErrorCode::ReduceOnlyViolation
    );
    let collateral_return = if base_atoms == position.short_base_atoms {
        position.collateral_quote_atoms
    } else {
        mul_div_floor(
            position.collateral_quote_atoms,
            base_atoms,
            position.short_base_atoms,
        )?
    };
    require!(
        collateral_return >= min_collateral_return_atoms,
        ErrorCode::SlippageExceeded
    );

    let bump = [market.bump];
    let signer_seeds = [
        MARKET_SEED,
        market.admin.as_ref(),
        market.base_mint.as_ref(),
        market.quote_mint.as_ref(),
        &bump,
    ];
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            Transfer {
                from: ctx.accounts.perp_quote_vault.to_account_info(),
                to: ctx.accounts.trader_quote.to_account_info(),
                authority: market.to_account_info(),
            },
            &[&signer_seeds],
        ),
        collateral_return,
    )?;
    position.short_base_atoms = position
        .short_base_atoms
        .checked_sub(base_atoms)
        .ok_or_else(|| error!(ErrorCode::ArithmeticOverflow))?;
    position.collateral_quote_atoms = position
        .collateral_quote_atoms
        .checked_sub(collateral_return)
        .ok_or_else(|| error!(ErrorCode::ArithmeticOverflow))?;
    Ok(())
}

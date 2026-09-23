use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::{
    constants::BPS_DENOMINATOR,
    error::ErrorCode,
    math::mul_div_ceil,
    state::{MarketConfig, PerpPosition},
};

#[derive(Accounts)]
pub struct OpenShortExact<'info> {
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
    ctx: Context<OpenShortExact>,
    base_atoms: u64,
    max_collateral_quote_atoms: u64,
) -> Result<()> {
    require!(base_atoms != 0, ErrorCode::TradeAmountZero);
    let market = &ctx.accounts.market;
    let position = &mut ctx.accounts.position;
    let next_short = position
        .short_base_atoms
        .checked_add(base_atoms)
        .ok_or_else(|| error!(ErrorCode::ArithmeticOverflow))?;
    require!(
        next_short <= market.max_perp_base_atoms,
        ErrorCode::AmountCapExceeded
    );
    let notional = mul_div_ceil(
        base_atoms,
        market.price_quote_atoms,
        market.price_base_atoms,
    )?;
    let collateral = mul_div_ceil(
        notional,
        u64::from(market.initial_margin_bps),
        BPS_DENOMINATOR,
    )?;
    require!(
        collateral <= max_collateral_quote_atoms,
        ErrorCode::SlippageExceeded
    );
    let next_collateral = position
        .collateral_quote_atoms
        .checked_add(collateral)
        .ok_or_else(|| error!(ErrorCode::ArithmeticOverflow))?;

    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            Transfer {
                from: ctx.accounts.trader_quote.to_account_info(),
                to: ctx.accounts.perp_quote_vault.to_account_info(),
                authority: ctx.accounts.trader.to_account_info(),
            },
        ),
        collateral,
    )?;
    position.short_base_atoms = next_short;
    position.collateral_quote_atoms = next_collateral;
    Ok(())
}

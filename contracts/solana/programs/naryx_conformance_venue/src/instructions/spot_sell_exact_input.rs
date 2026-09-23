use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::{
    constants::{BPS_DENOMINATOR, MARKET_SEED},
    error::ErrorCode,
    math::{mul_div_ceil, mul_div_floor},
    state::MarketConfig,
};

#[derive(Accounts)]
pub struct SpotSellExactInput<'info> {
    pub trader: Signer<'info>,
    #[account(constraint = !market.paused @ ErrorCode::MarketPaused)]
    pub market: Account<'info, MarketConfig>,
    #[account(
        mut,
        constraint = trader_base.mint == market.base_mint @ ErrorCode::MintMismatch,
        constraint = trader_base.owner == trader.key() @ ErrorCode::PositionOwnerMismatch
    )]
    pub trader_base: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = trader_quote.mint == market.quote_mint @ ErrorCode::MintMismatch,
        constraint = trader_quote.owner == trader.key() @ ErrorCode::PositionOwnerMismatch
    )]
    pub trader_quote: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = spot_base_vault.key() == market.spot_base_vault @ ErrorCode::VaultMismatch,
        constraint = spot_base_vault.mint == market.base_mint @ ErrorCode::MintMismatch,
        constraint = spot_base_vault.owner == market.key() @ ErrorCode::VaultMismatch
    )]
    pub spot_base_vault: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = spot_quote_vault.key() == market.spot_quote_vault @ ErrorCode::VaultMismatch,
        constraint = spot_quote_vault.mint == market.quote_mint @ ErrorCode::MintMismatch,
        constraint = spot_quote_vault.owner == market.key() @ ErrorCode::VaultMismatch
    )]
    pub spot_quote_vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

pub fn handler(
    ctx: Context<SpotSellExactInput>,
    base_atoms_in: u64,
    min_quote_atoms_out: u64,
) -> Result<()> {
    let market = &ctx.accounts.market;
    require!(base_atoms_in != 0, ErrorCode::TradeAmountZero);
    require!(
        base_atoms_in <= market.max_spot_base_atoms,
        ErrorCode::AmountCapExceeded
    );
    let gross_quote = mul_div_floor(
        base_atoms_in,
        market.price_quote_atoms,
        market.price_base_atoms,
    )?;
    let fee = mul_div_ceil(gross_quote, u64::from(market.spot_fee_bps), BPS_DENOMINATOR)?;
    let quote_atoms_out = gross_quote
        .checked_sub(fee)
        .ok_or_else(|| error!(ErrorCode::ArithmeticOverflow))?;
    require!(quote_atoms_out != 0, ErrorCode::InsufficientQuoteOutput);
    require!(
        quote_atoms_out >= min_quote_atoms_out,
        ErrorCode::SlippageExceeded
    );

    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            Transfer {
                from: ctx.accounts.trader_base.to_account_info(),
                to: ctx.accounts.spot_base_vault.to_account_info(),
                authority: ctx.accounts.trader.to_account_info(),
            },
        ),
        base_atoms_in,
    )?;

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
                from: ctx.accounts.spot_quote_vault.to_account_info(),
                to: ctx.accounts.trader_quote.to_account_info(),
                authority: market.to_account_info(),
            },
            &[&signer_seeds],
        ),
        quote_atoms_out,
    )
}

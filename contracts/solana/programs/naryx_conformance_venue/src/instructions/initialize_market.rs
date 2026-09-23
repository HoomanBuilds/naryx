use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::{
    constants::{MARKET_SEED, PERP_QUOTE_VAULT_SEED, SPOT_BASE_VAULT_SEED, SPOT_QUOTE_VAULT_SEED},
    math::validate_market_parameters,
    state::MarketConfig,
};

#[derive(Accounts)]
pub struct InitializeMarket<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    pub base_mint: Account<'info, Mint>,
    pub quote_mint: Account<'info, Mint>,
    #[account(
        init,
        payer = admin,
        space = 8 + MarketConfig::INIT_SPACE,
        seeds = [MARKET_SEED, admin.key().as_ref(), base_mint.key().as_ref(), quote_mint.key().as_ref()],
        bump
    )]
    pub market: Account<'info, MarketConfig>,
    #[account(
        init,
        payer = admin,
        seeds = [SPOT_BASE_VAULT_SEED, market.key().as_ref()],
        bump,
        token::mint = base_mint,
        token::authority = market
    )]
    pub spot_base_vault: Account<'info, TokenAccount>,
    #[account(
        init,
        payer = admin,
        seeds = [SPOT_QUOTE_VAULT_SEED, market.key().as_ref()],
        bump,
        token::mint = quote_mint,
        token::authority = market
    )]
    pub spot_quote_vault: Account<'info, TokenAccount>,
    #[account(
        init,
        payer = admin,
        seeds = [PERP_QUOTE_VAULT_SEED, market.key().as_ref()],
        bump,
        token::mint = quote_mint,
        token::authority = market
    )]
    pub perp_quote_vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[allow(clippy::too_many_arguments)]
pub fn handler(
    ctx: Context<InitializeMarket>,
    price_quote_atoms: u64,
    price_base_atoms: u64,
    spot_fee_bps: u16,
    initial_margin_bps: u16,
    max_spot_base_atoms: u64,
    max_perp_base_atoms: u64,
) -> Result<()> {
    validate_market_parameters(
        price_quote_atoms,
        price_base_atoms,
        spot_fee_bps,
        initial_margin_bps,
        max_spot_base_atoms,
        max_perp_base_atoms,
    )?;

    let market = &mut ctx.accounts.market;
    market.admin = ctx.accounts.admin.key();
    market.base_mint = ctx.accounts.base_mint.key();
    market.quote_mint = ctx.accounts.quote_mint.key();
    market.spot_base_vault = ctx.accounts.spot_base_vault.key();
    market.spot_quote_vault = ctx.accounts.spot_quote_vault.key();
    market.perp_quote_vault = ctx.accounts.perp_quote_vault.key();
    market.price_quote_atoms = price_quote_atoms;
    market.price_base_atoms = price_base_atoms;
    market.spot_fee_bps = spot_fee_bps;
    market.initial_margin_bps = initial_margin_bps;
    market.max_spot_base_atoms = max_spot_base_atoms;
    market.max_perp_base_atoms = max_perp_base_atoms;
    market.paused = false;
    market.bump = ctx.bumps.market;
    Ok(())
}

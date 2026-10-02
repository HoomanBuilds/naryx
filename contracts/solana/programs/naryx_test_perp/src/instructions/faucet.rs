use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount};

use crate::{
    constants::{
        TEST_COLLATERAL_DECIMALS, TEST_COLLATERAL_FAUCET_SEED, TEST_COLLATERAL_MAX_BALANCE_ATOMS,
        TEST_COLLATERAL_MAX_CLAIM_ATOMS,
    },
    error::TestPerpError,
};

/// Devnet test collateral faucet. A mint whose mint authority is this program's faucet PDA is
/// free test USDC: any wallet claims into its own token account, a bounded amount per call, while
/// the account stays at or below the faucet balance limit. The mint has no other authority, so
/// supply only grows through these claims.
#[derive(Accounts)]
pub struct ClaimTestCollateral<'info> {
    pub recipient: Signer<'info>,
    #[account(
        mut,
        mint::authority = faucet_authority,
        mint::decimals = TEST_COLLATERAL_DECIMALS
    )]
    pub mint: Box<Account<'info, Mint>>,
    /// CHECK: PDA that only signs mints of faucet-owned test collateral.
    #[account(seeds = [TEST_COLLATERAL_FAUCET_SEED], bump)]
    pub faucet_authority: UncheckedAccount<'info>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = recipient
    )]
    pub recipient_collateral: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

pub fn claim_test_collateral_handler(ctx: Context<ClaimTestCollateral>, amount: u64) -> Result<()> {
    require!(amount > 0, TestPerpError::ZeroAmount);
    require!(
        amount <= TEST_COLLATERAL_MAX_CLAIM_ATOMS
            && ctx
                .accounts
                .recipient_collateral
                .amount
                .checked_add(amount)
                .is_some_and(|balance| balance <= TEST_COLLATERAL_MAX_BALANCE_ATOMS),
        TestPerpError::FaucetLimitExceeded
    );
    require!(
        ctx.accounts.mint.freeze_authority.is_none(),
        TestPerpError::InvalidFaucetMint
    );
    let bump = [ctx.bumps.faucet_authority];
    let seeds: &[&[u8]] = &[TEST_COLLATERAL_FAUCET_SEED, bump.as_ref()];
    token::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            MintTo {
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.recipient_collateral.to_account_info(),
                authority: ctx.accounts.faucet_authority.to_account_info(),
            },
            &[seeds],
        ),
        amount,
    )
}

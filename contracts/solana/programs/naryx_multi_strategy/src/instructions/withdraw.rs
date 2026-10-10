use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};

use crate::{
    constants::MULTI_STRATEGY_ACCOUNT_SEED, error::ErrorCode, events::IdleTokenWithdrawn,
    state::MultiStrategyAccount,
};

#[derive(Accounts)]
pub struct WithdrawIdleToken<'info> {
    pub owner: Signer<'info>,
    #[account(
        seeds = [MULTI_STRATEGY_ACCOUNT_SEED, owner.key().as_ref()],
        bump = strategy_account.bump,
        has_one = owner @ ErrorCode::InvalidOwner
    )]
    pub strategy_account: Box<Account<'info, MultiStrategyAccount>>,
    pub mint: Box<Account<'info, Mint>>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = strategy_account
    )]
    pub source: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = mint)]
    pub destination: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

/// Refused while any package is open, because the strategy account's token balances back every
/// open package and no open package's holdings may leave outside a signed execution.
pub fn withdraw_handler(ctx: Context<WithdrawIdleToken>, amount: u64) -> Result<()> {
    require!(amount != 0, ErrorCode::InvalidWithdrawal);
    require!(
        ctx.accounts.strategy_account.open_package_count == 0,
        ErrorCode::PackageOpen
    );
    let owner = ctx.accounts.owner.key();
    let bump = [ctx.accounts.strategy_account.bump];
    let signer_seeds: &[&[u8]] = &[MULTI_STRATEGY_ACCOUNT_SEED, owner.as_ref(), &bump];
    token::transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.source.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.destination.to_account_info(),
                authority: ctx.accounts.strategy_account.to_account_info(),
            },
            &[signer_seeds],
        ),
        amount,
        ctx.accounts.mint.decimals,
    )?;
    emit!(IdleTokenWithdrawn {
        strategy_account: ctx.accounts.strategy_account.key(),
        mint: ctx.accounts.mint.key(),
        source: ctx.accounts.source.key(),
        destination: ctx.accounts.destination.key(),
        amount,
    });
    Ok(())
}

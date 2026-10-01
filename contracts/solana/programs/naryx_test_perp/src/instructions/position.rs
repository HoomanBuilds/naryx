use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::{
    constants::POSITION_SEED,
    engine::{accrue_funding, apply_settlement, equity, margin_requirement, settle_funding},
    error::TestPerpError,
    instructions::vaults::{apply_vault_settlement, market_transfer},
    oracle::oracle_price_per_lot,
    TestPerpMarket, TestPerpPosition,
};

#[derive(Accounts)]
pub struct InitializePosition<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    pub market: Box<Account<'info, TestPerpMarket>>,
    #[account(
        init,
        payer = owner,
        space = 8 + TestPerpPosition::INIT_SPACE,
        seeds = [POSITION_SEED, market.key().as_ref(), owner.key().as_ref()],
        bump
    )]
    pub position: Box<Account<'info, TestPerpPosition>>,
    pub system_program: Program<'info, System>,
}

pub fn initialize_position_handler(ctx: Context<InitializePosition>) -> Result<()> {
    ctx.accounts.position.set_inner(TestPerpPosition {
        market: ctx.accounts.market.key(),
        owner: ctx.accounts.owner.key(),
        delegate: Pubkey::default(),
        collateral_atoms: 0,
        base_lots: 0,
        entry_notional_atoms: 0,
        entry_funding_index: ctx.accounts.market.cumulative_funding_index,
        bump: ctx.bumps.position,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct SetDelegate<'info> {
    pub owner: Signer<'info>,
    #[account(mut, has_one = owner @ TestPerpError::Unauthorized)]
    pub position: Box<Account<'info, TestPerpPosition>>,
}

pub fn set_delegate_handler(ctx: Context<SetDelegate>, delegate: Pubkey) -> Result<()> {
    ctx.accounts.position.delegate = delegate;
    Ok(())
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    pub owner: Signer<'info>,
    pub market: Box<Account<'info, TestPerpMarket>>,
    #[account(
        mut,
        has_one = owner @ TestPerpError::Unauthorized,
        has_one = market @ TestPerpError::InvalidPositionAccount
    )]
    pub position: Box<Account<'info, TestPerpPosition>>,
    #[account(mut, address = market.collateral_vault)]
    pub collateral_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = market.collateral_mint)]
    pub owner_collateral: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

pub fn deposit_handler(ctx: Context<Deposit>, amount: u64) -> Result<()> {
    require!(amount > 0, TestPerpError::ZeroAmount);
    let position = &mut ctx.accounts.position;
    position.collateral_atoms = position
        .collateral_atoms
        .checked_add(amount)
        .filter(|value| *value <= i64::MAX as u64)
        .ok_or_else(|| error!(TestPerpError::ArithmeticOverflow))?;
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            Transfer {
                from: ctx.accounts.owner_collateral.to_account_info(),
                to: ctx.accounts.collateral_vault.to_account_info(),
                authority: ctx.accounts.owner.to_account_info(),
            },
        ),
        amount,
    )
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    // Only the owner withdraws. A delegate can trade the position but never move collateral out.
    pub owner: Signer<'info>,
    #[account(mut)]
    pub market: Box<Account<'info, TestPerpMarket>>,
    #[account(
        mut,
        has_one = owner @ TestPerpError::Unauthorized,
        has_one = market @ TestPerpError::InvalidPositionAccount
    )]
    pub position: Box<Account<'info, TestPerpPosition>>,
    /// CHECK: Decoded and validated against the market oracle configuration.
    pub oracle: UncheckedAccount<'info>,
    #[account(mut, address = market.collateral_vault)]
    pub collateral_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = market.fee_vault)]
    pub fee_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = market.insurance_vault)]
    pub insurance_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = market.collateral_mint)]
    pub owner_collateral: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

pub fn withdraw_handler(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
    require!(amount > 0, TestPerpError::ZeroAmount);
    let now = Clock::get()?.unix_timestamp;
    let accounts = ctx.accounts;
    let oracle = oracle_price_per_lot(&accounts.market, &accounts.oracle, now)?;
    accrue_funding(&mut accounts.market, oracle, now)?;
    let owed = settle_funding(
        &mut accounts.position,
        accounts.market.cumulative_funding_index,
    )?;
    let settlement = apply_settlement(&mut accounts.market, &mut accounts.position, owed, 0)?;

    require!(
        amount <= accounts.position.collateral_atoms,
        TestPerpError::InsufficientFreeCollateral
    );
    accounts.position.collateral_atoms -= amount;
    if accounts.position.base_lots != 0 {
        require!(
            equity(&accounts.position, oracle)?
                >= margin_requirement(
                    &accounts.position,
                    oracle,
                    accounts.market.initial_margin_bps
                )?,
            TestPerpError::InsufficientFreeCollateral
        );
    }
    apply_vault_settlement(
        &accounts.market,
        &accounts.token_program,
        &accounts.collateral_vault,
        &accounts.fee_vault,
        &accounts.insurance_vault,
        &settlement,
    )?;
    accounts.collateral_vault.reload()?;
    market_transfer(
        &accounts.market,
        &accounts.token_program,
        &accounts.collateral_vault,
        accounts.owner_collateral.to_account_info(),
        amount,
    )
}

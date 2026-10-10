use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::{
    constants::{PACKAGE_INVENTORY_SEED, PACKAGE_INVENTORY_VAULT_SEED},
    error::ErrorCode,
    state::PackageInventory,
};

#[derive(Accounts)]
#[instruction(package_id: [u8; 32])]
pub struct InitializePackageInventory<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: This account contributes identity only. Execution later requires the same key to sign.
    pub strategy_account: UncheckedAccount<'info>,
    pub mint: Account<'info, Mint>,
    #[account(
        init,
        payer = payer,
        space = 8 + PackageInventory::INIT_SPACE,
        seeds = [
            PACKAGE_INVENTORY_SEED,
            strategy_account.key().as_ref(),
            package_id.as_ref(),
            mint.key().as_ref(),
        ],
        bump,
    )]
    pub inventory: Account<'info, PackageInventory>,
    #[account(
        init,
        payer = payer,
        seeds = [PACKAGE_INVENTORY_VAULT_SEED, inventory.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = inventory,
    )]
    pub vault: Account<'info, TokenAccount>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}

pub fn initialize_handler(
    ctx: Context<InitializePackageInventory>,
    package_id: [u8; 32],
) -> Result<()> {
    require!(
        package_id != [0u8; 32] && ctx.accounts.strategy_account.key() != Pubkey::default(),
        ErrorCode::InvalidConfiguration
    );
    ctx.accounts.inventory.set_inner(PackageInventory {
        version: 1,
        bump: ctx.bumps.inventory,
        vault_bump: ctx.bumps.vault,
        strategy_account: ctx.accounts.strategy_account.key(),
        package_id,
        mint: ctx.accounts.mint.key(),
        vault: ctx.accounts.vault.key(),
    });
    Ok(())
}

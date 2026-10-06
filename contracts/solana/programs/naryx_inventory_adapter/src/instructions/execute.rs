use anchor_lang::{prelude::*, solana_program::program::set_return_data};
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};
use solana_sha256_hasher::hashv;

use crate::{
    constants::{
        LOCK, PACKAGE_INVENTORY_SEED, PACKAGE_INVENTORY_VAULT_SEED, RELEASE, TYPED_EVIDENCE_DOMAIN,
    },
    error::ErrorCode,
    state::PackageInventory,
};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq)]
pub struct ExactInventoryLeg {
    pub package_id: [u8; 32],
    pub order_hash: [u8; 32],
    pub quote_hash: [u8; 32],
    pub route_hash: [u8; 32],
    pub action: u8,
    pub input_atoms: u64,
    pub expected_pre_inventory_atoms: u64,
    pub expected_post_inventory_atoms: u64,
}

#[derive(Accounts)]
pub struct ExecutePackageInventory<'info> {
    pub strategy_account: Signer<'info>,
    #[account(
        seeds = [
            PACKAGE_INVENTORY_SEED,
            strategy_account.key().as_ref(),
            inventory.package_id.as_ref(),
            inventory.mint.as_ref(),
        ],
        bump = inventory.bump,
        constraint = inventory.version == 1 @ ErrorCode::InvalidConfiguration,
        constraint = inventory.strategy_account == strategy_account.key() @ ErrorCode::InvalidConfiguration,
        constraint = inventory.mint == mint.key() @ ErrorCode::InvalidConfiguration,
        constraint = inventory.vault == vault.key() @ ErrorCode::InvalidConfiguration,
    )]
    pub inventory: Account<'info, PackageInventory>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = strategy_account,
    )]
    pub strategy_token: Account<'info, TokenAccount>,
    #[account(
        mut,
        seeds = [PACKAGE_INVENTORY_VAULT_SEED, inventory.key().as_ref()],
        bump = inventory.vault_bump,
        token::mint = mint,
        token::authority = inventory,
    )]
    pub vault: Account<'info, TokenAccount>,
    pub mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
}

pub fn execute_handler(ctx: Context<ExecutePackageInventory>, payload: Vec<u8>) -> Result<()> {
    let leg = ExactInventoryLeg::try_from_slice(payload.as_slice())
        .map_err(|_| error!(ErrorCode::InvalidPayload))?;
    validate_leg(&ctx.accounts.inventory, &leg)?;
    let pre_inventory = ctx.accounts.vault.amount;
    let pre_strategy = ctx.accounts.strategy_token.amount;
    require!(
        pre_inventory == leg.expected_pre_inventory_atoms,
        ErrorCode::PreconditionFailed
    );
    if leg.action == LOCK {
        lock(&ctx, leg.input_atoms)?;
    } else {
        release(&ctx, leg.input_atoms)?;
    }
    ctx.accounts.vault.reload()?;
    ctx.accounts.strategy_token.reload()?;
    require!(
        ctx.accounts.vault.amount == leg.expected_post_inventory_atoms,
        ErrorCode::PostconditionFailed
    );
    let expected_strategy = if leg.action == LOCK {
        pre_strategy
            .checked_sub(leg.input_atoms)
            .ok_or_else(|| error!(ErrorCode::ArithmeticOverflow))?
    } else {
        pre_strategy
            .checked_add(leg.input_atoms)
            .ok_or_else(|| error!(ErrorCode::ArithmeticOverflow))?
    };
    require!(
        ctx.accounts.strategy_token.amount == expected_strategy,
        ErrorCode::PostconditionFailed
    );
    let evidence = hashv(&[
        TYPED_EVIDENCE_DOMAIN,
        crate::ID.as_ref(),
        ctx.accounts.strategy_account.key().as_ref(),
        ctx.accounts.inventory.key().as_ref(),
        ctx.accounts.mint.key().as_ref(),
        leg.package_id.as_ref(),
        leg.order_hash.as_ref(),
        leg.quote_hash.as_ref(),
        leg.route_hash.as_ref(),
        &[leg.action],
        &leg.input_atoms.to_le_bytes(),
        &pre_inventory.to_le_bytes(),
        &ctx.accounts.vault.amount.to_le_bytes(),
        &pre_strategy.to_le_bytes(),
        &ctx.accounts.strategy_token.amount.to_le_bytes(),
    ])
    .to_bytes();
    set_return_data(&evidence);
    Ok(())
}

fn validate_leg(inventory: &PackageInventory, leg: &ExactInventoryLeg) -> Result<()> {
    require!(
        leg.package_id == inventory.package_id
            && leg.order_hash != [0u8; 32]
            && leg.quote_hash != [0u8; 32]
            && leg.route_hash != [0u8; 32]
            && (leg.action == LOCK || leg.action == RELEASE)
            && leg.input_atoms != 0,
        ErrorCode::InvalidPayload
    );
    let difference = if leg.action == LOCK {
        leg.expected_post_inventory_atoms
            .checked_sub(leg.expected_pre_inventory_atoms)
    } else {
        leg.expected_pre_inventory_atoms
            .checked_sub(leg.expected_post_inventory_atoms)
    }
    .ok_or_else(|| error!(ErrorCode::InvalidPayload))?;
    require!(difference == leg.input_atoms, ErrorCode::InvalidPayload);
    Ok(())
}

fn lock(ctx: &Context<ExecutePackageInventory>, amount: u64) -> Result<()> {
    token::transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.strategy_token.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.strategy_account.to_account_info(),
            },
        ),
        amount,
        ctx.accounts.mint.decimals,
    )
}

fn release(ctx: &Context<ExecutePackageInventory>, amount: u64) -> Result<()> {
    let strategy_account = ctx.accounts.strategy_account.key();
    let mint = ctx.accounts.mint.key();
    let bump = [ctx.accounts.inventory.bump];
    let signer_seeds: &[&[u8]] = &[
        PACKAGE_INVENTORY_SEED,
        strategy_account.as_ref(),
        ctx.accounts.inventory.package_id.as_ref(),
        mint.as_ref(),
        &bump,
    ];
    token::transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.vault.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.strategy_token.to_account_info(),
                authority: ctx.accounts.inventory.to_account_info(),
            },
            &[signer_seeds],
        ),
        amount,
        ctx.accounts.mint.decimals,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn inventory() -> PackageInventory {
        PackageInventory {
            version: 1,
            bump: 1,
            vault_bump: 2,
            strategy_account: Pubkey::new_unique(),
            package_id: [1u8; 32],
            mint: Pubkey::new_unique(),
            vault: Pubkey::new_unique(),
        }
    }

    fn leg(action: u8, pre: u64, post: u64) -> ExactInventoryLeg {
        ExactInventoryLeg {
            package_id: [1u8; 32],
            order_hash: [2u8; 32],
            quote_hash: [3u8; 32],
            route_hash: [4u8; 32],
            action,
            input_atoms: 25,
            expected_pre_inventory_atoms: pre,
            expected_post_inventory_atoms: post,
        }
    }

    #[test]
    fn validates_exact_lock_and_release_deltas() {
        let inventory = inventory();
        assert!(validate_leg(&inventory, &leg(LOCK, 10, 35)).is_ok());
        assert!(validate_leg(&inventory, &leg(RELEASE, 35, 10)).is_ok());
        assert!(validate_leg(&inventory, &leg(LOCK, 10, 34)).is_err());
        assert!(validate_leg(&inventory, &leg(RELEASE, 10, 35)).is_err());
    }
}

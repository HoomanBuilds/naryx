use anchor_lang::prelude::*;
use naryx_core::{state::ProtocolConfig, PROTOCOL_CONFIG_SEED};

use crate::{
    constants::MULTI_STRATEGY_ACCOUNT_SEED, error::ErrorCode,
    events::MultiStrategyAccountInitialized, state::MultiStrategyAccount,
};

#[derive(Accounts)]
pub struct InitializeMultiStrategyAccount<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        seeds = [PROTOCOL_CONFIG_SEED],
        bump = config.bump,
        seeds::program = naryx_core::ID
    )]
    pub config: Box<Account<'info, ProtocolConfig>>,
    #[account(
        init,
        payer = owner,
        space = 8 + MultiStrategyAccount::INIT_SPACE,
        seeds = [MULTI_STRATEGY_ACCOUNT_SEED, owner.key().as_ref()],
        bump
    )]
    pub strategy_account: Box<Account<'info, MultiStrategyAccount>>,
    pub system_program: Program<'info, System>,
}

pub fn initialize_handler(ctx: Context<InitializeMultiStrategyAccount>) -> Result<()> {
    require!(
        ctx.accounts.config.domain.domain_manifest_version() != 0
            && ctx.accounts.config.domain.domain_manifest_hash() != [0u8; 32],
        ErrorCode::InvalidConfiguration
    );
    ctx.accounts
        .strategy_account
        .set_inner(MultiStrategyAccount {
            version: 1,
            config: ctx.accounts.config.key(),
            owner: ctx.accounts.owner.key(),
            next_nonce: 0,
            bump: ctx.bumps.strategy_account,
        });
    emit!(MultiStrategyAccountInitialized {
        strategy_account: ctx.accounts.strategy_account.key(),
        owner: ctx.accounts.owner.key(),
        config: ctx.accounts.config.key(),
    });
    Ok(())
}

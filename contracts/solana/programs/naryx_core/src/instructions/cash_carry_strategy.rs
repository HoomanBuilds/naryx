use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{Mint, Token, TokenAccount},
};
use naryx_rise_adapter::RiseStrategy;
use solana_sha256_hasher::hashv;

use crate::{
    constants::{
        CASH_CARRY_EXECUTOR_SEED, PROTOCOL_CONFIG_SEED, RESOURCE_INDEX_SEED, RESOURCE_RECORD_SEED,
    },
    error::ErrorCode,
    events::CashCarryStrategyAuthorityInitialized,
    state::{
        CashCarryStrategyAuthority, ExecutionRole, ProtocolConfig, ResourceIndex, ResourceKind,
        ResourceRecord,
    },
    wire::DomainRef,
};

pub(crate) const STRATEGY_AUTHORITY_VERSION: u8 = 1;
const STRATEGY_DOMAIN_IDENTITY_DOMAIN: &[u8] = b"NARYX/cash-carry-strategy-domain/v1";

#[derive(Accounts)]
pub struct InitializeCashCarryStrategy<'info> {
    #[account(mut)]
    pub trader: Signer<'info>,
    #[account(seeds = [PROTOCOL_CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, ProtocolConfig>>,
    pub base_asset_index: Box<Account<'info, ResourceIndex>>,
    pub base_asset_record: Box<Account<'info, ResourceRecord>>,
    pub quote_asset_index: Box<Account<'info, ResourceIndex>>,
    pub quote_asset_record: Box<Account<'info, ResourceRecord>>,
    #[account(address = base_asset_record.manifest.subject_address)]
    pub base_mint: Box<Account<'info, Mint>>,
    #[account(address = quote_asset_record.manifest.subject_address)]
    pub quote_mint: Box<Account<'info, Mint>>,
    #[account(
        constraint = rise_strategy.owner == trader.key() @ ErrorCode::CashCarryStrategyAuthorityInvalid,
        constraint = rise_strategy.controller == executor_authority.key() @ ErrorCode::CashCarryStrategyAuthorityInvalid
    )]
    pub rise_strategy: Box<Account<'info, RiseStrategy>>,
    #[account(
        init,
        payer = trader,
        space = 8 + CashCarryStrategyAuthority::INIT_SPACE,
        seeds = [
            CASH_CARRY_EXECUTOR_SEED,
            trader.key().as_ref(),
            rise_strategy.key().as_ref()
        ],
        bump
    )]
    pub executor_authority: Box<Account<'info, CashCarryStrategyAuthority>>,
    #[account(
        init_if_needed,
        payer = trader,
        associated_token::mint = base_mint,
        associated_token::authority = executor_authority,
        associated_token::token_program = token_program
    )]
    pub strategy_base: Box<Account<'info, TokenAccount>>,
    #[account(
        init_if_needed,
        payer = trader,
        associated_token::mint = quote_mint,
        associated_token::authority = executor_authority,
        associated_token::token_program = token_program
    )]
    pub strategy_quote: Box<Account<'info, TokenAccount>>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub(crate) fn initialize_handler(ctx: Context<InitializeCashCarryStrategy>) -> Result<()> {
    require_keys_neq!(
        ctx.accounts.base_mint.key(),
        ctx.accounts.quote_mint.key(),
        ErrorCode::CashCarryStrategyAuthorityInvalid
    );
    validate_active_asset(
        &ctx.accounts.config,
        &ctx.accounts.base_asset_index,
        &ctx.accounts.base_asset_record,
        &ctx.accounts.base_mint,
    )?;
    validate_active_asset(
        &ctx.accounts.config,
        &ctx.accounts.quote_asset_index,
        &ctx.accounts.quote_asset_record,
        &ctx.accounts.quote_mint,
    )?;

    let domain_identity = strategy_domain_identity(&ctx.accounts.config.domain);
    ctx.accounts
        .executor_authority
        .set_inner(CashCarryStrategyAuthority {
            version: STRATEGY_AUTHORITY_VERSION,
            domain: ctx.accounts.config.domain.clone(),
            domain_identity,
            trader: ctx.accounts.trader.key(),
            base_mint: ctx.accounts.base_mint.key(),
            quote_mint: ctx.accounts.quote_mint.key(),
            rise_strategy: ctx.accounts.rise_strategy.key(),
            base_token_account: ctx.accounts.strategy_base.key(),
            quote_token_account: ctx.accounts.strategy_quote.key(),
            bump: ctx.bumps.executor_authority,
        });
    let strategy = &ctx.accounts.executor_authority;

    emit!(CashCarryStrategyAuthorityInitialized {
        strategy_authority: strategy.key(),
        domain: strategy.domain.clone(),
        trader: strategy.trader,
        base_mint: strategy.base_mint,
        quote_mint: strategy.quote_mint,
        rise_strategy: strategy.rise_strategy,
        base_token_account: strategy.base_token_account,
        quote_token_account: strategy.quote_token_account,
    });
    Ok(())
}

pub fn strategy_domain_identity(domain: &DomainRef) -> [u8; 32] {
    hashv(&[
        STRATEGY_DOMAIN_IDENTITY_DOMAIN,
        domain.canonical_bytes().as_ref(),
    ])
    .to_bytes()
}

pub(crate) fn validate_strategy_authority(
    authority: &CashCarryStrategyAuthority,
    domain: &DomainRef,
    trader: Pubkey,
    base_mint: Pubkey,
    quote_mint: Pubkey,
    rise_strategy: Pubkey,
) -> Result<()> {
    require!(
        authority.version == STRATEGY_AUTHORITY_VERSION
            && authority.domain == *domain
            && authority.domain_identity == strategy_domain_identity(domain)
            && authority.trader == trader
            && authority.base_mint == base_mint
            && authority.quote_mint == quote_mint
            && authority.rise_strategy == rise_strategy,
        ErrorCode::CashCarryStrategyAuthorityInvalid
    );
    Ok(())
}

fn validate_active_asset(
    config: &ProtocolConfig,
    index: &Account<ResourceIndex>,
    record: &Account<ResourceRecord>,
    mint: &Account<Mint>,
) -> Result<()> {
    let identity = &record.manifest.identity;
    let expected_index = Pubkey::find_program_address(
        &[
            RESOURCE_INDEX_SEED,
            ResourceKind::Asset.seed(),
            identity.subject_id.as_ref(),
        ],
        &crate::id(),
    )
    .0;
    let expected_record = Pubkey::find_program_address(
        &[
            RESOURCE_RECORD_SEED,
            ResourceKind::Asset.seed(),
            identity.subject_id.as_ref(),
            identity.manifest_version.to_be_bytes().as_ref(),
        ],
        &crate::id(),
    )
    .0;
    require!(
        index.key() == expected_index
            && record.key() == expected_record
            && index.kind == ResourceKind::Asset
            && index.subject_id == identity.subject_id
            && index.active_record == record.key()
            && index.active_identity.as_ref() == Some(identity)
            && record.active
            && record.manifest.kind == ResourceKind::Asset
            && record.manifest.role == ExecutionRole::None
            && record.manifest.domain == config.domain
            && record.manifest.subject_address == mint.key()
            && record.manifest.program_id == anchor_spl::token::ID
            && record.manifest.decimals == mint.decimals,
        ErrorCode::CashCarryStrategyAuthorityInvalid
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lifecycle_strategy_domain_identity_binds_complete_domain_ref() {
        let domain = DomainRef::new("solana:test", 1, [1; 32]).unwrap();
        let version = DomainRef::new("solana:test", 2, [1; 32]).unwrap();
        let name = DomainRef::new("solana:other", 1, [1; 32]).unwrap();
        let manifest = DomainRef::new("solana:test", 1, [2; 32]).unwrap();
        let identity = strategy_domain_identity(&domain);
        assert_ne!(identity, strategy_domain_identity(&version));
        assert_ne!(identity, strategy_domain_identity(&name));
        assert_ne!(identity, strategy_domain_identity(&manifest));
    }

    #[test]
    fn lifecycle_strategy_authority_binds_domain_assets_and_rise_strategy() {
        let domain = DomainRef::new("solana:test", 1, [1; 32]).unwrap();
        let trader = Pubkey::new_unique();
        let base_mint = Pubkey::new_unique();
        let quote_mint = Pubkey::new_unique();
        let rise_strategy = Pubkey::new_unique();
        let authority = CashCarryStrategyAuthority {
            version: STRATEGY_AUTHORITY_VERSION,
            domain: domain.clone(),
            domain_identity: strategy_domain_identity(&domain),
            trader,
            base_mint,
            quote_mint,
            rise_strategy,
            base_token_account: Pubkey::new_unique(),
            quote_token_account: Pubkey::new_unique(),
            bump: 1,
        };
        assert!(validate_strategy_authority(
            &authority,
            &domain,
            trader,
            base_mint,
            quote_mint,
            rise_strategy,
        )
        .is_ok());
        assert!(validate_strategy_authority(
            &authority,
            &DomainRef::new("solana:test", 2, [2; 32]).unwrap(),
            trader,
            base_mint,
            quote_mint,
            rise_strategy,
        )
        .is_err());
        assert!(validate_strategy_authority(
            &authority,
            &domain,
            trader,
            Pubkey::new_unique(),
            quote_mint,
            rise_strategy,
        )
        .is_err());
        assert!(validate_strategy_authority(
            &authority,
            &domain,
            trader,
            base_mint,
            quote_mint,
            Pubkey::new_unique(),
        )
        .is_err());
    }
}

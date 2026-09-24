use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::get_associated_token_address,
    token::{self, Mint, Token, TokenAccount, Transfer},
};
use naryx_core::{
    constants::PROTOCOL_CONFIG_SEED, program::NaryxCore, state::ProtocolConfig, DomainRef,
    ProtocolId,
};
use solana_sha256_hasher::hashv;

use crate::{
    constants::{
        LIVE_PAIR_SEED, RESERVATION_ACTION_ENTRY, RESERVATION_CAPACITY_SEED,
        RESERVATION_CLASS_SEED, RESERVATION_ID_DOMAIN, RESERVATION_SEED, RESERVATION_VAULT_SEED,
        RESERVATION_VERSION,
    },
    error::ErrorCode,
    events::ReservationFunded,
    instructions::verify_core_identity,
    state::{FirmReservation, LivePair, ReservationCapacity, ReservationClass, ReservationState},
};

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct FundReservationArgs {
    pub domain: DomainRef,
    pub reservation_id: [u8; 32],
    pub solver_id: String,
    pub strategy_authority: Pubkey,
    pub package_nonce: u64,
    pub order_hash: [u8; 32],
    pub route_hash: [u8; 32],
    pub reservation_nonce: [u8; 32],
    pub base_atoms: u64,
    pub quote_atoms: u64,
    pub expiry_slot: u64,
}

#[derive(Accounts)]
#[instruction(args: FundReservationArgs)]
pub struct FundReservation<'info> {
    #[account(mut)]
    pub solver: Signer<'info>,
    pub core_program: Program<'info, NaryxCore>,
    /// CHECK: Pinned code identity is checked against live ProgramData bytes.
    pub core_program_data: UncheckedAccount<'info>,
    #[account(
        seeds = [PROTOCOL_CONFIG_SEED],
        bump = protocol_config.bump,
        seeds::program = core_program.key()
    )]
    pub protocol_config: Box<Account<'info, ProtocolConfig>>,
    #[account(seeds = [RESERVATION_CLASS_SEED], bump = reservation_class.bump)]
    pub reservation_class: Box<Account<'info, ReservationClass>>,
    #[account(
        init_if_needed,
        payer = solver,
        space = 8 + ReservationCapacity::INIT_SPACE,
        seeds = [RESERVATION_CAPACITY_SEED, solver.key().as_ref()],
        bump
    )]
    pub capacity: Box<Account<'info, ReservationCapacity>>,
    #[account(
        init,
        payer = solver,
        space = 8 + FirmReservation::INIT_SPACE,
        seeds = [RESERVATION_SEED, solver.key().as_ref(), args.reservation_id.as_ref()],
        bump
    )]
    pub reservation: Box<Account<'info, FirmReservation>>,
    #[account(
        init,
        payer = solver,
        space = 8 + LivePair::INIT_SPACE,
        seeds = [LIVE_PAIR_SEED, solver.key().as_ref(), args.strategy_authority.as_ref()],
        bump
    )]
    pub live_pair: Box<Account<'info, LivePair>>,
    #[account(
        init,
        payer = solver,
        token::mint = base_mint,
        token::authority = reservation,
        seeds = [RESERVATION_VAULT_SEED, solver.key().as_ref(), args.reservation_id.as_ref()],
        bump
    )]
    pub vault: Box<Account<'info, TokenAccount>>,
    #[account(address = reservation_class.base_mint)]
    pub base_mint: Box<Account<'info, Mint>>,
    #[account(address = reservation_class.quote_mint)]
    pub quote_mint: Box<Account<'info, Mint>>,
    #[account(mut)]
    pub solver_base: Box<Account<'info, TokenAccount>>,
    pub solver_quote: Box<Account<'info, TokenAccount>>,
    pub strategy_base: Box<Account<'info, TokenAccount>>,
    pub strategy_quote: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn reservation_id(
    domain: &DomainRef,
    solver_id: &ProtocolId,
    order_hash: &[u8; 32],
    reservation_nonce: &[u8; 32],
) -> [u8; 32] {
    let domain_bytes = domain.canonical_bytes();
    let solver_bytes = solver_id.canonical_bytes();
    hashv(&[
        RESERVATION_ID_DOMAIN,
        domain_bytes.as_ref(),
        solver_bytes.as_ref(),
        order_hash,
        reservation_nonce,
    ])
    .to_bytes()
}

pub fn fund_reservation_handler(
    ctx: Context<FundReservation>,
    args: FundReservationArgs,
) -> Result<()> {
    let class = &ctx.accounts.reservation_class;
    require!(class.is_v1_entry(), ErrorCode::ClassParameterInvalid);
    verify_core_identity(
        class,
        &ctx.accounts.core_program.to_account_info(),
        &ctx.accounts.core_program_data,
    )?;
    require!(
        ctx.accounts.protocol_config.domain == args.domain,
        ErrorCode::DomainInactive
    );
    require!(
        !ctx.accounts.protocol_config.entry_paused,
        ErrorCode::EntryPaused
    );
    require!(args.order_hash != [0u8; 32], ErrorCode::CommitmentZero);
    require!(args.route_hash != [0u8; 32], ErrorCode::CommitmentZero);
    require!(
        args.reservation_nonce != [0u8; 32],
        ErrorCode::ReservationNonceZero
    );
    require!(args.package_nonce != 0, ErrorCode::PackageNonceZero);
    require_keys_neq!(
        args.strategy_authority,
        Pubkey::default(),
        ErrorCode::AccountBindingMismatch
    );
    require!(
        args.base_atoms != 0 && args.base_atoms <= class.max_base_atoms && args.quote_atoms != 0,
        ErrorCode::AmountInvalid
    );

    let current_slot = Clock::get()?.slot;
    let ttl = args
        .expiry_slot
        .checked_sub(current_slot)
        .ok_or_else(|| error!(ErrorCode::ExpiryInvalid))?;
    require!(
        ttl != 0 && ttl <= class.max_ttl_slots,
        ErrorCode::ExpiryInvalid
    );

    let solver_id = ProtocolId::new(&args.solver_id)?;
    require!(
        reservation_id(
            &args.domain,
            &solver_id,
            &args.order_hash,
            &args.reservation_nonce
        ) == args.reservation_id,
        ErrorCode::ReservationIdMismatch
    );

    require_keys_eq!(
        ctx.accounts.solver_base.key(),
        get_associated_token_address(&ctx.accounts.solver.key(), &class.base_mint),
        ErrorCode::AccountBindingMismatch
    );
    require_keys_eq!(
        ctx.accounts.solver_quote.key(),
        get_associated_token_address(&ctx.accounts.solver.key(), &class.quote_mint),
        ErrorCode::AccountBindingMismatch
    );
    require_keys_eq!(
        ctx.accounts.strategy_base.key(),
        get_associated_token_address(&args.strategy_authority, &class.base_mint),
        ErrorCode::AccountBindingMismatch
    );
    require_keys_eq!(
        ctx.accounts.strategy_quote.key(),
        get_associated_token_address(&args.strategy_authority, &class.quote_mint),
        ErrorCode::AccountBindingMismatch
    );
    require_keys_eq!(
        ctx.accounts.solver_base.owner,
        ctx.accounts.solver.key(),
        ErrorCode::AccountBindingMismatch
    );
    require_keys_eq!(
        ctx.accounts.solver_quote.owner,
        ctx.accounts.solver.key(),
        ErrorCode::AccountBindingMismatch
    );
    require_keys_eq!(
        ctx.accounts.strategy_base.owner,
        args.strategy_authority,
        ErrorCode::AccountBindingMismatch
    );
    require_keys_eq!(
        ctx.accounts.strategy_quote.owner,
        args.strategy_authority,
        ErrorCode::AccountBindingMismatch
    );

    if ctx.accounts.capacity.solver == Pubkey::default() {
        ctx.accounts.capacity.solver = ctx.accounts.solver.key();
        ctx.accounts.capacity.bump = ctx.bumps.capacity;
    }
    require_keys_eq!(
        ctx.accounts.capacity.solver,
        ctx.accounts.solver.key(),
        ErrorCode::AccountBindingMismatch
    );
    ctx.accounts
        .capacity
        .reserve(args.base_atoms, class.max_solver_reserved_base_atoms)?;

    ctx.accounts.reservation.set_inner(FirmReservation {
        version: RESERVATION_VERSION,
        domain: args.domain,
        reservation_id: args.reservation_id,
        solver_id,
        solver: ctx.accounts.solver.key(),
        strategy_authority: args.strategy_authority,
        package_nonce: args.package_nonce,
        order_hash: args.order_hash,
        quote_hash: [0u8; 32],
        route_hash: args.route_hash,
        reservation_nonce: args.reservation_nonce,
        base_mint: class.base_mint,
        quote_mint: class.quote_mint,
        solver_reclaim_base: ctx.accounts.solver_base.key(),
        solver_quote: ctx.accounts.solver_quote.key(),
        strategy_base: ctx.accounts.strategy_base.key(),
        strategy_quote: ctx.accounts.strategy_quote.key(),
        base_atoms: args.base_atoms,
        quote_atoms: args.quote_atoms,
        expiry_slot: args.expiry_slot,
        action: RESERVATION_ACTION_ENTRY,
        state: ReservationState::Funded,
        bump: ctx.bumps.reservation,
        vault_bump: ctx.bumps.vault,
    });
    ctx.accounts.live_pair.set_inner(LivePair {
        solver: ctx.accounts.solver.key(),
        strategy_authority: args.strategy_authority,
        reservation_id: args.reservation_id,
        bump: ctx.bumps.live_pair,
    });
    let source_before = ctx.accounts.solver_base.amount;
    let vault_before = ctx.accounts.vault.amount;
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            Transfer {
                from: ctx.accounts.solver_base.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.solver.to_account_info(),
            },
        ),
        args.base_atoms,
    )?;
    ctx.accounts.solver_base.reload()?;
    ctx.accounts.vault.reload()?;
    require!(
        source_before.checked_sub(ctx.accounts.solver_base.amount) == Some(args.base_atoms)
            && ctx.accounts.vault.amount.checked_sub(vault_before) == Some(args.base_atoms),
        ErrorCode::TokenDeltaMismatch
    );
    emit!(ReservationFunded {
        reservation_id: args.reservation_id,
        order_hash: args.order_hash,
        route_hash: args.route_hash,
        solver: ctx.accounts.solver.key(),
        strategy_authority: args.strategy_authority,
        base_atoms: args.base_atoms,
        quote_atoms: args.quote_atoms,
        expiry_slot: args.expiry_slot,
    });
    Ok(())
}

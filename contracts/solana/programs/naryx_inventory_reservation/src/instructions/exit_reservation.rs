use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::get_associated_token_address,
    token::{self, CloseAccount, Mint, Token, TokenAccount, Transfer},
};
use naryx_core::{
    constants::PROTOCOL_CONFIG_SEED, program::NaryxCore, state::ProtocolConfig, ProtocolId,
};

use crate::{
    constants::{
        LIVE_PAIR_SEED, RESERVATION_ACTION_EXIT, RESERVATION_CAPACITY_SEED,
        RESERVATION_CLASS_SEED, RESERVATION_SEED, RESERVATION_VAULT_SEED, RESERVATION_VERSION,
    },
    error::ErrorCode,
    events::{ReservationConsumed, ReservationFunded, ReservationReleased},
    instructions::{
        consume_reservation::ConsumeReservationArgs, fund_reservation::reservation_id,
        verify_consumer_identity, verify_core_identity, FundReservationArgs,
    },
    state::{
        validate_exit_deltas, FirmReservation, LivePair, ReservationCapacity, ReservationClass,
        ReservationState,
    },
};

// An exit reservation is the entry reservation in reverse: the solver escrows `quote_atoms` of the
// quote mint and buys back exactly `base_atoms` from the strategy at that firm price. It shares the
// class, capacity (counted in base atoms), live-pair, TTL, and code-identity rules of entry. Exits
// are not blocked by the core entry pause.

#[derive(Accounts)]
#[instruction(args: FundReservationArgs)]
pub struct FundExitReservation<'info> {
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
    #[account(
        seeds = [
            RESERVATION_CLASS_SEED,
            reservation_class.domain_identity.as_ref(),
            reservation_class.domain.domain_manifest_version().to_be_bytes().as_ref(),
            reservation_class.domain.domain_manifest_hash().as_ref(),
            reservation_class.base_mint.as_ref(),
            reservation_class.quote_mint.as_ref(),
            reservation_class.consumer_program.as_ref()
        ],
        bump = reservation_class.bump
    )]
    pub reservation_class: Box<Account<'info, ReservationClass>>,
    #[account(
        init_if_needed,
        payer = solver,
        space = 8 + ReservationCapacity::INIT_SPACE,
        seeds = [
            RESERVATION_CAPACITY_SEED,
            reservation_class.key().as_ref(),
            solver.key().as_ref()
        ],
        bump
    )]
    pub capacity: Box<Account<'info, ReservationCapacity>>,
    #[account(
        init,
        payer = solver,
        space = 8 + FirmReservation::INIT_SPACE,
        seeds = [
            RESERVATION_SEED,
            reservation_class.key().as_ref(),
            solver.key().as_ref(),
            args.reservation_id.as_ref()
        ],
        bump
    )]
    pub reservation: Box<Account<'info, FirmReservation>>,
    #[account(
        init,
        payer = solver,
        space = 8 + LivePair::INIT_SPACE,
        seeds = [
            LIVE_PAIR_SEED,
            reservation_class.key().as_ref(),
            solver.key().as_ref(),
            args.strategy_authority.as_ref()
        ],
        bump
    )]
    pub live_pair: Box<Account<'info, LivePair>>,
    #[account(
        init,
        payer = solver,
        token::mint = quote_mint,
        token::authority = reservation,
        seeds = [
            RESERVATION_VAULT_SEED,
            reservation_class.key().as_ref(),
            solver.key().as_ref(),
            args.reservation_id.as_ref()
        ],
        bump
    )]
    pub vault: Box<Account<'info, TokenAccount>>,
    #[account(address = reservation_class.base_mint)]
    pub base_mint: Box<Account<'info, Mint>>,
    #[account(address = reservation_class.quote_mint)]
    pub quote_mint: Box<Account<'info, Mint>>,
    pub solver_base: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub solver_quote: Box<Account<'info, TokenAccount>>,
    pub strategy_base: Box<Account<'info, TokenAccount>>,
    pub strategy_quote: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn fund_exit_reservation_handler(
    ctx: Context<FundExitReservation>,
    args: FundReservationArgs,
) -> Result<()> {
    let class = &ctx.accounts.reservation_class;
    require!(class.is_current_entry(), ErrorCode::ClassParameterInvalid);
    verify_core_identity(
        class,
        &ctx.accounts.core_program.to_account_info(),
        &ctx.accounts.core_program_data,
    )?;
    require!(
        ctx.accounts.protocol_config.domain == class.domain && args.domain == class.domain,
        ErrorCode::DomainInactive
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
    let solver = ctx.accounts.solver.key();
    for (account, owner, mint) in [
        (&ctx.accounts.solver_base, solver, class.base_mint),
        (&ctx.accounts.solver_quote, solver, class.quote_mint),
        (
            &ctx.accounts.strategy_base,
            args.strategy_authority,
            class.base_mint,
        ),
        (
            &ctx.accounts.strategy_quote,
            args.strategy_authority,
            class.quote_mint,
        ),
    ] {
        require_keys_eq!(
            account.key(),
            get_associated_token_address(&owner, &mint),
            ErrorCode::AccountBindingMismatch
        );
        require_keys_eq!(account.owner, owner, ErrorCode::AccountBindingMismatch);
    }

    if ctx.accounts.capacity.solver == Pubkey::default() {
        ctx.accounts.capacity.reservation_class = ctx.accounts.reservation_class.key();
        ctx.accounts.capacity.solver = solver;
        ctx.accounts.capacity.bump = ctx.bumps.capacity;
    }
    require_keys_eq!(
        ctx.accounts.capacity.reservation_class,
        ctx.accounts.reservation_class.key(),
        ErrorCode::AccountBindingMismatch
    );
    require_keys_eq!(
        ctx.accounts.capacity.solver,
        solver,
        ErrorCode::AccountBindingMismatch
    );
    ctx.accounts
        .capacity
        .reserve(args.base_atoms, class.max_solver_reserved_base_atoms)?;

    ctx.accounts.reservation.set_inner(FirmReservation {
        version: RESERVATION_VERSION,
        reservation_class: ctx.accounts.reservation_class.key(),
        domain: args.domain,
        reservation_id: args.reservation_id,
        solver_id,
        solver,
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
        action: RESERVATION_ACTION_EXIT,
        state: ReservationState::Funded,
        bump: ctx.bumps.reservation,
        vault_bump: ctx.bumps.vault,
    });
    ctx.accounts.live_pair.set_inner(LivePair {
        reservation_class: ctx.accounts.reservation_class.key(),
        solver,
        strategy_authority: args.strategy_authority,
        reservation_id: args.reservation_id,
        bump: ctx.bumps.live_pair,
    });
    let source_before = ctx.accounts.solver_quote.amount;
    let vault_before = ctx.accounts.vault.amount;
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            Transfer {
                from: ctx.accounts.solver_quote.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.solver.to_account_info(),
            },
        ),
        args.quote_atoms,
    )?;
    ctx.accounts.solver_quote.reload()?;
    ctx.accounts.vault.reload()?;
    require!(
        source_before.checked_sub(ctx.accounts.solver_quote.amount) == Some(args.quote_atoms)
            && ctx.accounts.vault.amount.checked_sub(vault_before) == Some(args.quote_atoms),
        ErrorCode::TokenDeltaMismatch
    );
    emit!(ReservationFunded {
        reservation_class: ctx.accounts.reservation_class.key(),
        reservation_id: args.reservation_id,
        order_hash: args.order_hash,
        route_hash: args.route_hash,
        solver,
        strategy_authority: args.strategy_authority,
        base_atoms: args.base_atoms,
        quote_atoms: args.quote_atoms,
        expiry_slot: args.expiry_slot,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct ConsumeExitReservation<'info> {
    #[account(mut)]
    pub solver: SystemAccount<'info>,
    pub strategy_authority: Signer<'info>,
    pub core_program: Program<'info, NaryxCore>,
    /// CHECK: Pinned code identity is checked against live ProgramData bytes.
    pub core_program_data: UncheckedAccount<'info>,
    #[account(
        seeds = [PROTOCOL_CONFIG_SEED],
        bump = protocol_config.bump,
        seeds::program = core_program.key()
    )]
    pub protocol_config: Box<Account<'info, ProtocolConfig>>,
    /// CHECK: Exact executable program and code identity are checked.
    pub consumer_program: UncheckedAccount<'info>,
    /// CHECK: Pinned code identity is checked against live ProgramData bytes.
    pub consumer_program_data: UncheckedAccount<'info>,
    #[account(
        seeds = [
            RESERVATION_CLASS_SEED,
            reservation_class.domain_identity.as_ref(),
            reservation_class.domain.domain_manifest_version().to_be_bytes().as_ref(),
            reservation_class.domain.domain_manifest_hash().as_ref(),
            reservation_class.base_mint.as_ref(),
            reservation_class.quote_mint.as_ref(),
            reservation_class.consumer_program.as_ref()
        ],
        bump = reservation_class.bump
    )]
    pub reservation_class: Box<Account<'info, ReservationClass>>,
    #[account(
        mut,
        seeds = [
            RESERVATION_CAPACITY_SEED,
            reservation_class.key().as_ref(),
            solver.key().as_ref()
        ],
        bump = capacity.bump,
        has_one = reservation_class,
        has_one = solver
    )]
    pub capacity: Box<Account<'info, ReservationCapacity>>,
    #[account(
        mut,
        seeds = [
            RESERVATION_SEED,
            reservation_class.key().as_ref(),
            solver.key().as_ref(),
            reservation.reservation_id.as_ref()
        ],
        bump = reservation.bump,
        has_one = reservation_class,
        has_one = solver,
        has_one = strategy_authority
    )]
    pub reservation: Box<Account<'info, FirmReservation>>,
    #[account(
        mut,
        close = solver,
        seeds = [
            LIVE_PAIR_SEED,
            reservation_class.key().as_ref(),
            solver.key().as_ref(),
            strategy_authority.key().as_ref()
        ],
        bump = live_pair.bump,
        has_one = reservation_class,
        has_one = solver,
        has_one = strategy_authority,
        constraint = live_pair.reservation_id == reservation.reservation_id @ ErrorCode::AccountBindingMismatch
    )]
    pub live_pair: Box<Account<'info, LivePair>>,
    #[account(
        mut,
        seeds = [
            RESERVATION_VAULT_SEED,
            reservation_class.key().as_ref(),
            solver.key().as_ref(),
            reservation.reservation_id.as_ref()
        ],
        bump = reservation.vault_bump,
        token::mint = reservation_class.quote_mint,
        token::authority = reservation
    )]
    pub vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = reservation.solver_reclaim_base)]
    pub solver_base: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = reservation.strategy_base)]
    pub strategy_base: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = reservation.strategy_quote)]
    pub strategy_quote: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

pub fn consume_exit_reservation_handler(
    ctx: Context<ConsumeExitReservation>,
    args: ConsumeReservationArgs,
) -> Result<()> {
    let class = &ctx.accounts.reservation_class;
    let reservation_class = class.key();
    let reservation = &mut ctx.accounts.reservation;
    require!(
        class.is_current_entry() && reservation.is_current_exit(),
        ErrorCode::ClassParameterInvalid
    );
    verify_core_identity(
        class,
        &ctx.accounts.core_program.to_account_info(),
        &ctx.accounts.core_program_data,
    )?;
    verify_consumer_identity(
        class,
        &ctx.accounts.consumer_program,
        &ctx.accounts.consumer_program_data,
    )?;
    require!(
        ctx.accounts.protocol_config.domain == class.domain && reservation.domain == class.domain,
        ErrorCode::DomainInactive
    );
    require!(
        reservation.base_mint == class.base_mint
            && reservation.quote_mint == class.quote_mint
            && ctx.accounts.solver_base.mint == class.base_mint
            && ctx.accounts.strategy_base.mint == class.base_mint
            && ctx.accounts.strategy_quote.mint == class.quote_mint,
        ErrorCode::AccountBindingMismatch
    );
    require!(
        ctx.accounts.strategy_authority.to_account_info().owner == &class.consumer_program
            && !ctx.accounts.strategy_authority.key().is_on_curve(),
        ErrorCode::ConsumerAuthorityInvalid
    );
    require!(
        ctx.accounts.vault.amount == reservation.quote_atoms,
        ErrorCode::TokenDeltaMismatch
    );

    let base_atoms = reservation.base_atoms;
    let quote_atoms = reservation.quote_atoms;
    let reservation_id = reservation.reservation_id;
    let reservation_bump = reservation.bump;
    reservation.consume_exit(
        reservation_class,
        args.package_nonce,
        args.order_hash,
        args.quote_hash,
        args.route_hash,
        Clock::get()?.slot,
    )?;
    ctx.accounts.capacity.release(base_atoms)?;

    let strategy_base_before = ctx.accounts.strategy_base.amount;
    let strategy_quote_before = ctx.accounts.strategy_quote.amount;
    let solver_base_before = ctx.accounts.solver_base.amount;
    let vault_before = ctx.accounts.vault.amount;

    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            Transfer {
                from: ctx.accounts.strategy_base.to_account_info(),
                to: ctx.accounts.solver_base.to_account_info(),
                authority: ctx.accounts.strategy_authority.to_account_info(),
            },
        ),
        base_atoms,
    )?;
    let solver_key = ctx.accounts.solver.key();
    let signer_seeds: &[&[u8]] = &[
        RESERVATION_SEED,
        reservation_class.as_ref(),
        solver_key.as_ref(),
        reservation_id.as_ref(),
        &[reservation_bump],
    ];
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.strategy_quote.to_account_info(),
                authority: ctx.accounts.reservation.to_account_info(),
            },
            &[signer_seeds],
        ),
        quote_atoms,
    )?;

    ctx.accounts.strategy_base.reload()?;
    ctx.accounts.strategy_quote.reload()?;
    ctx.accounts.solver_base.reload()?;
    ctx.accounts.vault.reload()?;
    validate_exit_deltas(
        base_atoms,
        quote_atoms,
        strategy_base_before,
        ctx.accounts.strategy_base.amount,
        strategy_quote_before,
        ctx.accounts.strategy_quote.amount,
        solver_base_before,
        ctx.accounts.solver_base.amount,
        vault_before,
        ctx.accounts.vault.amount,
    )?;

    token::close_account(CpiContext::new_with_signer(
        ctx.accounts.token_program.key(),
        CloseAccount {
            account: ctx.accounts.vault.to_account_info(),
            destination: ctx.accounts.solver.to_account_info(),
            authority: ctx.accounts.reservation.to_account_info(),
        },
        &[signer_seeds],
    ))?;
    emit!(ReservationConsumed {
        reservation_class,
        reservation_id,
        quote_hash: args.quote_hash,
        base_atoms,
        quote_atoms,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct ReleaseExitReservation<'info> {
    #[account(mut)]
    pub solver: SystemAccount<'info>,
    /// CHECK: The immutable reservation key is the only accepted strategy binding.
    #[account(address = reservation.strategy_authority)]
    pub strategy_authority: UncheckedAccount<'info>,
    #[account(
        seeds = [
            RESERVATION_CLASS_SEED,
            reservation_class.domain_identity.as_ref(),
            reservation_class.domain.domain_manifest_version().to_be_bytes().as_ref(),
            reservation_class.domain.domain_manifest_hash().as_ref(),
            reservation_class.base_mint.as_ref(),
            reservation_class.quote_mint.as_ref(),
            reservation_class.consumer_program.as_ref()
        ],
        bump = reservation_class.bump
    )]
    pub reservation_class: Box<Account<'info, ReservationClass>>,
    #[account(
        mut,
        seeds = [
            RESERVATION_CAPACITY_SEED,
            reservation_class.key().as_ref(),
            solver.key().as_ref()
        ],
        bump = capacity.bump,
        has_one = reservation_class,
        has_one = solver
    )]
    pub capacity: Box<Account<'info, ReservationCapacity>>,
    #[account(
        mut,
        seeds = [
            RESERVATION_SEED,
            reservation_class.key().as_ref(),
            solver.key().as_ref(),
            reservation.reservation_id.as_ref()
        ],
        bump = reservation.bump,
        has_one = reservation_class,
        has_one = solver
    )]
    pub reservation: Box<Account<'info, FirmReservation>>,
    #[account(
        mut,
        close = solver,
        seeds = [
            LIVE_PAIR_SEED,
            reservation_class.key().as_ref(),
            solver.key().as_ref(),
            strategy_authority.key().as_ref()
        ],
        bump = live_pair.bump,
        has_one = reservation_class,
        has_one = solver,
        has_one = strategy_authority,
        constraint = live_pair.reservation_id == reservation.reservation_id @ ErrorCode::AccountBindingMismatch
    )]
    pub live_pair: Box<Account<'info, LivePair>>,
    #[account(
        mut,
        seeds = [
            RESERVATION_VAULT_SEED,
            reservation_class.key().as_ref(),
            solver.key().as_ref(),
            reservation.reservation_id.as_ref()
        ],
        bump = reservation.vault_bump,
        token::mint = reservation_class.quote_mint,
        token::authority = reservation
    )]
    pub vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = reservation.solver_quote)]
    pub solver_quote: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

/// Permissionless once expired: the escrowed quote returns only to the solver's recorded account.
pub fn release_exit_reservation_handler(ctx: Context<ReleaseExitReservation>) -> Result<()> {
    require!(
        ctx.accounts.reservation_class.is_current_entry()
            && ctx.accounts.reservation.is_current_exit(),
        ErrorCode::ClassParameterInvalid
    );
    let reservation_class = ctx.accounts.reservation_class.key();
    let reservation = &mut ctx.accounts.reservation;
    require!(
        reservation.domain == ctx.accounts.reservation_class.domain
            && reservation.base_mint == ctx.accounts.reservation_class.base_mint
            && reservation.quote_mint == ctx.accounts.reservation_class.quote_mint
            && ctx.accounts.solver_quote.mint == ctx.accounts.reservation_class.quote_mint,
        ErrorCode::AccountBindingMismatch
    );
    require!(
        ctx.accounts.vault.amount == reservation.quote_atoms,
        ErrorCode::TokenDeltaMismatch
    );

    let base_atoms = reservation.base_atoms;
    let quote_atoms = reservation.quote_atoms;
    let reservation_id = reservation.reservation_id;
    let reservation_bump = reservation.bump;
    reservation.release_exit(reservation_class, Clock::get()?.slot)?;
    ctx.accounts.capacity.release(base_atoms)?;

    let reclaim_before = ctx.accounts.solver_quote.amount;
    let vault_before = ctx.accounts.vault.amount;
    let solver_key = ctx.accounts.solver.key();
    let signer_seeds: &[&[u8]] = &[
        RESERVATION_SEED,
        reservation_class.as_ref(),
        solver_key.as_ref(),
        reservation_id.as_ref(),
        &[reservation_bump],
    ];
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.solver_quote.to_account_info(),
                authority: ctx.accounts.reservation.to_account_info(),
            },
            &[signer_seeds],
        ),
        quote_atoms,
    )?;
    ctx.accounts.solver_quote.reload()?;
    ctx.accounts.vault.reload()?;
    require!(
        ctx.accounts
            .solver_quote
            .amount
            .checked_sub(reclaim_before)
            == Some(quote_atoms)
            && vault_before.checked_sub(ctx.accounts.vault.amount) == Some(quote_atoms)
            && ctx.accounts.vault.amount == 0,
        ErrorCode::TokenDeltaMismatch
    );
    token::close_account(CpiContext::new_with_signer(
        ctx.accounts.token_program.key(),
        CloseAccount {
            account: ctx.accounts.vault.to_account_info(),
            destination: ctx.accounts.solver.to_account_info(),
            authority: ctx.accounts.reservation.to_account_info(),
        },
        &[signer_seeds],
    ))?;
    emit!(ReservationReleased {
        reservation_class,
        reservation_id,
        base_atoms,
    });
    Ok(())
}

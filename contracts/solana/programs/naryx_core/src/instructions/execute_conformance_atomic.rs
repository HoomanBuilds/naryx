use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount};
use naryx_conformance_venue::{
    program::NaryxConformanceVenue,
    state::{MarketConfig, PerpPosition},
};

use crate::{
    constants::{
        CONFORMANCE_NONCE_SEED, CONFORMANCE_RECEIPT_SEED, PROTOCOL_CONFIG_SEED,
        SOLVER_REGISTRY_SEED,
    },
    error::ErrorCode,
    events::ConformanceExecutionRecorded,
    instructions::ed25519_signature::{verify_ed25519_signature, Ed25519SignatureError},
    state::{ConformanceExecutionReceipt, ConformanceNonce, ProtocolConfig, SolverRegistry},
    wire::HASH_BYTE_LENGTH,
};
use solana_sha256_hasher::hashv;

const EXECUTION_DIGEST_DOMAIN: &[u8] = b"NARYX/conformance-execution/v1";

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConformanceAction {
    Entry,
    Exit,
}

impl ConformanceAction {
    fn discriminant(self) -> u8 {
        match self {
            Self::Entry => 1,
            Self::Exit => 2,
        }
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct ConformanceExecutionArgs {
    pub action: ConformanceAction,
    pub base_quantity_atoms: u64,
    pub spot_quote_limit_atoms: u64,
    pub collateral_quote_limit_atoms: u64,
    pub expiry_slot: u64,
    pub nonce: u64,
    pub entry_execution_digest: [u8; HASH_BYTE_LENGTH],
    pub expected_pre_short_base_atoms: u64,
    pub expected_pre_collateral_quote_atoms: u64,
}

#[derive(Accounts)]
#[instruction(order_hash: [u8; HASH_BYTE_LENGTH], quote_hash: [u8; HASH_BYTE_LENGTH], route_hash: [u8; HASH_BYTE_LENGTH], args: ConformanceExecutionArgs)]
pub struct ExecuteConformanceAtomic<'info> {
    #[account(mut)]
    pub trader: Signer<'info>,
    #[account(
        seeds = [PROTOCOL_CONFIG_SEED],
        bump = config.bump
    )]
    pub config: Box<Account<'info, ProtocolConfig>>,
    #[account(seeds = [SOLVER_REGISTRY_SEED], bump = solver_registry.bump)]
    pub solver_registry: Account<'info, SolverRegistry>,
    #[account(
        init,
        payer = trader,
        space = 8 + ConformanceExecutionReceipt::INIT_SPACE,
        seeds = [CONFORMANCE_RECEIPT_SEED, trader.key().as_ref(), order_hash.as_ref()],
        bump
    )]
    pub receipt: Box<Account<'info, ConformanceExecutionReceipt>>,
    #[account(
        init,
        payer = trader,
        space = 8 + ConformanceNonce::INIT_SPACE,
        seeds = [CONFORMANCE_NONCE_SEED, trader.key().as_ref(), args.nonce.to_be_bytes().as_ref()],
        bump
    )]
    pub nonce_marker: Account<'info, ConformanceNonce>,
    pub entry_receipt: Option<Box<Account<'info, ConformanceExecutionReceipt>>>,
    pub market: Box<Account<'info, MarketConfig>>,
    #[account(mut)]
    pub position: Box<Account<'info, PerpPosition>>,
    #[account(mut)]
    pub trader_base: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub trader_quote: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub spot_base_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub spot_quote_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub perp_quote_vault: Box<Account<'info, TokenAccount>>,
    pub conformance_program: Program<'info, NaryxConformanceVenue>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    /// CHECK: The address constraint pins this account to the instructions sysvar.
    #[account(address = solana_instructions_sysvar::id())]
    pub instructions_sysvar: UncheckedAccount<'info>,
}

pub fn execution_digest(
    domain: &crate::wire::DomainRef,
    order_hash: [u8; 32],
    quote_hash: [u8; 32],
    route_hash: [u8; 32],
    args: ConformanceExecutionArgs,
    account_keys: &[Pubkey; 19],
) -> [u8; 32] {
    let mut data = Vec::with_capacity(32 * 18 + 128);
    data.extend_from_slice(&domain.canonical_bytes());
    data.extend_from_slice(&order_hash);
    data.extend_from_slice(&quote_hash);
    data.extend_from_slice(&route_hash);
    data.push(args.action.discriminant());
    data.extend_from_slice(&args.base_quantity_atoms.to_be_bytes());
    data.extend_from_slice(&args.spot_quote_limit_atoms.to_be_bytes());
    data.extend_from_slice(&args.collateral_quote_limit_atoms.to_be_bytes());
    data.extend_from_slice(&args.expiry_slot.to_be_bytes());
    data.extend_from_slice(&args.nonce.to_be_bytes());
    data.extend_from_slice(&args.entry_execution_digest);
    data.extend_from_slice(&args.expected_pre_short_base_atoms.to_be_bytes());
    data.extend_from_slice(&args.expected_pre_collateral_quote_atoms.to_be_bytes());
    for key in account_keys {
        data.extend_from_slice(key.as_ref());
    }
    hashv(&[EXECUTION_DIGEST_DOMAIN, &data]).to_bytes()
}

fn require_solver_signature(
    instructions_sysvar: &AccountInfo,
    solver: &Pubkey,
    digest: &[u8; 32],
) -> Result<()> {
    verify_ed25519_signature(instructions_sysvar, solver, digest).map_err(|error| match error {
        Ed25519SignatureError::InvalidInstruction => {
            error!(ErrorCode::ConformanceSignatureInstructionInvalid)
        }
        Ed25519SignatureError::Mismatch => error!(ErrorCode::ConformanceSignatureMismatch),
    })
}

pub(crate) fn handler(
    ctx: Context<ExecuteConformanceAtomic>,
    order_hash: [u8; HASH_BYTE_LENGTH],
    quote_hash: [u8; HASH_BYTE_LENGTH],
    route_hash: [u8; HASH_BYTE_LENGTH],
    args: ConformanceExecutionArgs,
) -> Result<()> {
    for hash in [order_hash, quote_hash, route_hash] {
        require!(
            hash != [0u8; HASH_BYTE_LENGTH],
            ErrorCode::ConformanceHashZero
        );
    }
    require!(
        args.base_quantity_atoms != 0,
        ErrorCode::ConformanceQuantityZero
    );
    require!(args.nonce != 0, ErrorCode::ConformanceNonceZero);
    let execution_slot = Clock::get()?.slot;
    require!(
        execution_slot < args.expiry_slot,
        ErrorCode::ConformanceOrderExpired
    );
    if args.action == ConformanceAction::Entry {
        require!(
            !ctx.accounts.config.entry_paused,
            ErrorCode::ConformanceEntryPaused
        );
        require!(
            ctx.accounts.entry_receipt.is_none()
                && args.entry_execution_digest == [0; HASH_BYTE_LENGTH]
                && args.expected_pre_short_base_atoms == 0
                && args.expected_pre_collateral_quote_atoms == 0,
            ErrorCode::ConformanceEntryReceiptMismatch
        );
    } else {
        let entry = ctx
            .accounts
            .entry_receipt
            .as_ref()
            .ok_or_else(|| error!(ErrorCode::ConformanceEntryReceiptMismatch))?;
        require!(
            entry.domain == ctx.accounts.config.domain
                && entry.trader == ctx.accounts.trader.key()
                && entry.action == ConformanceAction::Entry.discriminant()
                && entry.execution_digest == args.entry_execution_digest
                && entry.post_short_base_atoms == args.expected_pre_short_base_atoms
                && entry.post_collateral_quote_atoms == args.expected_pre_collateral_quote_atoms
                && ctx.accounts.position.short_base_atoms == args.expected_pre_short_base_atoms
                && ctx.accounts.position.collateral_quote_atoms
                    == args.expected_pre_collateral_quote_atoms
                && args.base_quantity_atoms == args.expected_pre_short_base_atoms,
            ErrorCode::ConformanceEntryReceiptMismatch
        );
    }
    let solver = ctx.accounts.solver_registry.active;
    require_keys_neq!(
        solver,
        Pubkey::default(),
        ErrorCode::ConformanceSolverInvalid
    );
    let account_keys = [
        crate::id(),
        ctx.accounts.trader.key(),
        ctx.accounts.config.key(),
        ctx.accounts.solver_registry.key(),
        solver,
        ctx.accounts.receipt.key(),
        ctx.accounts.nonce_marker.key(),
        ctx.accounts
            .entry_receipt
            .as_ref()
            .map(|account| account.key())
            .unwrap_or(crate::id()),
        ctx.accounts.market.key(),
        ctx.accounts.position.key(),
        ctx.accounts.trader_base.key(),
        ctx.accounts.trader_quote.key(),
        ctx.accounts.spot_base_vault.key(),
        ctx.accounts.spot_quote_vault.key(),
        ctx.accounts.perp_quote_vault.key(),
        ctx.accounts.conformance_program.key(),
        ctx.accounts.token_program.key(),
        ctx.accounts.system_program.key(),
        ctx.accounts.instructions_sysvar.key(),
    ];
    let digest = execution_digest(
        &ctx.accounts.config.domain,
        order_hash,
        quote_hash,
        route_hash,
        args,
        &account_keys,
    );
    require_solver_signature(&ctx.accounts.instructions_sysvar, &solver, &digest)?;

    let pre_base_balance = ctx.accounts.trader_base.amount;
    let pre_quote_balance = ctx.accounts.trader_quote.amount;
    let pre_short_base_atoms = ctx.accounts.position.short_base_atoms;
    let pre_collateral_quote_atoms = ctx.accounts.position.collateral_quote_atoms;

    match args.action {
        ConformanceAction::Entry => execute_entry(&ctx, args)?,
        ConformanceAction::Exit => execute_exit(&ctx, args)?,
    }

    ctx.accounts.trader_base.reload()?;
    ctx.accounts.trader_quote.reload()?;
    ctx.accounts.position.reload()?;

    let post_base_balance = ctx.accounts.trader_base.amount;
    let post_quote_balance = ctx.accounts.trader_quote.amount;
    let post_short_base_atoms = ctx.accounts.position.short_base_atoms;
    let post_collateral_quote_atoms = ctx.accounts.position.collateral_quote_atoms;

    enforce_postconditions(
        args,
        pre_base_balance,
        post_base_balance,
        pre_quote_balance,
        post_quote_balance,
        pre_short_base_atoms,
        post_short_base_atoms,
        pre_collateral_quote_atoms,
        post_collateral_quote_atoms,
    )?;

    let receipt = ConformanceExecutionReceipt {
        domain: ctx.accounts.config.domain.clone(),
        order_hash,
        quote_hash,
        route_hash,
        trader: ctx.accounts.trader.key(),
        solver,
        nonce: args.nonce,
        execution_digest: digest,
        action: args.action.discriminant(),
        base_quantity_atoms: args.base_quantity_atoms,
        pre_base_balance,
        post_base_balance,
        pre_quote_balance,
        post_quote_balance,
        pre_short_base_atoms,
        post_short_base_atoms,
        pre_collateral_quote_atoms,
        post_collateral_quote_atoms,
        execution_slot,
        bump: ctx.bumps.receipt,
    };
    ctx.accounts.receipt.set_inner(receipt);
    ctx.accounts.nonce_marker.set_inner(ConformanceNonce {
        order_hash,
        execution_digest: digest,
        bump: ctx.bumps.nonce_marker,
    });

    emit!(ConformanceExecutionRecorded {
        receipt: ctx.accounts.receipt.key(),
        domain: ctx.accounts.config.domain.clone(),
        order_hash,
        quote_hash,
        route_hash,
        trader: ctx.accounts.trader.key(),
        solver,
        nonce: args.nonce,
        execution_digest: digest,
        action: args.action.discriminant(),
        base_quantity_atoms: args.base_quantity_atoms,
        pre_base_balance,
        post_base_balance,
        pre_quote_balance,
        post_quote_balance,
        pre_short_base_atoms,
        post_short_base_atoms,
        pre_collateral_quote_atoms,
        post_collateral_quote_atoms,
        execution_slot,
    });

    Ok(())
}

fn execute_entry(
    ctx: &Context<ExecuteConformanceAtomic>,
    args: ConformanceExecutionArgs,
) -> Result<()> {
    naryx_conformance_venue::cpi::spot_buy_exact_output(
        CpiContext::new(
            ctx.accounts.conformance_program.key(),
            naryx_conformance_venue::cpi::accounts::SpotBuyExactOutput {
                trader: ctx.accounts.trader.to_account_info(),
                market: ctx.accounts.market.to_account_info(),
                trader_base: ctx.accounts.trader_base.to_account_info(),
                trader_quote: ctx.accounts.trader_quote.to_account_info(),
                spot_base_vault: ctx.accounts.spot_base_vault.to_account_info(),
                spot_quote_vault: ctx.accounts.spot_quote_vault.to_account_info(),
                token_program: ctx.accounts.token_program.to_account_info(),
            },
        ),
        args.base_quantity_atoms,
        args.spot_quote_limit_atoms,
    )?;
    naryx_conformance_venue::cpi::open_short_exact(
        CpiContext::new(
            ctx.accounts.conformance_program.key(),
            naryx_conformance_venue::cpi::accounts::OpenShortExact {
                trader: ctx.accounts.trader.to_account_info(),
                market: ctx.accounts.market.to_account_info(),
                position: ctx.accounts.position.to_account_info(),
                trader_quote: ctx.accounts.trader_quote.to_account_info(),
                perp_quote_vault: ctx.accounts.perp_quote_vault.to_account_info(),
                token_program: ctx.accounts.token_program.to_account_info(),
            },
        ),
        args.base_quantity_atoms,
        args.collateral_quote_limit_atoms,
    )
}

fn execute_exit(
    ctx: &Context<ExecuteConformanceAtomic>,
    args: ConformanceExecutionArgs,
) -> Result<()> {
    naryx_conformance_venue::cpi::spot_sell_exact_input(
        CpiContext::new(
            ctx.accounts.conformance_program.key(),
            naryx_conformance_venue::cpi::accounts::SpotSellExactInput {
                trader: ctx.accounts.trader.to_account_info(),
                market: ctx.accounts.market.to_account_info(),
                trader_base: ctx.accounts.trader_base.to_account_info(),
                trader_quote: ctx.accounts.trader_quote.to_account_info(),
                spot_base_vault: ctx.accounts.spot_base_vault.to_account_info(),
                spot_quote_vault: ctx.accounts.spot_quote_vault.to_account_info(),
                token_program: ctx.accounts.token_program.to_account_info(),
            },
        ),
        args.base_quantity_atoms,
        args.spot_quote_limit_atoms,
    )?;
    naryx_conformance_venue::cpi::close_short_exact(
        CpiContext::new(
            ctx.accounts.conformance_program.key(),
            naryx_conformance_venue::cpi::accounts::CloseShortExact {
                trader: ctx.accounts.trader.to_account_info(),
                market: ctx.accounts.market.to_account_info(),
                position: ctx.accounts.position.to_account_info(),
                trader_quote: ctx.accounts.trader_quote.to_account_info(),
                perp_quote_vault: ctx.accounts.perp_quote_vault.to_account_info(),
                token_program: ctx.accounts.token_program.to_account_info(),
            },
        ),
        args.base_quantity_atoms,
        args.collateral_quote_limit_atoms,
    )
}

#[allow(clippy::too_many_arguments)]
fn enforce_postconditions(
    args: ConformanceExecutionArgs,
    pre_base_balance: u64,
    post_base_balance: u64,
    pre_quote_balance: u64,
    post_quote_balance: u64,
    pre_short_base_atoms: u64,
    post_short_base_atoms: u64,
    pre_collateral_quote_atoms: u64,
    post_collateral_quote_atoms: u64,
) -> Result<()> {
    match args.action {
        ConformanceAction::Entry => {
            require!(
                pre_base_balance.checked_add(args.base_quantity_atoms) == Some(post_base_balance),
                ErrorCode::ConformancePostconditionFailed
            );
            require!(
                pre_short_base_atoms.checked_add(args.base_quantity_atoms)
                    == Some(post_short_base_atoms),
                ErrorCode::ConformancePostconditionFailed
            );
            let collateral_added = post_collateral_quote_atoms
                .checked_sub(pre_collateral_quote_atoms)
                .ok_or_else(|| error!(ErrorCode::ConformancePostconditionFailed))?;
            let total_quote_spent = pre_quote_balance
                .checked_sub(post_quote_balance)
                .ok_or_else(|| error!(ErrorCode::ConformancePostconditionFailed))?;
            let spot_quote_spent = total_quote_spent
                .checked_sub(collateral_added)
                .ok_or_else(|| error!(ErrorCode::ConformancePostconditionFailed))?;
            require!(
                collateral_added <= args.collateral_quote_limit_atoms
                    && spot_quote_spent <= args.spot_quote_limit_atoms,
                ErrorCode::ConformancePostconditionFailed
            );
        }
        ConformanceAction::Exit => {
            require!(
                pre_base_balance.checked_sub(args.base_quantity_atoms) == Some(post_base_balance),
                ErrorCode::ConformancePostconditionFailed
            );
            require!(
                pre_short_base_atoms.checked_sub(args.base_quantity_atoms)
                    == Some(post_short_base_atoms),
                ErrorCode::ConformancePostconditionFailed
            );
            let collateral_returned = pre_collateral_quote_atoms
                .checked_sub(post_collateral_quote_atoms)
                .ok_or_else(|| error!(ErrorCode::ConformancePostconditionFailed))?;
            let total_quote_received = post_quote_balance
                .checked_sub(pre_quote_balance)
                .ok_or_else(|| error!(ErrorCode::ConformancePostconditionFailed))?;
            let spot_quote_received = total_quote_received
                .checked_sub(collateral_returned)
                .ok_or_else(|| error!(ErrorCode::ConformancePostconditionFailed))?;
            require!(
                collateral_returned >= args.collateral_quote_limit_atoms
                    && spot_quote_received >= args.spot_quote_limit_atoms,
                ErrorCode::ConformancePostconditionFailed
            );
        }
    }
    Ok(())
}

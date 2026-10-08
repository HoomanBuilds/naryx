use anchor_lang::{
    prelude::*,
    solana_program::{
        bpf_loader_upgradeable::get_program_data_address,
        instruction::{AccountMeta, Instruction},
        program::{get_return_data, invoke_signed},
    },
};
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use naryx_core::{
    instructions::program_identity::program_data_header_identity,
    state::{
        supports_multi_strategy_adapter_class, supports_template, FeePolicyDirection,
        FeePolicyRecord, ProtocolConfig, ResourceIndex, ResourceKind, ResourceRecord,
        SolverRegistry,
    },
    ADAPTER_RESOURCE_SEED, ASSET_RESOURCE_SEED, FEE_POLICY_SEED, PROTOCOL_CONFIG_SEED,
    RESOURCE_INDEX_SEED, RESOURCE_RECORD_SEED, SOLVER_REGISTRY_SEED,
};
use solana_sdk_ids::bpf_loader_upgradeable;
use solana_sha256_hasher::hashv;

use crate::{
    constants::{
        CALLS_HASH_DOMAIN, EVIDENCE_ROOT_DOMAIN, EXECUTION_HASH_DOMAIN, MAX_CPI_ACCOUNTS_PER_CALL,
        MAX_STRATEGY_CALLS, MULTI_STRATEGY_ACCOUNT_SEED, RECEIPT_HASH_DOMAIN,
        STRATEGY_POSITION_SEED, STRATEGY_RECEIPT_SEED, TYPED_ADAPTER_DISCRIMINATOR,
    },
    error::ErrorCode,
    events::{
        MultiStrategyExecuted, NettingAllocationExecuted, StrategyAdapterLegExecuted,
        StrategyFeesCollected,
    },
    state::{
        MultiStrategyAccount, StrategyCallArgs, StrategyExecutionArgs, StrategyPosition,
        StrategyReceipt,
    },
};

#[derive(Accounts)]
#[instruction(execution: StrategyExecutionArgs)]
pub struct ExecuteMultiStrategy<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    pub solver: Signer<'info>,
    #[account(
        seeds = [PROTOCOL_CONFIG_SEED],
        bump = config.bump,
        seeds::program = naryx_core::ID
    )]
    pub config: Box<Account<'info, ProtocolConfig>>,
    #[account(
        seeds = [SOLVER_REGISTRY_SEED],
        bump = solver_registry.bump,
        seeds::program = naryx_core::ID
    )]
    pub solver_registry: Box<Account<'info, SolverRegistry>>,
    #[account(
        seeds = [
            FEE_POLICY_SEED,
            fee_policy.domain_identity_hash.as_ref(),
            fee_policy.direction.seed().as_ref(),
            fee_policy.quote_asset.subject_id.as_ref()
        ],
        bump = fee_policy.bump,
        seeds::program = naryx_core::ID
    )]
    pub fee_policy: Box<Account<'info, FeePolicyRecord>>,
    #[account(
        seeds = [
            RESOURCE_INDEX_SEED,
            ASSET_RESOURCE_SEED,
            execution.fees.quote_asset.subject_id.as_ref()
        ],
        bump = quote_asset_index.bump,
        seeds::program = naryx_core::ID
    )]
    pub quote_asset_index: Box<Account<'info, ResourceIndex>>,
    #[account(
        seeds = [
            RESOURCE_RECORD_SEED,
            ASSET_RESOURCE_SEED,
            execution.fees.quote_asset.subject_id.as_ref(),
            execution.fees.quote_asset.manifest_version.to_be_bytes().as_ref()
        ],
        bump = quote_asset_record.bump,
        seeds::program = naryx_core::ID
    )]
    pub quote_asset_record: Box<Account<'info, ResourceRecord>>,
    pub quote_mint: Box<Account<'info, Mint>>,
    #[account(mut)]
    pub owner_fee_token: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub protocol_fee_token: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub solver_fee_token: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        seeds = [MULTI_STRATEGY_ACCOUNT_SEED, owner.key().as_ref()],
        bump = strategy_account.bump,
        has_one = owner @ ErrorCode::InvalidOwner,
        has_one = config @ ErrorCode::InvalidConfiguration
    )]
    pub strategy_account: Box<Account<'info, MultiStrategyAccount>>,
    #[account(
        init_if_needed,
        payer = owner,
        space = 8 + StrategyPosition::INIT_SPACE,
        seeds = [STRATEGY_POSITION_SEED, strategy_account.key().as_ref(), execution.package_id.as_ref()],
        bump
    )]
    pub position: Box<Account<'info, StrategyPosition>>,
    #[account(
        init,
        payer = owner,
        space = 8 + StrategyReceipt::INIT_SPACE,
        seeds = [STRATEGY_RECEIPT_SEED, strategy_account.key().as_ref(), execution.nonce.to_be_bytes().as_ref()],
        bump
    )]
    pub receipt: Box<Account<'info, StrategyReceipt>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(execution: StrategyExecutionArgs)]
pub struct ExecuteMultiStrategyRecovery<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        seeds = [PROTOCOL_CONFIG_SEED],
        bump = config.bump,
        seeds::program = naryx_core::ID
    )]
    pub config: Box<Account<'info, ProtocolConfig>>,
    #[account(
        mut,
        seeds = [MULTI_STRATEGY_ACCOUNT_SEED, owner.key().as_ref()],
        bump = strategy_account.bump,
        has_one = owner @ ErrorCode::InvalidOwner,
        has_one = config @ ErrorCode::InvalidConfiguration
    )]
    pub strategy_account: Box<Account<'info, MultiStrategyAccount>>,
    #[account(
        mut,
        seeds = [STRATEGY_POSITION_SEED, strategy_account.key().as_ref(), execution.package_id.as_ref()],
        bump = position.bump
    )]
    pub position: Box<Account<'info, StrategyPosition>>,
    #[account(
        init,
        payer = owner,
        space = 8 + StrategyReceipt::INIT_SPACE,
        seeds = [STRATEGY_RECEIPT_SEED, strategy_account.key().as_ref(), execution.nonce.to_be_bytes().as_ref()],
        bump
    )]
    pub receipt: Box<Account<'info, StrategyReceipt>>,
    pub system_program: Program<'info, System>,
}

pub fn execute_handler<'info>(
    ctx: Context<'info, ExecuteMultiStrategy<'info>>,
    execution: StrategyExecutionArgs,
    calls: Vec<StrategyCallArgs>,
) -> Result<()> {
    require_keys_eq!(
        execution.solver,
        ctx.accounts.solver.key(),
        ErrorCode::InvalidSolver
    );
    require!(
        ctx.accounts
            .solver_registry
            .is_active(&ctx.accounts.solver.key()),
        ErrorCode::InvalidSolver
    );
    execute(
        &ctx.accounts.owner,
        &ctx.accounts.config,
        &mut ctx.accounts.strategy_account,
        &mut ctx.accounts.position,
        &mut ctx.accounts.receipt,
        Some(FeeCollectionAccounts {
            policy: &ctx.accounts.fee_policy,
            asset_index: &ctx.accounts.quote_asset_index,
            asset_record: &ctx.accounts.quote_asset_record,
            mint: &ctx.accounts.quote_mint,
            source: &ctx.accounts.owner_fee_token,
            protocol_recipient: &ctx.accounts.protocol_fee_token,
            solver_recipient: &ctx.accounts.solver_fee_token,
            token_program: &ctx.accounts.token_program,
        }),
        &ctx.remaining_accounts,
        &execution,
        &calls,
        [0u8; 32],
        false,
        ctx.bumps.position,
        ctx.bumps.receipt,
    )
}

pub fn netting_allocation_handler<'info>(
    ctx: Context<'info, ExecuteMultiStrategy<'info>>,
    execution: StrategyExecutionArgs,
    calls: Vec<StrategyCallArgs>,
    authorization_hash: [u8; 32],
) -> Result<()> {
    require!(authorization_hash != [0u8; 32], ErrorCode::InvalidExecution);
    require_keys_eq!(
        execution.solver,
        ctx.accounts.solver.key(),
        ErrorCode::InvalidSolver
    );
    require!(
        ctx.accounts
            .solver_registry
            .is_active(&ctx.accounts.solver.key()),
        ErrorCode::InvalidSolver
    );
    execute(
        &ctx.accounts.owner,
        &ctx.accounts.config,
        &mut ctx.accounts.strategy_account,
        &mut ctx.accounts.position,
        &mut ctx.accounts.receipt,
        Some(FeeCollectionAccounts {
            policy: &ctx.accounts.fee_policy,
            asset_index: &ctx.accounts.quote_asset_index,
            asset_record: &ctx.accounts.quote_asset_record,
            mint: &ctx.accounts.quote_mint,
            source: &ctx.accounts.owner_fee_token,
            protocol_recipient: &ctx.accounts.protocol_fee_token,
            solver_recipient: &ctx.accounts.solver_fee_token,
            token_program: &ctx.accounts.token_program,
        }),
        &ctx.remaining_accounts,
        &execution,
        &calls,
        authorization_hash,
        false,
        ctx.bumps.position,
        ctx.bumps.receipt,
    )
}

pub fn recovery_handler<'info>(
    ctx: Context<'info, ExecuteMultiStrategyRecovery<'info>>,
    execution: StrategyExecutionArgs,
    calls: Vec<StrategyCallArgs>,
) -> Result<()> {
    let position_bump = ctx.accounts.position.bump;
    execute(
        &ctx.accounts.owner,
        &ctx.accounts.config,
        &mut ctx.accounts.strategy_account,
        &mut ctx.accounts.position,
        &mut ctx.accounts.receipt,
        None,
        &ctx.remaining_accounts,
        &execution,
        &calls,
        [0u8; 32],
        true,
        position_bump,
        ctx.bumps.receipt,
    )
}

#[allow(clippy::too_many_arguments)]
fn execute<'info>(
    owner: &Signer<'info>,
    config: &Account<'info, ProtocolConfig>,
    strategy_account: &mut Account<'info, MultiStrategyAccount>,
    position: &mut Account<'info, StrategyPosition>,
    receipt: &mut Account<'info, StrategyReceipt>,
    fee_accounts: Option<FeeCollectionAccounts<'_, 'info>>,
    remaining_accounts: &[AccountInfo<'info>],
    execution: &StrategyExecutionArgs,
    calls: &[StrategyCallArgs],
    netting_authorization_hash: [u8; 32],
    recovery: bool,
    position_bump: u8,
    receipt_bump: u8,
) -> Result<()> {
    validate_execution(
        config,
        strategy_account,
        position,
        execution,
        calls,
        recovery,
    )?;
    let execution_hash = serialized_hash(EXECUTION_HASH_DOMAIN, execution)?;
    let calls_hash = serialized_hash(CALLS_HASH_DOMAIN, &calls)?;
    let owner_key = owner.key();
    let strategy_bump = [strategy_account.bump];
    let signer_seeds: &[&[u8]] = &[
        MULTI_STRATEGY_ACCOUNT_SEED,
        owner_key.as_ref(),
        strategy_bump.as_ref(),
    ];
    strategy_account.next_nonce = execution
        .nonce
        .checked_add(1)
        .ok_or_else(|| error!(ErrorCode::ArithmeticOverflow))?;
    let evidence = execute_calls(
        config,
        strategy_account,
        execution,
        calls,
        remaining_accounts,
        signer_seeds,
    )?;
    let collected_fee_identity = collect_fees(owner, execution, fee_accounts)?;
    let evidence_root = evidence_root(&evidence);
    let receipt_hash = hashv(&[
        RECEIPT_HASH_DOMAIN,
        execution_hash.as_ref(),
        calls_hash.as_ref(),
        evidence_root.as_ref(),
    ])
    .to_bytes();
    let proofs = ExecutionProofs {
        calls_hash,
        evidence_root,
        receipt_hash,
        execution_slot: Clock::get()?.slot,
    };
    finalize_state(
        position,
        receipt,
        execution,
        &proofs,
        netting_authorization_hash,
        position_bump,
        receipt_bump,
    );
    emit_execution_events(
        strategy_account.key(),
        position.key(),
        receipt.key(),
        execution,
        calls,
        &evidence,
        &proofs,
        netting_authorization_hash,
        collected_fee_identity,
    )?;
    Ok(())
}

#[derive(Clone, Copy)]
struct ExecutionProofs {
    calls_hash: [u8; 32],
    evidence_root: [u8; 32],
    receipt_hash: [u8; 32],
    execution_slot: u64,
}

struct FeeCollectionAccounts<'a, 'info> {
    policy: &'a Account<'info, FeePolicyRecord>,
    asset_index: &'a Account<'info, ResourceIndex>,
    asset_record: &'a Account<'info, ResourceRecord>,
    mint: &'a Account<'info, Mint>,
    source: &'a Account<'info, TokenAccount>,
    protocol_recipient: &'a Account<'info, TokenAccount>,
    solver_recipient: &'a Account<'info, TokenAccount>,
    token_program: &'a Program<'info, Token>,
}

#[inline(never)]
fn collect_fees<'info>(
    owner: &Signer<'info>,
    execution: &StrategyExecutionArgs,
    accounts: Option<FeeCollectionAccounts<'_, 'info>>,
) -> Result<Option<(Pubkey, Pubkey)>> {
    let Some(accounts) = accounts else {
        require!(execution.fees.is_zero(), ErrorCode::InvalidFeePolicy);
        return Ok(None);
    };
    execution.fees.quote_asset.validate()?;
    require!(
        execution.fees.direction == fee_direction(execution.operation),
        ErrorCode::InvalidFeePolicy
    );
    accounts.policy.validate_identity(
        &execution.domain,
        execution.fees.direction,
        &execution.fees.quote_asset,
    )?;
    accounts.policy.validate_fees(
        execution.fees.policy_version,
        execution.fees.policy_manifest_hash,
        execution.total_gross_notional_atoms,
        execution.fees.protocol_fee_atoms,
        execution.fees.solver_fee_atoms,
    )?;
    require!(
        accounts.asset_index.kind == ResourceKind::Asset
            && accounts.asset_index.subject_id == execution.fees.quote_asset.subject_id
            && accounts.asset_index.active_record == accounts.asset_record.key()
            && accounts.asset_index.active_identity.as_ref() == Some(&execution.fees.quote_asset)
            && accounts.asset_record.active
            && accounts.asset_record.manifest.kind == ResourceKind::Asset
            && accounts.asset_record.manifest.domain == execution.domain
            && accounts.asset_record.manifest.identity == execution.fees.quote_asset
            && accounts.asset_record.manifest.subject_address == accounts.mint.key()
            && accounts.asset_record.manifest.program_id == token::ID
            && match execution.fees.direction {
                FeePolicyDirection::Entry => accounts.asset_record.control.lifecycle.allows_entry(),
                FeePolicyDirection::Exit => accounts.asset_record.control.lifecycle.allows_exit(),
            },
        ErrorCode::InvalidFeePolicy
    );
    require!(
        accounts.source.mint == accounts.mint.key()
            && accounts.source.owner == owner.key()
            && accounts.protocol_recipient.mint == accounts.mint.key()
            && accounts.protocol_recipient.owner == accounts.policy.protocol_fee_recipient
            && accounts.solver_recipient.mint == accounts.mint.key()
            && accounts.solver_recipient.owner == execution.solver,
        ErrorCode::InvalidFeeAccounts
    );
    if execution.fees.protocol_fee_atoms != 0 {
        token::transfer(
            CpiContext::new(
                accounts.token_program.key(),
                Transfer {
                    from: accounts.source.to_account_info(),
                    to: accounts.protocol_recipient.to_account_info(),
                    authority: owner.to_account_info(),
                },
            ),
            execution.fees.protocol_fee_atoms,
        )?;
    }
    if execution.fees.solver_fee_atoms != 0 {
        token::transfer(
            CpiContext::new(
                accounts.token_program.key(),
                Transfer {
                    from: accounts.source.to_account_info(),
                    to: accounts.solver_recipient.to_account_info(),
                    authority: owner.to_account_info(),
                },
            ),
            execution.fees.solver_fee_atoms,
        )?;
    }
    Ok(Some((
        accounts.mint.key(),
        accounts.policy.protocol_fee_recipient,
    )))
}

fn fee_direction(operation: crate::state::StrategyOperation) -> FeePolicyDirection {
    match operation {
        crate::state::StrategyOperation::Enter | crate::state::StrategyOperation::Increase => {
            FeePolicyDirection::Entry
        }
        _ => FeePolicyDirection::Exit,
    }
}

#[inline(never)]
fn finalize_state(
    position: &mut StrategyPosition,
    receipt: &mut StrategyReceipt,
    execution: &StrategyExecutionArgs,
    proofs: &ExecutionProofs,
    netting_authorization_hash: [u8; 32],
    position_bump: u8,
    receipt_bump: u8,
) {
    if execution.operation.is_terminal() {
        position.active = false;
        position.state_hash = [0u8; 32];
    } else {
        if position.package_id == [0u8; 32] {
            position.version = 1;
            position.package_id = execution.package_id;
            position.domain = execution.domain.clone();
            position.template = execution.template.clone();
            position.bump = position_bump;
        }
        position.active = true;
        position.state_hash = execution.next_state_hash;
    }
    position.last_receipt_hash = proofs.receipt_hash;
    receipt.version = 1;
    receipt.package_id = execution.package_id;
    receipt.order_hash = execution.order_hash;
    receipt.graph_hash = execution.graph_hash;
    receipt.quote_hash = execution.quote_hash;
    receipt.route_hash = execution.route_hash;
    receipt.operation = execution.operation;
    receipt.previous_state_hash = execution.previous_state_hash;
    receipt.next_state_hash = execution.next_state_hash;
    receipt.calls_hash = proofs.calls_hash;
    receipt.evidence_root = proofs.evidence_root;
    receipt.receipt_hash = proofs.receipt_hash;
    receipt.netting_authorization_hash = netting_authorization_hash;
    receipt.fees = execution.fees.clone();
    receipt.nonce = execution.nonce;
    receipt.solver = execution.solver;
    receipt.execution_slot = proofs.execution_slot;
    receipt.bump = receipt_bump;
}

#[allow(clippy::too_many_arguments)]
#[inline(never)]
fn emit_execution_events(
    strategy_account: Pubkey,
    position: Pubkey,
    receipt: Pubkey,
    execution: &StrategyExecutionArgs,
    calls: &[StrategyCallArgs],
    evidence: &[[u8; 32]],
    proofs: &ExecutionProofs,
    netting_authorization_hash: [u8; 32],
    collected_fee_identity: Option<(Pubkey, Pubkey)>,
) -> Result<()> {
    emit!(MultiStrategyExecuted {
        strategy_account,
        position,
        receipt,
        domain: execution.domain.clone(),
        package_id: execution.package_id,
        order_hash: execution.order_hash,
        graph_hash: execution.graph_hash,
        quote_hash: execution.quote_hash,
        route_hash: execution.route_hash,
        template: execution.template.clone(),
        operation: execution.operation,
        calls_hash: proofs.calls_hash,
        evidence_root: proofs.evidence_root,
        receipt_hash: proofs.receipt_hash,
        solver: execution.solver,
        nonce: execution.nonce,
        execution_slot: proofs.execution_slot,
    });
    if netting_authorization_hash != [0u8; 32] {
        emit!(NettingAllocationExecuted {
            receipt,
            receipt_hash: proofs.receipt_hash,
            authorization_hash: netting_authorization_hash,
        });
    }
    if execution.fees.protocol_fee_atoms != 0 || execution.fees.solver_fee_atoms != 0 {
        let (mint, protocol_recipient) =
            collected_fee_identity.ok_or_else(|| error!(ErrorCode::InvalidFeePolicy))?;
        emit!(StrategyFeesCollected {
            receipt,
            mint,
            protocol_recipient,
            solver_recipient: execution.solver,
            protocol_fee_atoms: execution.fees.protocol_fee_atoms,
            solver_fee_atoms: execution.fees.solver_fee_atoms,
        });
    }
    for (index, (call, leg_evidence)) in calls.iter().zip(evidence.iter()).enumerate() {
        emit!(StrategyAdapterLegExecuted {
            receipt,
            call_index: u8::try_from(index).map_err(|_| error!(ErrorCode::ArithmeticOverflow))?,
            adapter_subject_id: call.adapter.subject_id,
            stage: call.stage,
            evidence_hash: *leg_evidence,
        });
    }
    Ok(())
}

#[inline(never)]
fn validate_execution(
    config: &ProtocolConfig,
    strategy_account: &MultiStrategyAccount,
    position: &StrategyPosition,
    execution: &StrategyExecutionArgs,
    calls: &[StrategyCallArgs],
    recovery: bool,
) -> Result<()> {
    require!(
        strategy_account.version == 1 && supports_template(&execution.template),
        ErrorCode::InvalidExecution
    );
    execution.settlement.validate()?;
    require!(
        matches!(
            execution.settlement.class,
            naryx_core::state::SettlementClass::AtomicPostcondition
        ),
        ErrorCode::InvalidExecution
    );
    require!(
        execution.package_id != [0u8; 32]
            && execution.order_hash != [0u8; 32]
            && execution.graph_hash != [0u8; 32]
            && execution.quote_hash != [0u8; 32]
            && execution.route_hash != [0u8; 32]
            && execution.total_gross_notional_atoms != 0
            && !calls.is_empty()
            && calls.len() <= MAX_STRATEGY_CALLS,
        ErrorCode::InvalidExecution
    );
    require!(
        Clock::get()?.slot < execution.deadline_slot,
        ErrorCode::ExecutionExpired
    );
    require!(
        strategy_account.next_nonce == execution.nonce,
        ErrorCode::InvalidNonce
    );
    if recovery {
        require!(
            execution.solver == Pubkey::default()
                && execution.operation.requires_only_risk_reduction()
                && execution.fees.is_zero(),
            ErrorCode::InvalidExecution
        );
    } else {
        require!(
            execution.fees.quote_asset.subject_id != [0u8; 32]
                && execution.fees.policy_version != 0
                && execution.fees.policy_manifest_hash != [0u8; 32],
            ErrorCode::InvalidFeePolicy
        );
        require!(
            execution.solver != Pubkey::default(),
            ErrorCode::InvalidSolver
        );
    }
    let has_risk_increase = validate_call_policies(
        execution.operation,
        calls,
        execution.total_gross_notional_atoms,
    )?;
    if has_risk_increase {
        require!(!config.entry_paused, ErrorCode::EntryPaused);
        require!(
            config.domain == execution.domain,
            ErrorCode::InvalidExecution
        );
    }
    if matches!(execution.operation, crate::state::StrategyOperation::Enter) {
        require!(
            position.package_id == [0u8; 32]
                && !position.active
                && execution.previous_state_hash == [0u8; 32]
                && execution.next_state_hash != [0u8; 32],
            ErrorCode::InvalidStateTransition
        );
    } else {
        require!(
            position.active
                && position.package_id == execution.package_id
                && position.domain == execution.domain
                && position.template == execution.template
                && position.state_hash == execution.previous_state_hash,
            ErrorCode::InvalidStateTransition
        );
        require!(
            execution.operation.is_terminal() == (execution.next_state_hash == [0u8; 32]),
            ErrorCode::InvalidStateTransition
        );
    }
    Ok(())
}

fn validate_call_policies(
    operation: crate::state::StrategyOperation,
    calls: &[StrategyCallArgs],
    expected_total_gross_notional_atoms: u64,
) -> Result<bool> {
    let mut total = 0u64;
    let mut previous_stage = 0u8;
    let mut has_risk_increase = false;
    for (index, call) in calls.iter().enumerate() {
        require!(
            call.adapter.subject_id != [0u8; 32]
                && call.adapter.manifest_version != 0
                && call.adapter.manifest_hash != [0u8; 32]
                && call.gross_notional_atoms != 0
                && call.account_count != 0
                && usize::from(call.account_count) <= MAX_CPI_ACCOUNTS_PER_CALL,
            ErrorCode::InvalidExecution
        );
        if index == 0 {
            require!(call.stage == 0, ErrorCode::InvalidStageOrder);
        } else {
            require!(
                call.stage >= previous_stage && call.stage <= previous_stage.saturating_add(1),
                ErrorCode::InvalidStageOrder
            );
        }
        previous_stage = call.stage;
        if operation.requires_only_risk_increase() {
            require!(call.risk_increasing, ErrorCode::InvalidExecution);
        }
        if operation.requires_only_risk_reduction() {
            require!(!call.risk_increasing, ErrorCode::InvalidExecution);
        }
        has_risk_increase |= call.risk_increasing;
        total = total
            .checked_add(call.gross_notional_atoms)
            .ok_or_else(|| error!(ErrorCode::ArithmeticOverflow))?;
    }
    require!(
        total == expected_total_gross_notional_atoms,
        ErrorCode::InvalidExecution
    );
    Ok(has_risk_increase)
}

#[inline(never)]
fn execute_calls<'info>(
    config: &ProtocolConfig,
    strategy_account: &Account<'info, MultiStrategyAccount>,
    execution: &StrategyExecutionArgs,
    calls: &[StrategyCallArgs],
    remaining_accounts: &[AccountInfo<'info>],
    signer_seeds: &[&[u8]],
) -> Result<Vec<[u8; 32]>> {
    let mut cursor = 0usize;
    let mut evidence = Vec::with_capacity(calls.len());
    for call in calls {
        let end = cursor
            .checked_add(4usize)
            .and_then(|value| value.checked_add(usize::from(call.account_count)))
            .ok_or_else(|| error!(ErrorCode::ArithmeticOverflow))?;
        require!(
            end <= remaining_accounts.len(),
            ErrorCode::InvalidCallAccounts
        );
        let resource_index_info = &remaining_accounts[cursor];
        let resource_record_info = &remaining_accounts[cursor + 1];
        let adapter_program = &remaining_accounts[cursor + 2];
        let adapter_program_data = &remaining_accounts[cursor + 3];
        let adapter_accounts = &remaining_accounts[cursor + 4..end];
        validate_adapter(
            config,
            execution,
            call,
            resource_index_info,
            resource_record_info,
            adapter_program,
            adapter_program_data,
        )?;
        let mut account_metas = Vec::with_capacity(adapter_accounts.len());
        let mut account_infos = Vec::with_capacity(adapter_accounts.len() + 1);
        let mut strategy_signer_count = 0usize;
        for account in adapter_accounts {
            let is_strategy_signer = account.key() == strategy_account.key();
            if is_strategy_signer {
                strategy_signer_count += 1;
            }
            require!(
                !account.is_signer || is_strategy_signer,
                ErrorCode::InvalidCallAccounts
            );
            let meta = if account.is_writable {
                AccountMeta::new(account.key(), is_strategy_signer)
            } else {
                AccountMeta::new_readonly(account.key(), is_strategy_signer)
            };
            account_metas.push(meta);
            account_infos.push(account.clone());
        }
        require!(strategy_signer_count == 1, ErrorCode::InvalidCallAccounts);
        let mut data = TYPED_ADAPTER_DISCRIMINATOR.to_vec();
        call.payload
            .serialize(&mut data)
            .map_err(|_| error!(ErrorCode::SerializationFailed))?;
        let instruction = Instruction {
            program_id: adapter_program.key(),
            accounts: account_metas,
            data,
        };
        account_infos.push(adapter_program.clone());
        invoke_signed(&instruction, &account_infos, &[signer_seeds])
            .map_err(|_| error!(ErrorCode::AdapterExecutionFailed))?;
        let (return_program, return_data) =
            get_return_data().ok_or_else(|| error!(ErrorCode::AdapterEvidenceInvalid))?;
        require_keys_eq!(
            return_program,
            adapter_program.key(),
            ErrorCode::AdapterEvidenceInvalid
        );
        require!(
            return_data.len() == 32 && return_data.iter().any(|byte| *byte != 0),
            ErrorCode::AdapterEvidenceInvalid
        );
        let leg_evidence: [u8; 32] = return_data
            .try_into()
            .map_err(|_| error!(ErrorCode::AdapterEvidenceInvalid))?;
        evidence.push(leg_evidence);
        cursor = end;
    }
    require!(
        cursor == remaining_accounts.len(),
        ErrorCode::InvalidCallAccounts
    );
    Ok(evidence)
}

#[allow(clippy::too_many_arguments)]
#[inline(never)]
fn validate_adapter(
    config: &ProtocolConfig,
    execution: &StrategyExecutionArgs,
    call: &StrategyCallArgs,
    index_info: &AccountInfo,
    record_info: &AccountInfo,
    adapter_program: &AccountInfo,
    adapter_program_data: &AccountInfo,
) -> Result<()> {
    require_keys_eq!(
        *index_info.owner,
        naryx_core::ID,
        ErrorCode::InvalidAdapterRecord
    );
    require_keys_eq!(
        *record_info.owner,
        naryx_core::ID,
        ErrorCode::InvalidAdapterRecord
    );
    let index: ResourceIndex = deserialize(index_info)?;
    let record: ResourceRecord = deserialize(record_info)?;
    let (expected_index, _) = Pubkey::find_program_address(
        &[
            RESOURCE_INDEX_SEED,
            ADAPTER_RESOURCE_SEED,
            call.adapter.subject_id.as_ref(),
        ],
        &naryx_core::ID,
    );
    let version = call.adapter.manifest_version.to_be_bytes();
    let (expected_record, _) = Pubkey::find_program_address(
        &[
            RESOURCE_RECORD_SEED,
            ADAPTER_RESOURCE_SEED,
            call.adapter.subject_id.as_ref(),
            version.as_ref(),
        ],
        &naryx_core::ID,
    );
    require_keys_eq!(
        index_info.key(),
        expected_index,
        ErrorCode::InvalidAdapterRecord
    );
    require_keys_eq!(
        record_info.key(),
        expected_record,
        ErrorCode::InvalidAdapterRecord
    );
    require!(
        index.kind == ResourceKind::Adapter
            && index.subject_id == call.adapter.subject_id
            && record.manifest.kind == ResourceKind::Adapter
            && record.manifest.identity == call.adapter
            && record.manifest.domain == execution.domain
            && record.manifest.allowed_template.as_ref() == Some(&execution.template)
            && record.manifest.settlement.as_ref() == Some(&execution.settlement)
            && record
                .manifest
                .adapter_class
                .as_ref()
                .is_some_and(|descriptor| {
                    supports_multi_strategy_adapter_class(record.manifest.role, descriptor)
                }),
        ErrorCode::InvalidAdapterRecord
    );
    if call.risk_increasing {
        require!(
            config.domain == execution.domain
                && record.active
                && index.active_record == record_info.key()
                && index.active_identity.as_ref() == Some(&call.adapter)
                && record.control.lifecycle.allows_entry(),
            ErrorCode::AdapterUnavailable
        );
    } else {
        require!(
            record.control.lifecycle.allows_exit(),
            ErrorCode::AdapterUnavailable
        );
    }
    let limit = record
        .control
        .quote_limit
        .as_ref()
        .ok_or_else(|| error!(ErrorCode::InvalidAdapterRecord))?;
    if call.risk_increasing {
        require!(
            call.gross_notional_atoms <= limit.maximum_notional_atoms,
            ErrorCode::AdapterUnavailable
        );
    }
    require_keys_eq!(
        record.manifest.program_id,
        adapter_program.key(),
        ErrorCode::AdapterCodeIdentityMismatch
    );
    require_keys_eq!(
        record.manifest.program_data,
        adapter_program_data.key(),
        ErrorCode::AdapterCodeIdentityMismatch
    );
    require!(
        adapter_program.executable
            && *adapter_program.owner == bpf_loader_upgradeable::id()
            && *adapter_program_data.owner == bpf_loader_upgradeable::id()
            && get_program_data_address(adapter_program.key) == adapter_program_data.key()
            && program_data_header_identity(adapter_program_data.try_borrow_data()?.as_ref())
                == Some(record.manifest.code_identity),
        ErrorCode::AdapterCodeIdentityMismatch
    );
    Ok(())
}

fn deserialize<T: AccountDeserialize>(info: &AccountInfo) -> Result<T> {
    let data = info.try_borrow_data()?;
    T::try_deserialize(&mut data.as_ref()).map_err(|_| error!(ErrorCode::InvalidAdapterRecord))
}

fn serialized_hash<T: AnchorSerialize>(domain: &[u8], value: &T) -> Result<[u8; 32]> {
    let mut serialized = Vec::new();
    value
        .serialize(&mut serialized)
        .map_err(|_| error!(ErrorCode::SerializationFailed))?;
    Ok(hashv(&[domain, serialized.as_slice()]).to_bytes())
}

fn evidence_root(evidence: &[[u8; 32]]) -> [u8; 32] {
    let mut values = Vec::with_capacity(evidence.len() + 1);
    values.push(EVIDENCE_ROOT_DOMAIN);
    values.extend(evidence.iter().map(|value| value.as_ref()));
    hashv(&values).to_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;
    use naryx_core::state::ManifestRef;

    fn call(stage: u8, risk_increasing: bool, gross_notional_atoms: u64) -> StrategyCallArgs {
        StrategyCallArgs {
            adapter: ManifestRef {
                subject_id: [1u8; 32],
                manifest_version: 1,
                manifest_hash: [2u8; 32],
            },
            stage,
            risk_increasing,
            gross_notional_atoms,
            account_count: 1,
            payload: vec![1],
        }
    }

    #[test]
    fn call_policy_enforces_notional_and_contiguous_stages() {
        let calls = [call(0, true, 40), call(1, true, 60)];
        assert_eq!(
            validate_call_policies(crate::state::StrategyOperation::Enter, &calls, 100).unwrap(),
            true
        );
        assert!(
            validate_call_policies(crate::state::StrategyOperation::Enter, &calls, 99).is_err()
        );
        assert!(validate_call_policies(
            crate::state::StrategyOperation::Enter,
            &[call(0, true, 40), call(2, true, 60)],
            100
        )
        .is_err());
    }

    #[test]
    fn call_policy_enforces_lifecycle_risk_direction() {
        assert!(validate_call_policies(
            crate::state::StrategyOperation::Exit,
            &[call(0, false, 100)],
            100
        )
        .is_ok());
        assert!(validate_call_policies(
            crate::state::StrategyOperation::Exit,
            &[call(0, true, 100)],
            100
        )
        .is_err());
    }
}

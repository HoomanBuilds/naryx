use anchor_lang::prelude::*;

use crate::{
    constants::{
        CASH_CARRY_SERIES_INDEX_SEED, CASH_CARRY_SERIES_RECORD_SEED, PROTOCOL_CONFIG_SEED,
    },
    error::ErrorCode,
    events::{
        CashCarrySeriesBindingActivated, CashCarrySeriesBindingControlActivated,
        CashCarrySeriesBindingControlCancelled, CashCarrySeriesBindingControlProposed,
        CashCarrySeriesBindingRegistrationCancelled, CashCarrySeriesBindingRegistrationProposed,
        CashCarrySeriesBindingTightened,
    },
    state::{
        CashCarrySeriesBindingIndex, CashCarrySeriesBindingRecord, CashCarrySeriesBindingV1,
        ExecutionRole, Lifecycle, PendingSeriesBindingControl, ProtocolConfig, ResourceIndex,
        ResourceKind, ResourceRecord,
    },
    wire::HASH_BYTE_LENGTH,
};

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ProposeCashCarrySeriesBindingArgs {
    pub binding: CashCarrySeriesBindingV1,
    pub expected_identity_key: [u8; HASH_BYTE_LENGTH],
    pub expected_binding_hash: [u8; HASH_BYTE_LENGTH],
    pub lifecycle: Lifecycle,
}

#[derive(Accounts)]
#[instruction(args: ProposeCashCarrySeriesBindingArgs)]
pub struct ProposeInitialCashCarrySeriesBinding<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub proposer: Signer<'info>,
    #[account(
        seeds = [PROTOCOL_CONFIG_SEED],
        bump = config.bump,
        has_one = proposer @ ErrorCode::UnauthorizedRole
    )]
    pub config: Box<Account<'info, ProtocolConfig>>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + CashCarrySeriesBindingIndex::INIT_SPACE,
        seeds = [CASH_CARRY_SERIES_INDEX_SEED, args.expected_identity_key.as_ref()],
        bump
    )]
    pub index: Box<Account<'info, CashCarrySeriesBindingIndex>>,
    #[account(
        init,
        payer = payer,
        space = 8 + CashCarrySeriesBindingRecord::INIT_SPACE,
        seeds = [
            CASH_CARRY_SERIES_RECORD_SEED,
            args.expected_identity_key.as_ref(),
            args.binding.binding_version.to_be_bytes().as_ref()
        ],
        bump
    )]
    pub record: Box<Account<'info, CashCarrySeriesBindingRecord>>,
    pub base_asset_index: Box<Account<'info, ResourceIndex>>,
    pub base_asset: Box<Account<'info, ResourceRecord>>,
    pub quote_asset_index: Box<Account<'info, ResourceIndex>>,
    pub quote_asset: Box<Account<'info, ResourceRecord>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(args: ProposeCashCarrySeriesBindingArgs)]
pub struct ProposeCashCarrySeriesBindingVersion<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub proposer: Signer<'info>,
    #[account(
        seeds = [PROTOCOL_CONFIG_SEED],
        bump = config.bump,
        has_one = proposer @ ErrorCode::UnauthorizedRole
    )]
    pub config: Box<Account<'info, ProtocolConfig>>,
    #[account(
        mut,
        seeds = [CASH_CARRY_SERIES_INDEX_SEED, args.expected_identity_key.as_ref()],
        bump = index.bump
    )]
    pub index: Box<Account<'info, CashCarrySeriesBindingIndex>>,
    pub previous_record: Box<Account<'info, CashCarrySeriesBindingRecord>>,
    #[account(
        init,
        payer = payer,
        space = 8 + CashCarrySeriesBindingRecord::INIT_SPACE,
        seeds = [
            CASH_CARRY_SERIES_RECORD_SEED,
            args.expected_identity_key.as_ref(),
            args.binding.binding_version.to_be_bytes().as_ref()
        ],
        bump
    )]
    pub record: Box<Account<'info, CashCarrySeriesBindingRecord>>,
    pub base_asset_index: Box<Account<'info, ResourceIndex>>,
    pub base_asset: Box<Account<'info, ResourceRecord>>,
    pub quote_asset_index: Box<Account<'info, ResourceIndex>>,
    pub quote_asset: Box<Account<'info, ResourceRecord>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ActivateInitialCashCarrySeriesBinding<'info> {
    pub executor: Signer<'info>,
    #[account(
        seeds = [PROTOCOL_CONFIG_SEED],
        bump = config.bump,
        has_one = executor @ ErrorCode::UnauthorizedRole
    )]
    pub config: Box<Account<'info, ProtocolConfig>>,
    #[account(
        mut,
        seeds = [CASH_CARRY_SERIES_INDEX_SEED, record.identity_key.as_ref()],
        bump = index.bump
    )]
    pub index: Box<Account<'info, CashCarrySeriesBindingIndex>>,
    #[account(
        mut,
        seeds = [
            CASH_CARRY_SERIES_RECORD_SEED,
            record.identity_key.as_ref(),
            record.binding.binding_version.to_be_bytes().as_ref()
        ],
        bump = record.bump
    )]
    pub record: Box<Account<'info, CashCarrySeriesBindingRecord>>,
    pub base_asset_index: Box<Account<'info, ResourceIndex>>,
    pub base_asset: Box<Account<'info, ResourceRecord>>,
    pub quote_asset_index: Box<Account<'info, ResourceIndex>>,
    pub quote_asset: Box<Account<'info, ResourceRecord>>,
}

#[derive(Accounts)]
pub struct ActivateCashCarrySeriesBindingVersion<'info> {
    pub executor: Signer<'info>,
    #[account(
        seeds = [PROTOCOL_CONFIG_SEED],
        bump = config.bump,
        has_one = executor @ ErrorCode::UnauthorizedRole
    )]
    pub config: Box<Account<'info, ProtocolConfig>>,
    #[account(
        mut,
        seeds = [CASH_CARRY_SERIES_INDEX_SEED, record.identity_key.as_ref()],
        bump = index.bump
    )]
    pub index: Box<Account<'info, CashCarrySeriesBindingIndex>>,
    #[account(mut)]
    pub previous_record: Box<Account<'info, CashCarrySeriesBindingRecord>>,
    #[account(
        mut,
        seeds = [
            CASH_CARRY_SERIES_RECORD_SEED,
            record.identity_key.as_ref(),
            record.binding.binding_version.to_be_bytes().as_ref()
        ],
        bump = record.bump
    )]
    pub record: Box<Account<'info, CashCarrySeriesBindingRecord>>,
    pub base_asset_index: Box<Account<'info, ResourceIndex>>,
    pub base_asset: Box<Account<'info, ResourceRecord>>,
    pub quote_asset_index: Box<Account<'info, ResourceIndex>>,
    pub quote_asset: Box<Account<'info, ResourceRecord>>,
}

#[derive(Accounts)]
pub struct CancelCashCarrySeriesBindingRegistration<'info> {
    pub canceller: Signer<'info>,
    #[account(
        seeds = [PROTOCOL_CONFIG_SEED],
        bump = config.bump,
        has_one = canceller @ ErrorCode::UnauthorizedRole
    )]
    pub config: Box<Account<'info, ProtocolConfig>>,
    #[account(
        mut,
        seeds = [CASH_CARRY_SERIES_INDEX_SEED, record.identity_key.as_ref()],
        bump = index.bump
    )]
    pub index: Box<Account<'info, CashCarrySeriesBindingIndex>>,
    #[account(mut)]
    pub record: Box<Account<'info, CashCarrySeriesBindingRecord>>,
}

#[derive(Accounts)]
pub struct ProposeCashCarrySeriesBindingControl<'info> {
    pub proposer: Signer<'info>,
    #[account(
        seeds = [PROTOCOL_CONFIG_SEED],
        bump = config.bump,
        has_one = proposer @ ErrorCode::UnauthorizedRole
    )]
    pub config: Box<Account<'info, ProtocolConfig>>,
    #[account(
        seeds = [CASH_CARRY_SERIES_INDEX_SEED, record.identity_key.as_ref()],
        bump = index.bump
    )]
    pub index: Box<Account<'info, CashCarrySeriesBindingIndex>>,
    #[account(mut)]
    pub record: Box<Account<'info, CashCarrySeriesBindingRecord>>,
}

#[derive(Accounts)]
pub struct CancelCashCarrySeriesBindingControl<'info> {
    pub canceller: Signer<'info>,
    #[account(
        seeds = [PROTOCOL_CONFIG_SEED],
        bump = config.bump,
        has_one = canceller @ ErrorCode::UnauthorizedRole
    )]
    pub config: Box<Account<'info, ProtocolConfig>>,
    #[account(
        seeds = [CASH_CARRY_SERIES_INDEX_SEED, record.identity_key.as_ref()],
        bump = index.bump
    )]
    pub index: Box<Account<'info, CashCarrySeriesBindingIndex>>,
    #[account(mut)]
    pub record: Box<Account<'info, CashCarrySeriesBindingRecord>>,
}

#[derive(Accounts)]
pub struct ActivateCashCarrySeriesBindingControl<'info> {
    pub executor: Signer<'info>,
    #[account(
        seeds = [PROTOCOL_CONFIG_SEED],
        bump = config.bump,
        has_one = executor @ ErrorCode::UnauthorizedRole
    )]
    pub config: Box<Account<'info, ProtocolConfig>>,
    #[account(
        seeds = [CASH_CARRY_SERIES_INDEX_SEED, record.identity_key.as_ref()],
        bump = index.bump
    )]
    pub index: Box<Account<'info, CashCarrySeriesBindingIndex>>,
    #[account(mut)]
    pub record: Box<Account<'info, CashCarrySeriesBindingRecord>>,
    pub base_asset_index: Box<Account<'info, ResourceIndex>>,
    pub base_asset: Box<Account<'info, ResourceRecord>>,
    pub quote_asset_index: Box<Account<'info, ResourceIndex>>,
    pub quote_asset: Box<Account<'info, ResourceRecord>>,
}

#[derive(Accounts)]
pub struct TightenCashCarrySeriesBinding<'info> {
    pub pauser: Signer<'info>,
    #[account(
        seeds = [PROTOCOL_CONFIG_SEED],
        bump = config.bump,
        has_one = pauser @ ErrorCode::UnauthorizedRole
    )]
    pub config: Box<Account<'info, ProtocolConfig>>,
    #[account(
        mut,
        seeds = [CASH_CARRY_SERIES_INDEX_SEED, record.identity_key.as_ref()],
        bump = index.bump
    )]
    pub index: Box<Account<'info, CashCarrySeriesBindingIndex>>,
    #[account(mut)]
    pub record: Box<Account<'info, CashCarrySeriesBindingRecord>>,
}

pub(crate) fn propose_initial(
    ctx: Context<ProposeInitialCashCarrySeriesBinding>,
    args: ProposeCashCarrySeriesBindingArgs,
) -> Result<()> {
    require_keys_eq!(
        ctx.accounts.index.active_record,
        Pubkey::default(),
        ErrorCode::SeriesBindingAlreadyActive
    );
    propose_registration(
        &ctx.accounts.config,
        &mut ctx.accounts.index,
        &mut ctx.accounts.record,
        &ctx.accounts.base_asset_index,
        &ctx.accounts.base_asset,
        &ctx.accounts.quote_asset_index,
        &ctx.accounts.quote_asset,
        args,
        ctx.bumps.index,
        ctx.bumps.record,
        ctx.accounts.proposer.key(),
        None,
    )
}

pub(crate) fn propose_version(
    ctx: Context<ProposeCashCarrySeriesBindingVersion>,
    args: ProposeCashCarrySeriesBindingArgs,
) -> Result<()> {
    let index_bump = ctx.accounts.index.bump;
    require_active_record(
        &ctx.accounts.config,
        &ctx.accounts.index,
        &ctx.accounts.previous_record,
    )?;
    require!(
        ctx.accounts.previous_record.lifecycle != Lifecycle::Deprecated,
        ErrorCode::SeriesBindingDeprecatedTerminal
    );
    require!(
        args.binding
            .preserves_semantics_of(&ctx.accounts.previous_record.binding),
        ErrorCode::SeriesBindingSemanticMutation
    );
    propose_registration(
        &ctx.accounts.config,
        &mut ctx.accounts.index,
        &mut ctx.accounts.record,
        &ctx.accounts.base_asset_index,
        &ctx.accounts.base_asset,
        &ctx.accounts.quote_asset_index,
        &ctx.accounts.quote_asset,
        args,
        index_bump,
        ctx.bumps.record,
        ctx.accounts.proposer.key(),
        Some(&ctx.accounts.previous_record),
    )
}

pub(crate) fn activate_initial(ctx: Context<ActivateInitialCashCarrySeriesBinding>) -> Result<()> {
    require_keys_eq!(
        ctx.accounts.index.active_record,
        Pubkey::default(),
        ErrorCode::SeriesBindingAlreadyActive
    );
    activate_record(
        &ctx.accounts.config,
        &mut ctx.accounts.index,
        &mut ctx.accounts.record,
        &ctx.accounts.base_asset_index,
        &ctx.accounts.base_asset,
        &ctx.accounts.quote_asset_index,
        &ctx.accounts.quote_asset,
    )?;
    emit_activation(
        ctx.accounts.executor.key(),
        &ctx.accounts.record,
        Pubkey::default(),
    );
    Ok(())
}

pub(crate) fn activate_version(ctx: Context<ActivateCashCarrySeriesBindingVersion>) -> Result<()> {
    require_active_record(
        &ctx.accounts.config,
        &ctx.accounts.index,
        &ctx.accounts.previous_record,
    )?;
    require!(
        ctx.accounts
            .record
            .binding
            .preserves_semantics_of(&ctx.accounts.previous_record.binding),
        ErrorCode::SeriesBindingSemanticMutation
    );
    activate_record(
        &ctx.accounts.config,
        &mut ctx.accounts.index,
        &mut ctx.accounts.record,
        &ctx.accounts.base_asset_index,
        &ctx.accounts.base_asset,
        &ctx.accounts.quote_asset_index,
        &ctx.accounts.quote_asset,
    )?;
    ctx.accounts.previous_record.active = false;
    emit_activation(
        ctx.accounts.executor.key(),
        &ctx.accounts.record,
        ctx.accounts.previous_record.key(),
    );
    Ok(())
}

pub(crate) fn cancel_registration(
    ctx: Context<CancelCashCarrySeriesBindingRegistration>,
) -> Result<()> {
    require_pending_registration(&ctx.accounts.index, &ctx.accounts.record)?;
    emit!(CashCarrySeriesBindingRegistrationCancelled {
        actor: ctx.accounts.canceller.key(),
        record: ctx.accounts.record.key(),
        identity_key: ctx.accounts.record.identity_key,
        binding_version: ctx.accounts.record.binding.binding_version,
        binding_hash: ctx.accounts.record.binding_hash,
    });
    clear_pending_registration(&mut ctx.accounts.index);
    ctx.accounts.record.pending_control = None;
    Ok(())
}

pub(crate) fn propose_control(
    ctx: Context<ProposeCashCarrySeriesBindingControl>,
    lifecycle: Lifecycle,
) -> Result<()> {
    require_active_record(
        &ctx.accounts.config,
        &ctx.accounts.index,
        &ctx.accounts.record,
    )?;
    require!(
        ctx.accounts.record.lifecycle != Lifecycle::Deprecated,
        ErrorCode::SeriesBindingDeprecatedTerminal
    );
    require!(
        ctx.accounts.record.pending_control.is_none(),
        ErrorCode::SeriesBindingControlProposalExists
    );
    validate_lifecycle(lifecycle)?;
    let activation_slot = activation_slot(&ctx.accounts.config)?;
    ctx.accounts.record.pending_control = Some(PendingSeriesBindingControl {
        lifecycle,
        activation_slot,
    });
    emit!(CashCarrySeriesBindingControlProposed {
        actor: ctx.accounts.proposer.key(),
        record: ctx.accounts.record.key(),
        lifecycle,
        activation_slot,
    });
    Ok(())
}

pub(crate) fn cancel_control(ctx: Context<CancelCashCarrySeriesBindingControl>) -> Result<()> {
    require_active_record(
        &ctx.accounts.config,
        &ctx.accounts.index,
        &ctx.accounts.record,
    )?;
    require!(
        ctx.accounts.record.pending_control.is_some(),
        ErrorCode::SeriesBindingControlProposalMissing
    );
    ctx.accounts.record.pending_control = None;
    emit!(CashCarrySeriesBindingControlCancelled {
        actor: ctx.accounts.canceller.key(),
        record: ctx.accounts.record.key(),
    });
    Ok(())
}

pub(crate) fn activate_control(ctx: Context<ActivateCashCarrySeriesBindingControl>) -> Result<()> {
    require_active_record(
        &ctx.accounts.config,
        &ctx.accounts.index,
        &ctx.accounts.record,
    )?;
    let pending = ctx
        .accounts
        .record
        .pending_control
        .clone()
        .ok_or_else(|| error!(ErrorCode::SeriesBindingControlProposalMissing))?;
    require_gte!(
        Clock::get()?.slot,
        pending.activation_slot,
        ErrorCode::SeriesBindingControlProposalNotReady
    );
    if pending.lifecycle == Lifecycle::Active {
        require!(
            ctx.accounts.record.domain == ctx.accounts.config.domain,
            ErrorCode::SeriesBindingDomainMismatch
        );
        require_binding_assets(
            &ctx.accounts.config,
            &ctx.accounts.record.binding,
            &ctx.accounts.base_asset_index,
            &ctx.accounts.base_asset,
            &ctx.accounts.quote_asset_index,
            &ctx.accounts.quote_asset,
        )?;
    }
    ctx.accounts.record.lifecycle = pending.lifecycle;
    ctx.accounts.record.pending_control = None;
    emit!(CashCarrySeriesBindingControlActivated {
        actor: ctx.accounts.executor.key(),
        record: ctx.accounts.record.key(),
        lifecycle: ctx.accounts.record.lifecycle,
    });
    Ok(())
}

pub(crate) fn tighten(
    ctx: Context<TightenCashCarrySeriesBinding>,
    lifecycle: Lifecycle,
) -> Result<()> {
    require_active_record(
        &ctx.accounts.config,
        &ctx.accounts.index,
        &ctx.accounts.record,
    )?;
    validate_lifecycle(lifecycle)?;
    require!(
        is_immediate_tightening(lifecycle, ctx.accounts.record.lifecycle),
        ErrorCode::SeriesBindingUnsafeImmediateControl
    );
    let registration_cancelled = ctx.accounts.index.pending_record != Pubkey::default();
    let control_cancelled = ctx.accounts.record.pending_control.is_some();
    ctx.accounts.record.lifecycle = lifecycle;
    ctx.accounts.record.pending_control = None;
    clear_pending_registration(&mut ctx.accounts.index);
    emit!(CashCarrySeriesBindingTightened {
        actor: ctx.accounts.pauser.key(),
        record: ctx.accounts.record.key(),
        lifecycle,
        registration_cancelled,
        control_cancelled,
    });
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn propose_registration(
    config: &Account<ProtocolConfig>,
    index: &mut Account<CashCarrySeriesBindingIndex>,
    record: &mut Account<CashCarrySeriesBindingRecord>,
    base_asset_index: &Account<ResourceIndex>,
    base_asset: &Account<ResourceRecord>,
    quote_asset_index: &Account<ResourceIndex>,
    quote_asset: &Account<ResourceRecord>,
    args: ProposeCashCarrySeriesBindingArgs,
    index_bump: u8,
    record_bump: u8,
    actor: Pubkey,
    previous: Option<&CashCarrySeriesBindingRecord>,
) -> Result<()> {
    args.binding.validate(&config.domain)?;
    validate_lifecycle(args.lifecycle)?;
    require!(
        args.lifecycle != Lifecycle::Deprecated,
        ErrorCode::SeriesBindingDeprecatedTerminal
    );
    let identity_key = args.binding.identity_key();
    let binding_hash = args.binding.binding_hash();
    require!(
        identity_key == args.expected_identity_key,
        ErrorCode::SeriesBindingIdentityMismatch
    );
    require!(
        binding_hash == args.expected_binding_hash,
        ErrorCode::SeriesBindingHashMismatch
    );
    require_binding_assets(
        config,
        &args.binding,
        base_asset_index,
        base_asset,
        quote_asset_index,
        quote_asset,
    )?;
    if let Some(previous) = previous {
        require!(
            args.binding.binding_version > previous.binding.binding_version,
            ErrorCode::SeriesBindingVersionNotIncreasing
        );
    }
    if index.latest_version == 0 {
        index.identity_key = identity_key;
        index.latest_version = 0;
        index.active_record = Pubkey::default();
        index.active_binding_hash = [0u8; HASH_BYTE_LENGTH];
        index.pending_record = Pubkey::default();
        index.pending_binding_hash = [0u8; HASH_BYTE_LENGTH];
        index.activation_slot = None;
        index.bump = index_bump;
    }
    require!(
        index.identity_key == identity_key,
        ErrorCode::SeriesBindingIndexMismatch
    );
    require_keys_eq!(
        index.pending_record,
        Pubkey::default(),
        ErrorCode::SeriesBindingRegistrationExists
    );
    require_gt!(
        args.binding.binding_version,
        index.latest_version,
        ErrorCode::SeriesBindingVersionNotIncreasing
    );
    let ready_slot = activation_slot(config)?;
    index.latest_version = args.binding.binding_version;
    index.pending_record = record.key();
    index.pending_binding_hash = binding_hash;
    index.activation_slot = Some(ready_slot);
    record.set_inner(CashCarrySeriesBindingRecord {
        domain: config.domain.clone(),
        identity_key,
        binding_hash,
        binding: args.binding,
        lifecycle: Lifecycle::AllPaused,
        pending_control: Some(PendingSeriesBindingControl {
            lifecycle: args.lifecycle,
            activation_slot: ready_slot,
        }),
        active: false,
        bump: record_bump,
    });
    emit!(CashCarrySeriesBindingRegistrationProposed {
        actor,
        record: record.key(),
        identity_key,
        binding_version: record.binding.binding_version,
        binding_hash,
        activation_slot: ready_slot,
    });
    Ok(())
}

fn activate_record(
    config: &Account<ProtocolConfig>,
    index: &mut Account<CashCarrySeriesBindingIndex>,
    record: &mut Account<CashCarrySeriesBindingRecord>,
    base_asset_index: &Account<ResourceIndex>,
    base_asset: &Account<ResourceRecord>,
    quote_asset_index: &Account<ResourceIndex>,
    quote_asset: &Account<ResourceRecord>,
) -> Result<()> {
    require_pending_registration(index, record)?;
    require!(
        record.domain == config.domain,
        ErrorCode::SeriesBindingDomainMismatch
    );
    require!(
        record.binding.binding_hash() == record.binding_hash
            && record.binding.identity_key() == record.identity_key,
        ErrorCode::SeriesBindingHashMismatch
    );
    require_binding_assets(
        config,
        &record.binding,
        base_asset_index,
        base_asset,
        quote_asset_index,
        quote_asset,
    )?;
    let ready_slot = index
        .activation_slot
        .ok_or_else(|| error!(ErrorCode::SeriesBindingRegistrationMissing))?;
    require_gte!(
        Clock::get()?.slot,
        ready_slot,
        ErrorCode::SeriesBindingRegistrationNotReady
    );
    let pending = record
        .pending_control
        .clone()
        .ok_or_else(|| error!(ErrorCode::SeriesBindingRegistrationMissing))?;
    require!(
        pending.activation_slot == ready_slot,
        ErrorCode::SeriesBindingIndexMismatch
    );
    record.lifecycle = pending.lifecycle;
    record.pending_control = None;
    record.active = true;
    index.active_record = record.key();
    index.active_binding_hash = record.binding_hash;
    clear_pending_registration(index);
    Ok(())
}

pub fn validate_active_cash_carry_series_binding(
    config: &ProtocolConfig,
    index: &CashCarrySeriesBindingIndex,
    record_key: Pubkey,
    record: &CashCarrySeriesBindingRecord,
    expected_identity_key: [u8; HASH_BYTE_LENGTH],
    expected_binding_hash: [u8; HASH_BYTE_LENGTH],
    base_asset_index: &ResourceIndex,
    base_asset_key: Pubkey,
    base_asset: &ResourceRecord,
    quote_asset_index: &ResourceIndex,
    quote_asset_key: Pubkey,
    quote_asset: &ResourceRecord,
) -> Result<()> {
    require!(
        expected_identity_key == record.identity_key
            && expected_binding_hash == record.binding_hash
            && record.binding.identity_key() == expected_identity_key
            && record.binding.binding_hash() == expected_binding_hash,
        ErrorCode::SeriesBindingHashMismatch
    );
    require!(
        index.identity_key == expected_identity_key
            && index.active_record == record_key
            && index.active_binding_hash == expected_binding_hash
            && record.active,
        ErrorCode::SeriesBindingNotActive
    );
    require!(
        record.lifecycle == Lifecycle::Active,
        ErrorCode::SeriesBindingNotActive
    );
    require!(
        record.domain == config.domain,
        ErrorCode::SeriesBindingDomainMismatch
    );
    require_active_asset(
        config,
        &record.binding.base_asset,
        base_asset_index,
        base_asset_key,
        base_asset,
    )?;
    require_active_asset(
        config,
        &record.binding.quote_asset,
        quote_asset_index,
        quote_asset_key,
        quote_asset,
    )
}

fn require_pending_registration(
    index: &CashCarrySeriesBindingIndex,
    record: &Account<CashCarrySeriesBindingRecord>,
) -> Result<()> {
    require_keys_eq!(
        index.pending_record,
        record.key(),
        ErrorCode::SeriesBindingRegistrationMissing
    );
    require!(
        index.pending_binding_hash == record.binding_hash,
        ErrorCode::SeriesBindingIndexMismatch
    );
    require!(!record.active, ErrorCode::SeriesBindingAlreadyActive);
    Ok(())
}

fn require_active_record(
    config: &ProtocolConfig,
    index: &CashCarrySeriesBindingIndex,
    record: &Account<CashCarrySeriesBindingRecord>,
) -> Result<()> {
    require_keys_eq!(
        index.active_record,
        record.key(),
        ErrorCode::SeriesBindingNotActive
    );
    require!(
        record.active
            && index.identity_key == record.identity_key
            && index.active_binding_hash == record.binding_hash
            && record.binding.identity_key() == record.identity_key
            && record.binding.binding_hash() == record.binding_hash,
        ErrorCode::SeriesBindingNotActive
    );
    require!(
        record.domain.domain_id() == config.domain.domain_id(),
        ErrorCode::SeriesBindingDomainMismatch
    );
    Ok(())
}

fn require_binding_assets(
    config: &ProtocolConfig,
    binding: &CashCarrySeriesBindingV1,
    base_asset_index: &Account<ResourceIndex>,
    base_asset: &Account<ResourceRecord>,
    quote_asset_index: &Account<ResourceIndex>,
    quote_asset: &Account<ResourceRecord>,
) -> Result<()> {
    require_active_asset(
        config,
        &binding.base_asset,
        base_asset_index,
        base_asset.key(),
        base_asset,
    )?;
    require_active_asset(
        config,
        &binding.quote_asset,
        quote_asset_index,
        quote_asset.key(),
        quote_asset,
    )
}

fn require_active_asset(
    config: &ProtocolConfig,
    expected: &crate::state::ManifestRef,
    index: &ResourceIndex,
    record_key: Pubkey,
    record: &ResourceRecord,
) -> Result<()> {
    require!(
        index.kind == ResourceKind::Asset
            && index.subject_id == expected.subject_id
            && index.active_record == record_key
            && index.active_identity.as_ref() == Some(expected)
            && record.active,
        ErrorCode::SeriesBindingAssetMismatch
    );
    require!(
        record.manifest.kind == ResourceKind::Asset
            && record.manifest.role == ExecutionRole::None
            && record.manifest.domain == config.domain
            && record.manifest.identity == *expected
            && record.control.lifecycle.allows_entry(),
        ErrorCode::SeriesBindingAssetMismatch
    );
    Ok(())
}

fn validate_lifecycle(lifecycle: Lifecycle) -> Result<()> {
    require!(
        matches!(
            lifecycle,
            Lifecycle::Active | Lifecycle::EntryPaused | Lifecycle::Deprecated
        ),
        ErrorCode::SeriesBindingLifecycleUnsupported
    );
    Ok(())
}

fn is_immediate_tightening(next: Lifecycle, current: Lifecycle) -> bool {
    matches!(
        (current, next),
        (Lifecycle::Active, Lifecycle::EntryPaused)
            | (Lifecycle::Active, Lifecycle::Deprecated)
            | (Lifecycle::EntryPaused, Lifecycle::Deprecated)
    )
}

fn activation_slot(config: &ProtocolConfig) -> Result<u64> {
    Clock::get()?
        .slot
        .checked_add(config.config_delay_slots)
        .ok_or_else(|| error!(ErrorCode::ActivationSlotOverflow))
}

fn clear_pending_registration(index: &mut CashCarrySeriesBindingIndex) {
    index.pending_record = Pubkey::default();
    index.pending_binding_hash = [0u8; HASH_BYTE_LENGTH];
    index.activation_slot = None;
}

fn emit_activation(
    actor: Pubkey,
    record: &Account<CashCarrySeriesBindingRecord>,
    previous_record: Pubkey,
) {
    emit!(CashCarrySeriesBindingActivated {
        actor,
        record: record.key(),
        previous_record,
        identity_key: record.identity_key,
        binding_version: record.binding.binding_version,
        binding_hash: record.binding_hash,
        lifecycle: record.lifecycle,
    });
}

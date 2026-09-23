use anchor_lang::{prelude::*, solana_program::bpf_loader_upgradeable::get_program_data_address};
use anchor_spl::token::ID as TOKEN_PROGRAM_ID;
use solana_sdk_ids::bpf_loader_upgradeable;
use solana_sha256_hasher::hashv;

use crate::{
    constants::{
        ADAPTER_RESOURCE_SEED, ASSET_RESOURCE_SEED, MARKET_RESOURCE_SEED, PROTOCOL_CONFIG_SEED,
        RESOURCE_INDEX_SEED, RESOURCE_RECORD_SEED, VENUE_RESOURCE_SEED,
    },
    error::ErrorCode,
    events::{
        ResourceActivated, ResourceControlActivated, ResourceControlCancelled,
        ResourceControlProposed, ResourceControlTightened, ResourceRegistrationCancelled,
        ResourceRegistrationProposed,
    },
    state::{
        DescriptorRef, ExecutionRole, Lifecycle, ManifestRef, MarketUnits, PendingControl,
        ProtocolConfig, ResourceControl, ResourceIndex, ResourceKind, ResourceManifest,
        ResourceRecord, SettlementRef, CASH_AND_CARRY_TEMPLATE_ID, PERP_ADAPTER_CLASS_ID,
        SPOT_ADAPTER_CLASS_ID, SUPPORTED_ADAPTER_CLASS_VERSION, SUPPORTED_TEMPLATE_VERSION,
    },
    wire::{DomainRef, HASH_BYTE_LENGTH},
};

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ProposeAssetArgs {
    pub identity: ManifestRef,
    pub decimals: u8,
    pub control: ResourceControl,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ProposeVenueArgs {
    pub identity: ManifestRef,
    pub role: ExecutionRole,
    pub base_asset: ManifestRef,
    pub quote_asset: ManifestRef,
    pub control: ResourceControl,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ProposeMarketArgs {
    pub identity: ManifestRef,
    pub role: ExecutionRole,
    pub venue: ManifestRef,
    pub base_asset: ManifestRef,
    pub quote_asset: ManifestRef,
    pub units: MarketUnits,
    pub control: ResourceControl,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ProposeAdapterArgs {
    pub identity: ManifestRef,
    pub role: ExecutionRole,
    pub adapter_class: DescriptorRef,
    pub venue: ManifestRef,
    pub market: ManifestRef,
    pub base_asset: ManifestRef,
    pub quote_asset: ManifestRef,
    pub allowed_template: DescriptorRef,
    pub settlement: SettlementRef,
    pub control: ResourceControl,
}

#[derive(Accounts)]
#[instruction(args: ProposeAssetArgs)]
pub struct ProposeAsset<'info> {
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
        space = 8 + ResourceIndex::INIT_SPACE,
        seeds = [RESOURCE_INDEX_SEED, ASSET_RESOURCE_SEED, args.identity.subject_id.as_ref()],
        bump
    )]
    pub index: Box<Account<'info, ResourceIndex>>,
    #[account(
        init,
        payer = payer,
        space = 8 + ResourceRecord::INIT_SPACE,
        seeds = [
            RESOURCE_RECORD_SEED,
            ASSET_RESOURCE_SEED,
            args.identity.subject_id.as_ref(),
            args.identity.manifest_version.to_be_bytes().as_ref()
        ],
        bump
    )]
    pub record: Box<Account<'info, ResourceRecord>>,
    /// CHECK: Its key, executable flag, and exact recognized token program are checked.
    pub token_program: UncheckedAccount<'info>,
    /// CHECK: Its owner and mint layout are checked against the recognized token program.
    pub mint: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(args: ProposeVenueArgs)]
pub struct ProposeVenue<'info> {
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
        space = 8 + ResourceIndex::INIT_SPACE,
        seeds = [RESOURCE_INDEX_SEED, VENUE_RESOURCE_SEED, args.identity.subject_id.as_ref()],
        bump
    )]
    pub index: Box<Account<'info, ResourceIndex>>,
    #[account(
        init,
        payer = payer,
        space = 8 + ResourceRecord::INIT_SPACE,
        seeds = [
            RESOURCE_RECORD_SEED,
            VENUE_RESOURCE_SEED,
            args.identity.subject_id.as_ref(),
            args.identity.manifest_version.to_be_bytes().as_ref()
        ],
        bump
    )]
    pub record: Box<Account<'info, ResourceRecord>>,
    pub base_asset: Box<Account<'info, ResourceRecord>>,
    pub quote_asset: Box<Account<'info, ResourceRecord>>,
    /// CHECK: Executability, loader ownership, and ProgramData linkage are checked.
    pub venue_program: UncheckedAccount<'info>,
    /// CHECK: The deterministic ProgramData address, owner, and bytes are checked.
    pub venue_program_data: UncheckedAccount<'info>,
    /// CHECK: Its exact key and owner are committed into the immutable record.
    pub venue_account: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(args: ProposeMarketArgs)]
pub struct ProposeMarket<'info> {
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
        space = 8 + ResourceIndex::INIT_SPACE,
        seeds = [RESOURCE_INDEX_SEED, MARKET_RESOURCE_SEED, args.identity.subject_id.as_ref()],
        bump
    )]
    pub index: Box<Account<'info, ResourceIndex>>,
    #[account(
        init,
        payer = payer,
        space = 8 + ResourceRecord::INIT_SPACE,
        seeds = [
            RESOURCE_RECORD_SEED,
            MARKET_RESOURCE_SEED,
            args.identity.subject_id.as_ref(),
            args.identity.manifest_version.to_be_bytes().as_ref()
        ],
        bump
    )]
    pub record: Box<Account<'info, ResourceRecord>>,
    pub venue: Box<Account<'info, ResourceRecord>>,
    pub base_asset: Box<Account<'info, ResourceRecord>>,
    pub quote_asset: Box<Account<'info, ResourceRecord>>,
    /// CHECK: Its live code identity is checked against the venue record.
    pub venue_program: UncheckedAccount<'info>,
    /// CHECK: Its live code identity is checked against the venue record.
    pub venue_program_data: UncheckedAccount<'info>,
    /// CHECK: Its exact key and owner are committed into the immutable record.
    pub market_account: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(args: ProposeAdapterArgs)]
pub struct ProposeAdapter<'info> {
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
        space = 8 + ResourceIndex::INIT_SPACE,
        seeds = [RESOURCE_INDEX_SEED, ADAPTER_RESOURCE_SEED, args.identity.subject_id.as_ref()],
        bump
    )]
    pub index: Box<Account<'info, ResourceIndex>>,
    #[account(
        init,
        payer = payer,
        space = 8 + ResourceRecord::INIT_SPACE,
        seeds = [
            RESOURCE_RECORD_SEED,
            ADAPTER_RESOURCE_SEED,
            args.identity.subject_id.as_ref(),
            args.identity.manifest_version.to_be_bytes().as_ref()
        ],
        bump
    )]
    pub record: Box<Account<'info, ResourceRecord>>,
    pub venue: Box<Account<'info, ResourceRecord>>,
    pub market: Box<Account<'info, ResourceRecord>>,
    pub base_asset: Box<Account<'info, ResourceRecord>>,
    pub quote_asset: Box<Account<'info, ResourceRecord>>,
    /// CHECK: Executability, loader ownership, and ProgramData linkage are checked.
    pub adapter_program: UncheckedAccount<'info>,
    /// CHECK: The deterministic ProgramData address, owner, and bytes are checked.
    pub adapter_program_data: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ActivateInitialResource<'info> {
    pub executor: Signer<'info>,
    #[account(
        seeds = [PROTOCOL_CONFIG_SEED],
        bump = config.bump,
        has_one = executor @ ErrorCode::UnauthorizedRole
    )]
    pub config: Box<Account<'info, ProtocolConfig>>,
    #[account(
        mut,
        seeds = [RESOURCE_INDEX_SEED, record.manifest.kind.seed(), record.manifest.identity.subject_id.as_ref()],
        bump = index.bump
    )]
    pub index: Box<Account<'info, ResourceIndex>>,
    #[account(
        mut,
        seeds = [
            RESOURCE_RECORD_SEED,
            record.manifest.kind.seed(),
            record.manifest.identity.subject_id.as_ref(),
            record.manifest.identity.manifest_version.to_be_bytes().as_ref()
        ],
        bump = record.bump
    )]
    pub record: Box<Account<'info, ResourceRecord>>,
}

#[derive(Accounts)]
pub struct ActivateResourceVersion<'info> {
    pub executor: Signer<'info>,
    #[account(
        seeds = [PROTOCOL_CONFIG_SEED],
        bump = config.bump,
        has_one = executor @ ErrorCode::UnauthorizedRole
    )]
    pub config: Box<Account<'info, ProtocolConfig>>,
    #[account(
        mut,
        seeds = [RESOURCE_INDEX_SEED, record.manifest.kind.seed(), record.manifest.identity.subject_id.as_ref()],
        bump = index.bump
    )]
    pub index: Box<Account<'info, ResourceIndex>>,
    #[account(mut)]
    pub previous_record: Box<Account<'info, ResourceRecord>>,
    #[account(
        mut,
        seeds = [
            RESOURCE_RECORD_SEED,
            record.manifest.kind.seed(),
            record.manifest.identity.subject_id.as_ref(),
            record.manifest.identity.manifest_version.to_be_bytes().as_ref()
        ],
        bump = record.bump
    )]
    pub record: Box<Account<'info, ResourceRecord>>,
}

#[derive(Accounts)]
pub struct CancelResourceRegistration<'info> {
    pub canceller: Signer<'info>,
    #[account(
        seeds = [PROTOCOL_CONFIG_SEED],
        bump = config.bump,
        has_one = canceller @ ErrorCode::UnauthorizedRole
    )]
    pub config: Box<Account<'info, ProtocolConfig>>,
    #[account(
        mut,
        seeds = [RESOURCE_INDEX_SEED, record.manifest.kind.seed(), record.manifest.identity.subject_id.as_ref()],
        bump = index.bump
    )]
    pub index: Box<Account<'info, ResourceIndex>>,
    #[account(mut)]
    pub record: Box<Account<'info, ResourceRecord>>,
}

#[derive(Accounts)]
pub struct ProposeResourceControl<'info> {
    pub proposer: Signer<'info>,
    #[account(
        seeds = [PROTOCOL_CONFIG_SEED],
        bump = config.bump,
        has_one = proposer @ ErrorCode::UnauthorizedRole
    )]
    pub config: Box<Account<'info, ProtocolConfig>>,
    #[account(
        seeds = [RESOURCE_INDEX_SEED, record.manifest.kind.seed(), record.manifest.identity.subject_id.as_ref()],
        bump = index.bump
    )]
    pub index: Box<Account<'info, ResourceIndex>>,
    #[account(mut)]
    pub record: Box<Account<'info, ResourceRecord>>,
}

#[derive(Accounts)]
pub struct CancelResourceControl<'info> {
    pub canceller: Signer<'info>,
    #[account(
        seeds = [PROTOCOL_CONFIG_SEED],
        bump = config.bump,
        has_one = canceller @ ErrorCode::UnauthorizedRole
    )]
    pub config: Box<Account<'info, ProtocolConfig>>,
    #[account(
        seeds = [RESOURCE_INDEX_SEED, record.manifest.kind.seed(), record.manifest.identity.subject_id.as_ref()],
        bump = index.bump
    )]
    pub index: Box<Account<'info, ResourceIndex>>,
    #[account(mut)]
    pub record: Box<Account<'info, ResourceRecord>>,
}

#[derive(Accounts)]
pub struct ActivateResourceControl<'info> {
    pub executor: Signer<'info>,
    #[account(
        seeds = [PROTOCOL_CONFIG_SEED],
        bump = config.bump,
        has_one = executor @ ErrorCode::UnauthorizedRole
    )]
    pub config: Box<Account<'info, ProtocolConfig>>,
    #[account(
        seeds = [RESOURCE_INDEX_SEED, record.manifest.kind.seed(), record.manifest.identity.subject_id.as_ref()],
        bump = index.bump
    )]
    pub index: Box<Account<'info, ResourceIndex>>,
    #[account(mut)]
    pub record: Box<Account<'info, ResourceRecord>>,
}

#[derive(Accounts)]
pub struct TightenResourceControl<'info> {
    pub pauser: Signer<'info>,
    #[account(
        seeds = [PROTOCOL_CONFIG_SEED],
        bump = config.bump,
        has_one = pauser @ ErrorCode::UnauthorizedRole
    )]
    pub config: Box<Account<'info, ProtocolConfig>>,
    #[account(
        mut,
        seeds = [RESOURCE_INDEX_SEED, record.manifest.kind.seed(), record.manifest.identity.subject_id.as_ref()],
        bump = index.bump
    )]
    pub index: Box<Account<'info, ResourceIndex>>,
    #[account(mut)]
    pub record: Box<Account<'info, ResourceRecord>>,
}

pub(crate) fn propose_asset(ctx: Context<ProposeAsset>, args: ProposeAssetArgs) -> Result<()> {
    args.identity.validate()?;
    require_keys_eq!(
        ctx.accounts.token_program.key(),
        TOKEN_PROGRAM_ID,
        ErrorCode::ResourceProgramUnsupported
    );
    require!(
        ctx.accounts.token_program.executable,
        ErrorCode::ResourceProgramUnsupported
    );
    require_keys_eq!(
        *ctx.accounts.mint.owner,
        TOKEN_PROGRAM_ID,
        ErrorCode::ResourceAccountMismatch
    );
    let data = ctx.accounts.mint.try_borrow_data()?;
    require!(
        data.len() >= 82 && data[45] == 1,
        ErrorCode::ResourceAccountMismatch
    );
    require!(
        data[44] == args.decimals,
        ErrorCode::ResourceDecimalsMismatch
    );
    drop(data);

    let manifest = ResourceManifest {
        kind: ResourceKind::Asset,
        domain: ctx.accounts.config.domain.clone(),
        identity: args.identity,
        subject_address: ctx.accounts.mint.key(),
        program_id: TOKEN_PROGRAM_ID,
        program_data: Pubkey::default(),
        code_identity: [0u8; HASH_BYTE_LENGTH],
        decimals: args.decimals,
        quote_decimals: 0,
        role: ExecutionRole::None,
        adapter_class: None,
        venue: None,
        market: None,
        base_asset: None,
        quote_asset: None,
        allowed_template: None,
        settlement: None,
        market_units: None,
    };
    propose_registration(
        &ctx.accounts.config,
        &mut ctx.accounts.index,
        &mut ctx.accounts.record,
        manifest,
        args.control,
        ctx.bumps.index,
        ctx.bumps.record,
        ctx.accounts.proposer.key(),
    )
}

pub(crate) fn propose_venue(ctx: Context<ProposeVenue>, args: ProposeVenueArgs) -> Result<()> {
    require_role(args.role)?;
    require_asset_ref(
        &ctx.accounts.base_asset,
        &ctx.accounts.config.domain,
        &args.base_asset,
    )?;
    require_asset_ref(
        &ctx.accounts.quote_asset,
        &ctx.accounts.config.domain,
        &args.quote_asset,
    )?;
    require!(
        args.base_asset != args.quote_asset,
        ErrorCode::ResourceInstancesNotDistinct
    );
    require_keys_eq!(
        *ctx.accounts.venue_account.owner,
        ctx.accounts.venue_program.key(),
        ErrorCode::ResourceAccountMismatch
    );
    let code_identity = live_code_identity(
        &ctx.accounts.venue_program,
        &ctx.accounts.venue_program_data,
    )?;
    let manifest = ResourceManifest {
        kind: ResourceKind::Venue,
        domain: ctx.accounts.config.domain.clone(),
        identity: args.identity,
        subject_address: ctx.accounts.venue_account.key(),
        program_id: ctx.accounts.venue_program.key(),
        program_data: ctx.accounts.venue_program_data.key(),
        code_identity,
        decimals: 0,
        quote_decimals: ctx.accounts.quote_asset.manifest.decimals,
        role: args.role,
        adapter_class: None,
        venue: None,
        market: None,
        base_asset: Some(args.base_asset),
        quote_asset: Some(args.quote_asset),
        allowed_template: None,
        settlement: None,
        market_units: None,
    };
    propose_registration(
        &ctx.accounts.config,
        &mut ctx.accounts.index,
        &mut ctx.accounts.record,
        manifest,
        args.control,
        ctx.bumps.index,
        ctx.bumps.record,
        ctx.accounts.proposer.key(),
    )
}

pub(crate) fn propose_market(ctx: Context<ProposeMarket>, args: ProposeMarketArgs) -> Result<()> {
    require_role(args.role)?;
    require_resource_ref(
        &ctx.accounts.venue,
        &ctx.accounts.config.domain,
        ResourceKind::Venue,
        args.role,
        &args.venue,
    )?;
    require_asset_ref(
        &ctx.accounts.base_asset,
        &ctx.accounts.config.domain,
        &args.base_asset,
    )?;
    require_asset_ref(
        &ctx.accounts.quote_asset,
        &ctx.accounts.config.domain,
        &args.quote_asset,
    )?;
    require_graph_assets(
        &ctx.accounts.venue.manifest,
        &args.base_asset,
        &args.quote_asset,
    )?;
    verify_code_identity(
        &ctx.accounts.venue.manifest,
        &ctx.accounts.venue_program,
        &ctx.accounts.venue_program_data,
    )?;
    require_keys_eq!(
        *ctx.accounts.market_account.owner,
        ctx.accounts.venue_program.key(),
        ErrorCode::ResourceAccountMismatch
    );
    args.units.validate(
        ctx.accounts.base_asset.manifest.decimals,
        ctx.accounts.quote_asset.manifest.decimals,
    )?;
    let manifest = ResourceManifest {
        kind: ResourceKind::Market,
        domain: ctx.accounts.config.domain.clone(),
        identity: args.identity,
        subject_address: ctx.accounts.market_account.key(),
        program_id: ctx.accounts.venue_program.key(),
        program_data: ctx.accounts.venue_program_data.key(),
        code_identity: ctx.accounts.venue.manifest.code_identity,
        decimals: 0,
        quote_decimals: ctx.accounts.quote_asset.manifest.decimals,
        role: args.role,
        adapter_class: None,
        venue: Some(args.venue),
        market: None,
        base_asset: Some(args.base_asset),
        quote_asset: Some(args.quote_asset),
        allowed_template: None,
        settlement: None,
        market_units: Some(args.units),
    };
    propose_registration(
        &ctx.accounts.config,
        &mut ctx.accounts.index,
        &mut ctx.accounts.record,
        manifest,
        args.control,
        ctx.bumps.index,
        ctx.bumps.record,
        ctx.accounts.proposer.key(),
    )
}

pub(crate) fn propose_adapter(
    ctx: Context<ProposeAdapter>,
    args: ProposeAdapterArgs,
) -> Result<()> {
    require_role(args.role)?;
    require_resource_ref(
        &ctx.accounts.venue,
        &ctx.accounts.config.domain,
        ResourceKind::Venue,
        args.role,
        &args.venue,
    )?;
    require_resource_ref(
        &ctx.accounts.market,
        &ctx.accounts.config.domain,
        ResourceKind::Market,
        args.role,
        &args.market,
    )?;
    require_asset_ref(
        &ctx.accounts.base_asset,
        &ctx.accounts.config.domain,
        &args.base_asset,
    )?;
    require_asset_ref(
        &ctx.accounts.quote_asset,
        &ctx.accounts.config.domain,
        &args.quote_asset,
    )?;
    require_graph_assets(
        &ctx.accounts.venue.manifest,
        &args.base_asset,
        &args.quote_asset,
    )?;
    require_graph_assets(
        &ctx.accounts.market.manifest,
        &args.base_asset,
        &args.quote_asset,
    )?;
    require!(
        ctx.accounts.market.manifest.venue.as_ref() == Some(&args.venue),
        ErrorCode::ResourceReferenceShape
    );
    validate_adapter_descriptor(args.role, &args.adapter_class)?;
    validate_template(&args.allowed_template)?;
    args.settlement.validate()?;
    let code_identity = live_code_identity(
        &ctx.accounts.adapter_program,
        &ctx.accounts.adapter_program_data,
    )?;
    let manifest = ResourceManifest {
        kind: ResourceKind::Adapter,
        domain: ctx.accounts.config.domain.clone(),
        identity: args.identity,
        subject_address: ctx.accounts.adapter_program.key(),
        program_id: ctx.accounts.adapter_program.key(),
        program_data: ctx.accounts.adapter_program_data.key(),
        code_identity,
        decimals: 0,
        quote_decimals: ctx.accounts.quote_asset.manifest.decimals,
        role: args.role,
        adapter_class: Some(args.adapter_class),
        venue: Some(args.venue),
        market: Some(args.market),
        base_asset: Some(args.base_asset),
        quote_asset: Some(args.quote_asset),
        allowed_template: Some(args.allowed_template),
        settlement: Some(args.settlement),
        market_units: None,
    };
    propose_registration(
        &ctx.accounts.config,
        &mut ctx.accounts.index,
        &mut ctx.accounts.record,
        manifest,
        args.control,
        ctx.bumps.index,
        ctx.bumps.record,
        ctx.accounts.proposer.key(),
    )
}

pub(crate) fn activate_initial_resource(ctx: Context<ActivateInitialResource>) -> Result<()> {
    require_keys_eq!(
        ctx.accounts.index.active_record,
        Pubkey::default(),
        ErrorCode::ResourceAlreadyActive
    );
    activate_record(
        &ctx.accounts.config,
        &mut ctx.accounts.index,
        &mut ctx.accounts.record,
    )?;
    emit_activation(
        ctx.accounts.executor.key(),
        &ctx.accounts.record,
        Pubkey::default(),
    );
    Ok(())
}

pub(crate) fn activate_resource_version(ctx: Context<ActivateResourceVersion>) -> Result<()> {
    require_keys_eq!(
        ctx.accounts.index.active_record,
        ctx.accounts.previous_record.key(),
        ErrorCode::ResourceIndexMismatch
    );
    require!(
        ctx.accounts.previous_record.active,
        ErrorCode::ResourceNotActive
    );
    require!(
        ctx.accounts.previous_record.manifest.kind == ctx.accounts.record.manifest.kind
            && ctx.accounts.previous_record.manifest.identity.subject_id
                == ctx.accounts.record.manifest.identity.subject_id,
        ErrorCode::ResourceIndexMismatch
    );
    activate_record(
        &ctx.accounts.config,
        &mut ctx.accounts.index,
        &mut ctx.accounts.record,
    )?;
    ctx.accounts.previous_record.active = false;
    emit_activation(
        ctx.accounts.executor.key(),
        &ctx.accounts.record,
        ctx.accounts.previous_record.key(),
    );
    Ok(())
}

pub(crate) fn cancel_resource_registration(ctx: Context<CancelResourceRegistration>) -> Result<()> {
    require_pending_registration(&ctx.accounts.index, &ctx.accounts.record)?;
    emit!(ResourceRegistrationCancelled {
        actor: ctx.accounts.canceller.key(),
        record: ctx.accounts.record.key(),
        kind: ctx.accounts.record.manifest.kind,
        subject_id: ctx.accounts.record.manifest.identity.subject_id,
        manifest_version: ctx.accounts.record.manifest.identity.manifest_version,
        manifest_hash: ctx.accounts.record.manifest.identity.manifest_hash,
    });
    ctx.accounts.index.pending_record = Pubkey::default();
    ctx.accounts.index.pending_identity = None;
    ctx.accounts.index.activation_slot = None;
    ctx.accounts.record.pending_control = None;
    Ok(())
}

pub(crate) fn propose_resource_control(
    ctx: Context<ProposeResourceControl>,
    control: ResourceControl,
) -> Result<()> {
    require_active_record(
        &ctx.accounts.config,
        &ctx.accounts.index,
        &ctx.accounts.record,
    )?;
    require!(
        ctx.accounts.record.control.lifecycle != Lifecycle::Deprecated,
        ErrorCode::ResourceDeprecatedTerminal
    );
    require!(
        ctx.accounts.record.pending_control.is_none(),
        ErrorCode::ResourceControlProposalExists
    );
    control.validate_for(&ctx.accounts.record.manifest)?;
    let activation_slot = activation_slot(&ctx.accounts.config)?;
    emit!(ResourceControlProposed {
        actor: ctx.accounts.proposer.key(),
        record: ctx.accounts.record.key(),
        lifecycle: control.lifecycle,
        activation_slot,
    });
    ctx.accounts.record.pending_control = Some(PendingControl {
        control,
        activation_slot,
    });
    Ok(())
}

pub(crate) fn cancel_resource_control(ctx: Context<CancelResourceControl>) -> Result<()> {
    require_active_record(
        &ctx.accounts.config,
        &ctx.accounts.index,
        &ctx.accounts.record,
    )?;
    require!(
        ctx.accounts.record.pending_control.is_some(),
        ErrorCode::ResourceControlProposalMissing
    );
    emit!(ResourceControlCancelled {
        actor: ctx.accounts.canceller.key(),
        record: ctx.accounts.record.key(),
    });
    ctx.accounts.record.pending_control = None;
    Ok(())
}

pub(crate) fn activate_resource_control(ctx: Context<ActivateResourceControl>) -> Result<()> {
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
        .ok_or_else(|| error!(ErrorCode::ResourceControlProposalMissing))?;
    require_gte!(
        Clock::get()?.slot,
        pending.activation_slot,
        ErrorCode::ResourceControlProposalNotReady
    );
    ctx.accounts.record.control = pending.control;
    ctx.accounts.record.pending_control = None;
    emit!(ResourceControlActivated {
        actor: ctx.accounts.executor.key(),
        record: ctx.accounts.record.key(),
        lifecycle: ctx.accounts.record.control.lifecycle,
    });
    Ok(())
}

pub(crate) fn tighten_resource_control(
    ctx: Context<TightenResourceControl>,
    control: ResourceControl,
) -> Result<()> {
    require_active_record(
        &ctx.accounts.config,
        &ctx.accounts.index,
        &ctx.accounts.record,
    )?;
    control.validate_for(&ctx.accounts.record.manifest)?;
    require!(
        control.is_immediate_tightening_of(&ctx.accounts.record.control),
        ErrorCode::ResourceUnsafeImmediateControl
    );
    let registration_cancelled = ctx.accounts.index.pending_record != Pubkey::default();
    let control_cancelled = ctx.accounts.record.pending_control.is_some();
    ctx.accounts.record.control = control;
    ctx.accounts.record.pending_control = None;
    ctx.accounts.index.pending_record = Pubkey::default();
    ctx.accounts.index.pending_identity = None;
    ctx.accounts.index.activation_slot = None;
    emit!(ResourceControlTightened {
        actor: ctx.accounts.pauser.key(),
        record: ctx.accounts.record.key(),
        lifecycle: ctx.accounts.record.control.lifecycle,
        registration_cancelled,
        control_cancelled,
    });
    Ok(())
}

fn propose_registration(
    config: &Account<ProtocolConfig>,
    index: &mut Account<ResourceIndex>,
    record: &mut Account<ResourceRecord>,
    manifest: ResourceManifest,
    control: ResourceControl,
    index_bump: u8,
    record_bump: u8,
    actor: Pubkey,
) -> Result<()> {
    manifest.identity.validate()?;
    require!(
        manifest.domain == config.domain,
        ErrorCode::ResourceDomainMismatch
    );
    require!(
        manifest.subject_address != Pubkey::default() && manifest.program_id != Pubkey::default(),
        ErrorCode::ResourceAddressZero
    );
    validate_manifest_shape(&manifest)?;
    control.validate_for(&manifest)?;
    if index.subject_id == [0u8; HASH_BYTE_LENGTH] {
        index.kind = manifest.kind;
        index.subject_id = manifest.identity.subject_id;
        index.latest_version = 0;
        index.active_record = Pubkey::default();
        index.active_identity = None;
        index.pending_record = Pubkey::default();
        index.pending_identity = None;
        index.activation_slot = None;
        index.bump = index_bump;
    }
    require!(
        index.kind == manifest.kind && index.subject_id == manifest.identity.subject_id,
        ErrorCode::ResourceIndexMismatch
    );
    require_keys_eq!(
        index.pending_record,
        Pubkey::default(),
        ErrorCode::ResourceRegistrationExists
    );
    require_gt!(
        manifest.identity.manifest_version,
        index.latest_version,
        ErrorCode::ResourceManifestVersionNotIncreasing
    );
    let ready_slot = activation_slot(config)?;
    index.latest_version = manifest.identity.manifest_version;
    index.pending_record = record.key();
    index.pending_identity = Some(manifest.identity.clone());
    index.activation_slot = Some(ready_slot);
    record.set_inner(ResourceRecord {
        manifest,
        control: ResourceControl::fail_closed(),
        pending_control: Some(PendingControl {
            control,
            activation_slot: ready_slot,
        }),
        active: false,
        bump: record_bump,
    });
    emit!(ResourceRegistrationProposed {
        actor,
        record: record.key(),
        kind: record.manifest.kind,
        subject_id: record.manifest.identity.subject_id,
        manifest_version: record.manifest.identity.manifest_version,
        manifest_hash: record.manifest.identity.manifest_hash,
        activation_slot: ready_slot,
    });
    Ok(())
}

fn validate_manifest_shape(manifest: &ResourceManifest) -> Result<()> {
    let has_code_identity = manifest.program_data != Pubkey::default()
        && manifest.code_identity != [0u8; HASH_BYTE_LENGTH];
    match manifest.kind {
        ResourceKind::Asset => require!(
            manifest.role == ExecutionRole::None
                && manifest.program_data == Pubkey::default()
                && manifest.code_identity == [0u8; HASH_BYTE_LENGTH]
                && manifest.quote_decimals == 0
                && manifest.adapter_class.is_none()
                && manifest.venue.is_none()
                && manifest.market.is_none()
                && manifest.base_asset.is_none()
                && manifest.quote_asset.is_none()
                && manifest.allowed_template.is_none()
                && manifest.settlement.is_none()
                && manifest.market_units.is_none(),
            ErrorCode::ResourceReferenceShape
        ),
        ResourceKind::Venue => require!(
            manifest.role != ExecutionRole::None
                && has_code_identity
                && manifest.decimals == 0
                && manifest.adapter_class.is_none()
                && manifest.venue.is_none()
                && manifest.market.is_none()
                && manifest.base_asset.is_some()
                && manifest.quote_asset.is_some()
                && manifest.allowed_template.is_none()
                && manifest.settlement.is_none()
                && manifest.market_units.is_none(),
            ErrorCode::ResourceReferenceShape
        ),
        ResourceKind::Market => require!(
            manifest.role != ExecutionRole::None
                && has_code_identity
                && manifest.decimals == 0
                && manifest.adapter_class.is_none()
                && manifest.venue.is_some()
                && manifest.market.is_none()
                && manifest.base_asset.is_some()
                && manifest.quote_asset.is_some()
                && manifest.allowed_template.is_none()
                && manifest.settlement.is_none()
                && manifest.market_units.is_some(),
            ErrorCode::ResourceReferenceShape
        ),
        ResourceKind::Adapter => require!(
            manifest.role != ExecutionRole::None
                && has_code_identity
                && manifest.decimals == 0
                && manifest.adapter_class.is_some()
                && manifest.venue.is_some()
                && manifest.market.is_some()
                && manifest.base_asset.is_some()
                && manifest.quote_asset.is_some()
                && manifest.allowed_template.is_some()
                && manifest.settlement.is_some()
                && manifest.market_units.is_none(),
            ErrorCode::ResourceReferenceShape
        ),
    }
    Ok(())
}

fn emit_activation(actor: Pubkey, record: &Account<ResourceRecord>, previous_record: Pubkey) {
    emit!(ResourceActivated {
        actor,
        record: record.key(),
        previous_record,
        kind: record.manifest.kind,
        subject_id: record.manifest.identity.subject_id,
        manifest_version: record.manifest.identity.manifest_version,
        manifest_hash: record.manifest.identity.manifest_hash,
        lifecycle: record.control.lifecycle,
    });
}

fn activate_record(
    config: &Account<ProtocolConfig>,
    index: &mut Account<ResourceIndex>,
    record: &mut Account<ResourceRecord>,
) -> Result<()> {
    require_pending_registration(index, record)?;
    require!(
        record.manifest.domain == config.domain,
        ErrorCode::ResourceDomainMismatch
    );
    let ready_slot = index
        .activation_slot
        .ok_or_else(|| error!(ErrorCode::ResourceRegistrationMissing))?;
    require_gte!(
        Clock::get()?.slot,
        ready_slot,
        ErrorCode::ResourceRegistrationNotReady
    );
    let pending = record
        .pending_control
        .clone()
        .ok_or_else(|| error!(ErrorCode::ResourceRegistrationMissing))?;
    require!(
        pending.activation_slot == ready_slot,
        ErrorCode::ResourceIndexMismatch
    );
    record.control = pending.control;
    record.pending_control = None;
    record.active = true;
    index.active_record = record.key();
    index.active_identity = Some(record.manifest.identity.clone());
    index.pending_record = Pubkey::default();
    index.pending_identity = None;
    index.activation_slot = None;
    Ok(())
}

fn require_pending_registration(
    index: &ResourceIndex,
    record: &Account<ResourceRecord>,
) -> Result<()> {
    require_keys_eq!(
        index.pending_record,
        record.key(),
        ErrorCode::ResourceRegistrationMissing
    );
    require!(
        index.pending_identity.as_ref() == Some(&record.manifest.identity),
        ErrorCode::ResourceIndexMismatch
    );
    require!(!record.active, ErrorCode::ResourceAlreadyActive);
    Ok(())
}

fn require_active_record(
    config: &ProtocolConfig,
    index: &ResourceIndex,
    record: &Account<ResourceRecord>,
) -> Result<()> {
    require_keys_eq!(
        index.active_record,
        record.key(),
        ErrorCode::ResourceNotActive
    );
    require!(record.active, ErrorCode::ResourceNotActive);
    require!(
        index.active_identity.as_ref() == Some(&record.manifest.identity),
        ErrorCode::ResourceIndexMismatch
    );
    require!(
        record.manifest.domain == config.domain,
        ErrorCode::ResourceDomainMismatch
    );
    Ok(())
}

fn require_asset_ref(
    record: &ResourceRecord,
    domain: &DomainRef,
    expected: &ManifestRef,
) -> Result<()> {
    require_resource_ref(
        record,
        domain,
        ResourceKind::Asset,
        ExecutionRole::None,
        expected,
    )
}

fn require_resource_ref(
    record: &ResourceRecord,
    domain: &DomainRef,
    kind: ResourceKind,
    role: ExecutionRole,
    expected: &ManifestRef,
) -> Result<()> {
    require!(record.active, ErrorCode::ResourceNotActive);
    require!(
        record.manifest.domain == *domain,
        ErrorCode::ResourceDomainMismatch
    );
    require!(
        record.manifest.kind == kind
            && record.manifest.role == role
            && record.manifest.identity == *expected,
        ErrorCode::ResourceReferenceShape
    );
    Ok(())
}

fn require_graph_assets(
    manifest: &ResourceManifest,
    base_asset: &ManifestRef,
    quote_asset: &ManifestRef,
) -> Result<()> {
    require!(
        manifest.base_asset.as_ref() == Some(base_asset)
            && manifest.quote_asset.as_ref() == Some(quote_asset),
        ErrorCode::ResourceReferenceShape
    );
    Ok(())
}

fn require_role(role: ExecutionRole) -> Result<()> {
    require!(
        matches!(role, ExecutionRole::Spot | ExecutionRole::Perp),
        ErrorCode::ResourceRoleMismatch
    );
    Ok(())
}

fn validate_adapter_descriptor(role: ExecutionRole, descriptor: &DescriptorRef) -> Result<()> {
    descriptor.id.as_str();
    require!(
        descriptor.version == SUPPORTED_ADAPTER_CLASS_VERSION
            && descriptor.manifest_hash != [0u8; HASH_BYTE_LENGTH],
        ErrorCode::ResourceDescriptorUnsupported
    );
    let expected = match role {
        ExecutionRole::Spot => SPOT_ADAPTER_CLASS_ID,
        ExecutionRole::Perp => PERP_ADAPTER_CLASS_ID,
        ExecutionRole::None => return err!(ErrorCode::ResourceRoleMismatch),
    };
    require!(
        descriptor.id.as_str() == expected,
        ErrorCode::ResourceDescriptorUnsupported
    );
    Ok(())
}

fn validate_template(template: &DescriptorRef) -> Result<()> {
    require!(
        template.id.as_str() == CASH_AND_CARRY_TEMPLATE_ID
            && template.version == SUPPORTED_TEMPLATE_VERSION
            && template.manifest_hash != [0u8; HASH_BYTE_LENGTH],
        ErrorCode::ResourceDescriptorUnsupported
    );
    Ok(())
}

fn activation_slot(config: &ProtocolConfig) -> Result<u64> {
    checked_activation_slot(Clock::get()?.slot, config.config_delay_slots)
}

fn checked_activation_slot(slot: u64, delay: u64) -> Result<u64> {
    slot.checked_add(delay)
        .ok_or_else(|| error!(ErrorCode::ActivationSlotOverflow))
}

fn live_code_identity(program: &AccountInfo, program_data: &AccountInfo) -> Result<[u8; 32]> {
    require!(program.executable, ErrorCode::ResourceProgramUnsupported);
    require_keys_eq!(
        *program.owner,
        bpf_loader_upgradeable::id(),
        ErrorCode::ResourceProgramUnsupported
    );
    require_keys_eq!(
        program_data.key(),
        get_program_data_address(program.key),
        ErrorCode::ResourceCodeIdentityMismatch
    );
    require_keys_eq!(
        *program_data.owner,
        bpf_loader_upgradeable::id(),
        ErrorCode::ResourceCodeIdentityMismatch
    );
    let data = program_data.try_borrow_data()?;
    require!(!data.is_empty(), ErrorCode::ResourceCodeIdentityMismatch);
    Ok(hashv(&[data.as_ref()]).to_bytes())
}

pub fn verify_code_identity(
    manifest: &ResourceManifest,
    program: &AccountInfo,
    program_data: &AccountInfo,
) -> Result<()> {
    require_keys_eq!(
        manifest.program_id,
        program.key(),
        ErrorCode::ResourceAccountMismatch
    );
    require_keys_eq!(
        manifest.program_data,
        program_data.key(),
        ErrorCode::ResourceCodeIdentityMismatch
    );
    require!(
        manifest.code_identity == live_code_identity(program, program_data)?,
        ErrorCode::ResourceCodeIdentityMismatch
    );
    Ok(())
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum ResourceAction {
    Entry,
    Exit,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct CashCarryAdmission {
    pub domain: DomainRef,
    pub spot_adapter: ManifestRef,
    pub perp_adapter: ManifestRef,
    pub spot_market: ManifestRef,
    pub perp_market: ManifestRef,
    pub spot_venue: ManifestRef,
    pub perp_venue: ManifestRef,
    pub base_asset: ManifestRef,
    pub quote_asset: ManifestRef,
    pub quote_decimals: u8,
    pub template: DescriptorRef,
    pub settlement: SettlementRef,
    pub action: ResourceAction,
    pub spot_quantity_atoms: u64,
    pub perp_quantity_atoms: u64,
    pub spot_limit_quote_atoms_per_base_lot: u64,
    pub perp_limit_quote_atoms_per_base_lot: u64,
    pub package_notional_atoms: u64,
}

pub struct CashCarryResources<'a> {
    pub spot_adapter: &'a ResourceRecord,
    pub perp_adapter: &'a ResourceRecord,
    pub spot_market: &'a ResourceRecord,
    pub perp_market: &'a ResourceRecord,
    pub spot_venue: &'a ResourceRecord,
    pub perp_venue: &'a ResourceRecord,
    pub base_asset: &'a ResourceRecord,
    pub quote_asset: &'a ResourceRecord,
}

pub fn validate_cash_carry_admission(
    config: &ProtocolConfig,
    admission: &CashCarryAdmission,
    resources: &CashCarryResources,
) -> Result<u64> {
    require!(
        admission.domain == config.domain,
        ErrorCode::ResourceDomainMismatch
    );
    require!(
        admission.package_notional_atoms != 0,
        ErrorCode::ResourceMaximumNotionalZero
    );
    validate_template(&admission.template)?;
    admission.settlement.validate()?;
    require!(
        admission.spot_adapter != admission.perp_adapter
            && admission.spot_market != admission.perp_market
            && admission.spot_venue != admission.perp_venue
            && admission.base_asset != admission.quote_asset,
        ErrorCode::ResourceInstancesNotDistinct
    );

    let checks = [
        (
            resources.spot_adapter,
            ResourceKind::Adapter,
            ExecutionRole::Spot,
            &admission.spot_adapter,
        ),
        (
            resources.perp_adapter,
            ResourceKind::Adapter,
            ExecutionRole::Perp,
            &admission.perp_adapter,
        ),
        (
            resources.spot_market,
            ResourceKind::Market,
            ExecutionRole::Spot,
            &admission.spot_market,
        ),
        (
            resources.perp_market,
            ResourceKind::Market,
            ExecutionRole::Perp,
            &admission.perp_market,
        ),
        (
            resources.spot_venue,
            ResourceKind::Venue,
            ExecutionRole::Spot,
            &admission.spot_venue,
        ),
        (
            resources.perp_venue,
            ResourceKind::Venue,
            ExecutionRole::Perp,
            &admission.perp_venue,
        ),
        (
            resources.base_asset,
            ResourceKind::Asset,
            ExecutionRole::None,
            &admission.base_asset,
        ),
        (
            resources.quote_asset,
            ResourceKind::Asset,
            ExecutionRole::None,
            &admission.quote_asset,
        ),
    ];
    for (record, kind, role, identity) in checks {
        require_resource_ref(record, &config.domain, kind, role, identity)?;
        require_action(record.control.lifecycle, admission.action)?;
    }
    require!(
        resources.quote_asset.manifest.decimals == admission.quote_decimals,
        ErrorCode::ResourceDecimalsMismatch
    );
    require_graph(
        resources.spot_venue,
        None,
        &admission.base_asset,
        &admission.quote_asset,
    )?;
    require_graph(
        resources.perp_venue,
        None,
        &admission.base_asset,
        &admission.quote_asset,
    )?;
    let spot_units = resources
        .spot_market
        .manifest
        .market_units
        .as_ref()
        .ok_or_else(|| error!(ErrorCode::ResourceReferenceShape))?;
    let perp_units = resources
        .perp_market
        .manifest
        .market_units
        .as_ref()
        .ok_or_else(|| error!(ErrorCode::ResourceReferenceShape))?;
    spot_units.validate(
        resources.base_asset.manifest.decimals,
        admission.quote_decimals,
    )?;
    perp_units.validate(
        resources.base_asset.manifest.decimals,
        admission.quote_decimals,
    )?;
    let spot_notional = validate_market_leg(
        spot_units,
        admission.spot_quantity_atoms,
        admission.spot_limit_quote_atoms_per_base_lot,
    )?;
    let perp_notional = validate_market_leg(
        perp_units,
        admission.perp_quantity_atoms,
        admission.perp_limit_quote_atoms_per_base_lot,
    )?;
    require_equal_economic_quantity(
        spot_units,
        admission.spot_quantity_atoms,
        perp_units,
        admission.perp_quantity_atoms,
    )?;
    require!(
        admission.package_notional_atoms == spot_notional.max(perp_notional),
        ErrorCode::ResourcePackageNotionalMismatch
    );
    require_graph(
        resources.spot_market,
        Some(&admission.spot_venue),
        &admission.base_asset,
        &admission.quote_asset,
    )?;
    require_graph(
        resources.perp_market,
        Some(&admission.perp_venue),
        &admission.base_asset,
        &admission.quote_asset,
    )?;
    require_adapter_graph(
        resources.spot_adapter,
        &admission.spot_venue,
        &admission.spot_market,
        &admission,
    )?;
    require_adapter_graph(
        resources.perp_adapter,
        &admission.perp_venue,
        &admission.perp_market,
        &admission,
    )?;

    let limited = [
        resources.spot_adapter,
        resources.perp_adapter,
        resources.spot_market,
        resources.perp_market,
        resources.spot_venue,
        resources.perp_venue,
    ];
    let mut maximum = u64::MAX;
    for record in limited {
        let limit = record
            .control
            .quote_limit
            .as_ref()
            .ok_or_else(|| error!(ErrorCode::ResourceQuoteLimitMissing))?;
        limit.validate(&admission.quote_asset, admission.quote_decimals)?;
        maximum = maximum.min(limit.maximum_notional_atoms);
    }
    if admission.action == ResourceAction::Entry {
        require!(
            admission.package_notional_atoms <= maximum,
            ErrorCode::ResourceMaximumNotionalExceeded
        );
    }
    Ok(maximum)
}

fn validate_market_leg(
    units: &MarketUnits,
    quantity_atoms: u64,
    limit_quote_atoms_per_base_lot: u64,
) -> Result<u64> {
    require!(
        quantity_atoms != 0 && limit_quote_atoms_per_base_lot != 0,
        ErrorCode::ResourceLegValueZero
    );
    require!(
        quantity_atoms % units.base_lot_atoms == 0,
        ErrorCode::ResourceBaseLotMismatch
    );
    require!(
        limit_quote_atoms_per_base_lot % units.quote_tick_atoms_per_base_lot == 0,
        ErrorCode::ResourceQuoteTickMismatch
    );
    let base_lot_count = quantity_atoms / units.base_lot_atoms;
    let notional = base_lot_count
        .checked_mul(limit_quote_atoms_per_base_lot)
        .ok_or_else(|| error!(ErrorCode::ResourceNotionalOverflow))?;
    require!(
        notional >= units.minimum_quote_notional_atoms,
        ErrorCode::ResourceMinimumNotionalNotMet
    );
    Ok(notional)
}

fn require_equal_economic_quantity(
    spot_units: &MarketUnits,
    spot_quantity_atoms: u64,
    perp_units: &MarketUnits,
    perp_quantity_atoms: u64,
) -> Result<()> {
    let spot = u128::from(spot_quantity_atoms)
        .checked_mul(u128::from(spot_units.multiplier_numerator))
        .and_then(|value| value.checked_mul(u128::from(perp_units.multiplier_denominator)))
        .ok_or_else(|| error!(ErrorCode::ResourceNotionalOverflow))?;
    let perp = u128::from(perp_quantity_atoms)
        .checked_mul(u128::from(perp_units.multiplier_numerator))
        .and_then(|value| value.checked_mul(u128::from(spot_units.multiplier_denominator)))
        .ok_or_else(|| error!(ErrorCode::ResourceNotionalOverflow))?;
    require!(spot == perp, ErrorCode::ResourceEconomicQuantityMismatch);
    Ok(())
}

fn require_action(lifecycle: Lifecycle, action: ResourceAction) -> Result<()> {
    let allowed = match action {
        ResourceAction::Entry => lifecycle.allows_entry(),
        ResourceAction::Exit => lifecycle.allows_exit(),
    };
    require!(allowed, ErrorCode::ResourceActionNotAllowed);
    Ok(())
}

fn require_graph(
    record: &ResourceRecord,
    venue: Option<&ManifestRef>,
    base_asset: &ManifestRef,
    quote_asset: &ManifestRef,
) -> Result<()> {
    require_graph_assets(&record.manifest, base_asset, quote_asset)?;
    if let Some(expected) = venue {
        require!(
            record.manifest.venue.as_ref() == Some(expected),
            ErrorCode::ResourceReferenceShape
        );
    }
    Ok(())
}

fn require_adapter_graph(
    record: &ResourceRecord,
    venue: &ManifestRef,
    market: &ManifestRef,
    admission: &CashCarryAdmission,
) -> Result<()> {
    require!(
        record.manifest.venue.as_ref() == Some(venue)
            && record.manifest.market.as_ref() == Some(market)
            && record.manifest.base_asset.as_ref() == Some(&admission.base_asset)
            && record.manifest.quote_asset.as_ref() == Some(&admission.quote_asset)
            && record.manifest.allowed_template.as_ref() == Some(&admission.template)
            && record.manifest.settlement.as_ref() == Some(&admission.settlement),
        ErrorCode::ResourceReferenceShape
    );
    let descriptor = record
        .manifest
        .adapter_class
        .as_ref()
        .ok_or_else(|| error!(ErrorCode::ResourceDescriptorUnsupported))?;
    validate_adapter_descriptor(record.manifest.role, descriptor)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn activation_slot_overflow_fails_closed() {
        assert!(checked_activation_slot(u64::MAX, 1).is_err());
        assert_eq!(checked_activation_slot(u64::MAX - 1, 1).unwrap(), u64::MAX);
    }
}

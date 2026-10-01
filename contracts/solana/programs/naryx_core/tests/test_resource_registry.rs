use {
    anchor_lang::{
        prelude::Pubkey,
        solana_program::{
            bpf_loader_upgradeable::{get_program_data_address, UpgradeableLoaderState},
            instruction::Instruction,
            program_pack::Pack,
            system_instruction,
        },
        AccountDeserialize, AccountSerialize, InstructionData, Space, ToAccountMetas,
    },
    anchor_spl::token::{
        spl_token::{self, state::Mint},
        ID as TOKEN_PROGRAM_ID,
    },
    litesvm::{
        types::{FailedTransactionMetadata, TransactionMetadata},
        LiteSVM,
    },
    naryx_core::{
        constants::{
            ASSET_RESOURCE_SEED, MARKET_RESOURCE_SEED, PROTOCOL_CONFIG_SEED, RESOURCE_INDEX_SEED,
            RESOURCE_RECORD_SEED, VENUE_RESOURCE_SEED,
        },
        error::ErrorCode,
        instructions::{
            program_identity::{program_data_header_identity, PROGRAM_DATA_METADATA_LENGTH},
            validate_cash_carry_admission, CashCarryAdmission, CashCarryResources, GovernanceRoles,
            ProposeAssetArgs, ProposeMarketArgs, ProposeVenueArgs, ResourceAction,
        },
        state::{
            DescriptorRef, ExecutionRole, Lifecycle, ManifestRef, MarketUnits, ProtocolConfig,
            QuoteLimit, ResourceControl, ResourceIndex, ResourceKind, ResourceManifest,
            ResourceRecord, SettlementClass, SettlementRef, CASH_AND_CARRY_TEMPLATE_ID,
            PERP_ADAPTER_CLASS_ID, SPOT_ADAPTER_CLASS_ID,
        },
        wire::{DomainRef, ProtocolId, HASH_BYTE_LENGTH},
    },
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::{versioned::VersionedTransaction, InstructionError, TransactionError},
};

const DOMAIN_ID: &str = "solana:devnet:naryx-core-v1";
const DOMAIN_HASH: [u8; HASH_BYTE_LENGTH] = [0x11; HASH_BYTE_LENGTH];
const NEXT_DOMAIN_HASH: [u8; HASH_BYTE_LENGTH] = [0x22; HASH_BYTE_LENGTH];
const TEMPLATE_HASH: [u8; HASH_BYTE_LENGTH] = [0x31; HASH_BYTE_LENGTH];
const SETTLEMENT_HASH: [u8; HASH_BYTE_LENGTH] = [0x32; HASH_BYTE_LENGTH];
const CONFIG_DELAY_SLOTS: u64 = 8;

type TransactionResult = Result<TransactionMetadata, Box<FailedTransactionMetadata>>;

struct Env {
    svm: LiteSVM,
    payer: Keypair,
    initializer: Keypair,
    proposer: Keypair,
    canceller: Keypair,
    executor: Keypair,
    pauser: Keypair,
    outsider: Keypair,
    config: Pubkey,
    program_data: Pubkey,
    mint: Pubkey,
}

impl Env {
    fn roles(&self) -> GovernanceRoles {
        GovernanceRoles {
            proposer: self.proposer.pubkey(),
            canceller: self.canceller.pubkey(),
            executor: self.executor.pubkey(),
            pauser: self.pauser.pubkey(),
        }
    }
}

fn send(
    svm: &mut LiteSVM,
    payer: &Keypair,
    extra_signers: &[&Keypair],
    instructions: &[Instruction],
) -> TransactionResult {
    svm.expire_blockhash();
    let message =
        Message::new_with_blockhash(instructions, Some(&payer.pubkey()), &svm.latest_blockhash());
    let mut signers = vec![payer];
    signers.extend_from_slice(extra_signers);
    let transaction =
        VersionedTransaction::try_new(VersionedMessage::Legacy(message), &signers).unwrap();
    svm.send_transaction(transaction).map_err(Box::new)
}

fn core_ix<A: ToAccountMetas, D: InstructionData>(accounts: A, data: D) -> Instruction {
    Instruction::new_with_bytes(
        naryx_core::id(),
        &data.data(),
        accounts.to_account_metas(None),
    )
}

fn setup() -> Env {
    let mut svm = LiteSVM::new();
    svm.add_program(
        naryx_core::id(),
        include_bytes!("../../../target/deploy/naryx_core.so"),
    )
    .unwrap();

    let payer = Keypair::new();
    let initializer = Keypair::new();
    let proposer = Keypair::new();
    let canceller = Keypair::new();
    let executor = Keypair::new();
    let pauser = Keypair::new();
    let outsider = Keypair::new();
    for signer in [
        &payer,
        &initializer,
        &proposer,
        &canceller,
        &executor,
        &pauser,
        &outsider,
    ] {
        svm.airdrop(&signer.pubkey(), 2_000_000_000).unwrap();
    }

    let program_data = get_program_data_address(&naryx_core::id());
    let mut program_data_account = svm.get_account(&program_data).unwrap();
    program_data_account
        .serialize_data(&UpgradeableLoaderState::ProgramData {
            slot: 0,
            upgrade_authority_address: Some(initializer.pubkey()),
        })
        .unwrap();
    svm.set_account(program_data, program_data_account).unwrap();

    let (config, _) = Pubkey::find_program_address(&[PROTOCOL_CONFIG_SEED], &naryx_core::id());
    let mint = Keypair::new();
    let create_mint = system_instruction::create_account(
        &payer.pubkey(),
        &mint.pubkey(),
        svm.minimum_balance_for_rent_exemption(Mint::LEN),
        Mint::LEN as u64,
        &TOKEN_PROGRAM_ID,
    );
    let initialize_mint = spl_token::instruction::initialize_mint2(
        &TOKEN_PROGRAM_ID,
        &mint.pubkey(),
        &payer.pubkey(),
        None,
        6,
    )
    .unwrap();
    send(&mut svm, &payer, &[&mint], &[create_mint, initialize_mint]).unwrap();

    let mut env = Env {
        svm,
        payer,
        initializer,
        proposer,
        canceller,
        executor,
        pauser,
        outsider,
        config,
        program_data,
        mint: mint.pubkey(),
    };
    let ix = core_ix(
        naryx_core::accounts::Initialize {
            payer: env.payer.pubkey(),
            initializer: env.initializer.pubkey(),
            program: naryx_core::id(),
            program_data: env.program_data,
            config: env.config,
            system_program: anchor_lang::system_program::ID,
        },
        naryx_core::instruction::Initialize {
            environment: "devnet".to_string(),
            domain_id: DOMAIN_ID.to_string(),
            domain_manifest_version: 1,
            domain_manifest_hash: DOMAIN_HASH,
            config_delay_slots: CONFIG_DELAY_SLOTS,
            roles: env.roles(),
        },
    );
    send(&mut env.svm, &env.payer, &[&env.initializer], &[ix]).unwrap();
    env
}

fn manifest_ref(byte: u8, version: u32) -> ManifestRef {
    ManifestRef {
        subject_id: [byte; HASH_BYTE_LENGTH],
        manifest_version: version,
        manifest_hash: [byte.wrapping_add(0x40); HASH_BYTE_LENGTH],
    }
}

fn asset_addresses(identity: &ManifestRef) -> (Pubkey, Pubkey) {
    let index = Pubkey::find_program_address(
        &[
            RESOURCE_INDEX_SEED,
            ASSET_RESOURCE_SEED,
            identity.subject_id.as_ref(),
        ],
        &naryx_core::id(),
    )
    .0;
    let record = Pubkey::find_program_address(
        &[
            RESOURCE_RECORD_SEED,
            ASSET_RESOURCE_SEED,
            identity.subject_id.as_ref(),
            identity.manifest_version.to_be_bytes().as_ref(),
        ],
        &naryx_core::id(),
    )
    .0;
    (index, record)
}

fn propose_asset_ix(env: &Env, signer: Pubkey, identity: ManifestRef) -> Instruction {
    let (index, record) = asset_addresses(&identity);
    core_ix(
        naryx_core::accounts::ProposeAsset {
            payer: env.payer.pubkey(),
            proposer: signer,
            config: env.config,
            index,
            record,
            token_program: TOKEN_PROGRAM_ID,
            mint: env.mint,
            system_program: anchor_lang::system_program::ID,
        },
        naryx_core::instruction::ProposeAsset {
            args: ProposeAssetArgs {
                identity,
                decimals: 6,
                control: ResourceControl {
                    lifecycle: Lifecycle::Active,
                    quote_limit: None,
                },
            },
        },
    )
}

fn activate_initial_ix(env: &Env, identity: &ManifestRef, signer: Pubkey) -> Instruction {
    let (index, record) = asset_addresses(identity);
    core_ix(
        naryx_core::accounts::ActivateInitialResource {
            executor: signer,
            config: env.config,
            index,
            record,
        },
        naryx_core::instruction::ActivateInitialResource {},
    )
}

fn tighten_control_ix(
    env: &Env,
    identity: &ManifestRef,
    signer: Pubkey,
    lifecycle: Lifecycle,
) -> Instruction {
    let (index, record) = asset_addresses(identity);
    core_ix(
        naryx_core::accounts::TightenResourceControl {
            pauser: signer,
            config: env.config,
            index,
            record,
        },
        naryx_core::instruction::TightenResourceControl {
            control: ResourceControl {
                lifecycle,
                quote_limit: None,
            },
        },
    )
}

fn propose_control_ix(
    env: &Env,
    identity: &ManifestRef,
    signer: Pubkey,
    lifecycle: Lifecycle,
) -> Instruction {
    let (index, record) = asset_addresses(identity);
    core_ix(
        naryx_core::accounts::ProposeResourceControl {
            proposer: signer,
            config: env.config,
            index,
            record,
        },
        naryx_core::instruction::ProposeResourceControl {
            control: ResourceControl {
                lifecycle,
                quote_limit: None,
            },
        },
    )
}

fn activate_control_ix(env: &Env, identity: &ManifestRef, signer: Pubkey) -> Instruction {
    let (index, record) = asset_addresses(identity);
    core_ix(
        naryx_core::accounts::ActivateResourceControl {
            executor: signer,
            config: env.config,
            index,
            record,
        },
        naryx_core::instruction::ActivateResourceControl {},
    )
}

fn read_index(svm: &LiteSVM, address: Pubkey) -> ResourceIndex {
    let account = svm.get_account(&address).unwrap();
    ResourceIndex::try_deserialize(&mut account.data.as_slice()).unwrap()
}

fn read_record(svm: &LiteSVM, address: Pubkey) -> ResourceRecord {
    let account = svm.get_account(&address).unwrap();
    ResourceRecord::try_deserialize(&mut account.data.as_slice()).unwrap()
}

fn assert_custom_error(result: TransactionResult, expected: ErrorCode) {
    let failure = result.expect_err("transaction should fail");
    assert_eq!(
        failure.err,
        TransactionError::InstructionError(0, InstructionError::Custom(u32::from(expected)))
    );
}

#[test]
fn registration_is_role_gated_immutable_and_exactly_delayed() {
    let mut env = setup();
    env.svm.warp_to_slot(100);
    let identity = manifest_ref(1, 1);
    let (index, record) = asset_addresses(&identity);

    let ix = propose_asset_ix(&env, env.outsider.pubkey(), identity.clone());
    assert_custom_error(
        send(&mut env.svm, &env.payer, &[&env.outsider], &[ix]),
        ErrorCode::UnauthorizedRole,
    );

    let ix = propose_asset_ix(&env, env.proposer.pubkey(), identity.clone());
    send(&mut env.svm, &env.payer, &[&env.proposer], &[ix]).unwrap();
    let proposed = read_index(&env.svm, index);
    assert_eq!(proposed.activation_slot, Some(100 + CONFIG_DELAY_SLOTS));
    assert_eq!(proposed.pending_record, record);
    assert!(!read_record(&env.svm, record).active);

    let next = manifest_ref(1, 2);
    let ix = propose_asset_ix(&env, env.proposer.pubkey(), next);
    assert_custom_error(
        send(&mut env.svm, &env.payer, &[&env.proposer], &[ix]),
        ErrorCode::ResourceRegistrationExists,
    );

    env.svm.warp_to_slot(100 + CONFIG_DELAY_SLOTS - 1);
    let ix = activate_initial_ix(&env, &identity, env.executor.pubkey());
    assert_custom_error(
        send(&mut env.svm, &env.payer, &[&env.executor], &[ix]),
        ErrorCode::ResourceRegistrationNotReady,
    );

    env.svm.warp_to_slot(100 + CONFIG_DELAY_SLOTS);
    let ix = activate_initial_ix(&env, &identity, env.outsider.pubkey());
    assert_custom_error(
        send(&mut env.svm, &env.payer, &[&env.outsider], &[ix]),
        ErrorCode::UnauthorizedRole,
    );
    let ix = activate_initial_ix(&env, &identity, env.executor.pubkey());
    send(&mut env.svm, &env.payer, &[&env.executor], &[ix]).unwrap();
    assert!(read_record(&env.svm, record).active);

    let ix = propose_asset_ix(&env, env.proposer.pubkey(), identity);
    assert!(send(&mut env.svm, &env.payer, &[&env.proposer], &[ix]).is_err());
}

#[test]
fn immediate_control_only_tightens_and_reopening_is_delayed() {
    let mut env = setup();
    env.svm.warp_to_slot(200);
    let identity = manifest_ref(2, 1);
    let (_, record) = asset_addresses(&identity);
    let ix = propose_asset_ix(&env, env.proposer.pubkey(), identity.clone());
    send(&mut env.svm, &env.payer, &[&env.proposer], &[ix]).unwrap();
    env.svm.warp_to_slot(200 + CONFIG_DELAY_SLOTS);
    let ix = activate_initial_ix(&env, &identity, env.executor.pubkey());
    send(&mut env.svm, &env.payer, &[&env.executor], &[ix]).unwrap();

    let ix = tighten_control_ix(
        &env,
        &identity,
        env.outsider.pubkey(),
        Lifecycle::EntryPaused,
    );
    assert_custom_error(
        send(&mut env.svm, &env.payer, &[&env.outsider], &[ix]),
        ErrorCode::UnauthorizedRole,
    );
    let ix = tighten_control_ix(&env, &identity, env.pauser.pubkey(), Lifecycle::EntryPaused);
    send(&mut env.svm, &env.payer, &[&env.pauser], &[ix]).unwrap();
    assert_eq!(
        read_record(&env.svm, record).control.lifecycle,
        Lifecycle::EntryPaused
    );

    let ix = tighten_control_ix(&env, &identity, env.pauser.pubkey(), Lifecycle::Active);
    assert_custom_error(
        send(&mut env.svm, &env.payer, &[&env.pauser], &[ix]),
        ErrorCode::ResourceUnsafeImmediateControl,
    );

    env.svm.warp_to_slot(300);
    let ix = propose_control_ix(&env, &identity, env.proposer.pubkey(), Lifecycle::Active);
    send(&mut env.svm, &env.payer, &[&env.proposer], &[ix]).unwrap();
    env.svm.warp_to_slot(300 + CONFIG_DELAY_SLOTS - 1);
    let ix = activate_control_ix(&env, &identity, env.executor.pubkey());
    assert_custom_error(
        send(&mut env.svm, &env.payer, &[&env.executor], &[ix]),
        ErrorCode::ResourceControlProposalNotReady,
    );
    env.svm.warp_to_slot(300 + CONFIG_DELAY_SLOTS);
    let ix = activate_control_ix(&env, &identity, env.executor.pubkey());
    send(&mut env.svm, &env.payer, &[&env.executor], &[ix]).unwrap();
    assert_eq!(
        read_record(&env.svm, record).control.lifecycle,
        Lifecycle::Active
    );
}

fn domain(version: u32, hash: [u8; HASH_BYTE_LENGTH]) -> DomainRef {
    DomainRef::new(DOMAIN_ID, version, hash).unwrap()
}

fn descriptor(id: &str, hash: [u8; HASH_BYTE_LENGTH]) -> DescriptorRef {
    DescriptorRef::new(id, 1, hash).unwrap()
}

fn quote_control(
    quote: &ManifestRef,
    decimals: u8,
    max: u64,
    lifecycle: Lifecycle,
) -> ResourceControl {
    ResourceControl {
        lifecycle,
        quote_limit: Some(QuoteLimit {
            quote_asset: quote.clone(),
            quote_decimals: decimals,
            maximum_notional_atoms: max,
        }),
    }
}

fn resource_record(
    kind: ResourceKind,
    role: ExecutionRole,
    identity: ManifestRef,
    domain_ref: DomainRef,
    venue: Option<ManifestRef>,
    market: Option<ManifestRef>,
    base: Option<ManifestRef>,
    quote: Option<ManifestRef>,
    decimals: u8,
    control: ResourceControl,
) -> ResourceRecord {
    let adapter = if kind == ResourceKind::Adapter {
        Some(descriptor(
            if role == ExecutionRole::Spot {
                SPOT_ADAPTER_CLASS_ID
            } else {
                PERP_ADAPTER_CLASS_ID
            },
            [identity.subject_id[0].wrapping_add(7); HASH_BYTE_LENGTH],
        ))
    } else {
        None
    };
    let market_units = if kind == ResourceKind::Market {
        Some(MarketUnits {
            base_decimals: 9,
            quote_decimals: 6,
            base_lot_atoms: 1_000,
            quote_tick_atoms_per_base_lot: 10,
            minimum_quote_notional_atoms: 1_000_000,
            multiplier_numerator: 1,
            multiplier_denominator: 1,
        })
    } else {
        None
    };
    ResourceRecord {
        manifest: ResourceManifest {
            kind,
            domain: domain_ref,
            identity,
            subject_address: Pubkey::new_unique(),
            program_id: TOKEN_PROGRAM_ID,
            program_data: Pubkey::new_unique(),
            code_identity: [0x81; HASH_BYTE_LENGTH],
            decimals,
            quote_decimals: if kind == ResourceKind::Asset { 0 } else { 6 },
            role,
            adapter_class: adapter,
            venue,
            market,
            base_asset: base,
            quote_asset: quote,
            allowed_template: (kind == ResourceKind::Adapter)
                .then(|| descriptor(CASH_AND_CARRY_TEMPLATE_ID, TEMPLATE_HASH)),
            settlement: (kind == ResourceKind::Adapter).then_some(SettlementRef {
                class: SettlementClass::AtomicPostcondition,
                version: 1,
                manifest_hash: SETTLEMENT_HASH,
            }),
            market_units,
        },
        control,
        pending_control: None,
        active: true,
        bump: 1,
    }
}

struct Fixture {
    config: ProtocolConfig,
    admission: CashCarryAdmission,
    spot_adapter: ResourceRecord,
    perp_adapter: ResourceRecord,
    spot_market: ResourceRecord,
    perp_market: ResourceRecord,
    spot_venue: ResourceRecord,
    perp_venue: ResourceRecord,
    base_asset: ResourceRecord,
    quote_asset: ResourceRecord,
}

impl Fixture {
    fn resources(&self) -> CashCarryResources<'_> {
        CashCarryResources {
            spot_adapter: &self.spot_adapter,
            perp_adapter: &self.perp_adapter,
            spot_market: &self.spot_market,
            perp_market: &self.perp_market,
            spot_venue: &self.spot_venue,
            perp_venue: &self.perp_venue,
            base_asset: &self.base_asset,
            quote_asset: &self.quote_asset,
        }
    }
}

fn fixture() -> Fixture {
    let domain_ref = domain(1, DOMAIN_HASH);
    let base = manifest_ref(10, 1);
    let quote = manifest_ref(11, 1);
    let spot_venue = manifest_ref(12, 1);
    let perp_venue = manifest_ref(13, 1);
    let spot_market = manifest_ref(14, 1);
    let perp_market = manifest_ref(15, 1);
    let spot_adapter = manifest_ref(16, 1);
    let perp_adapter = manifest_ref(17, 1);
    let limit = |max| quote_control(&quote, 6, max, Lifecycle::Active);
    let asset_control = ResourceControl {
        lifecycle: Lifecycle::Active,
        quote_limit: None,
    };
    Fixture {
        config: ProtocolConfig {
            config_version: 2,
            environment: ProtocolId::new("devnet").unwrap(),
            domain: domain_ref.clone(),
            pending_domain: None,
            proposer: Pubkey::new_unique(),
            canceller: Pubkey::new_unique(),
            executor: Pubkey::new_unique(),
            pauser: Pubkey::new_unique(),
            config_delay_slots: 8,
            entry_paused: false,
            pending_unpause_slot: None,
            bump: 1,
        },
        admission: CashCarryAdmission {
            domain: domain_ref.clone(),
            spot_adapter: spot_adapter.clone(),
            perp_adapter: perp_adapter.clone(),
            spot_market: spot_market.clone(),
            perp_market: perp_market.clone(),
            spot_venue: spot_venue.clone(),
            perp_venue: perp_venue.clone(),
            base_asset: base.clone(),
            quote_asset: quote.clone(),
            quote_decimals: 6,
            template: descriptor(CASH_AND_CARRY_TEMPLATE_ID, TEMPLATE_HASH),
            settlement: SettlementRef {
                class: SettlementClass::AtomicPostcondition,
                version: 1,
                manifest_hash: SETTLEMENT_HASH,
            },
            action: ResourceAction::Entry,
            spot_quantity_atoms: 5_000,
            perp_quantity_atoms: 5_000,
            spot_limit_quote_atoms_per_base_lot: 1_000_000,
            perp_limit_quote_atoms_per_base_lot: 1_000_000,
            package_notional_atoms: 5_000_000,
        },
        spot_adapter: resource_record(
            ResourceKind::Adapter,
            ExecutionRole::Spot,
            spot_adapter,
            domain_ref.clone(),
            Some(spot_venue.clone()),
            Some(spot_market.clone()),
            Some(base.clone()),
            Some(quote.clone()),
            0,
            limit(9_000_000),
        ),
        perp_adapter: resource_record(
            ResourceKind::Adapter,
            ExecutionRole::Perp,
            perp_adapter,
            domain_ref.clone(),
            Some(perp_venue.clone()),
            Some(perp_market.clone()),
            Some(base.clone()),
            Some(quote.clone()),
            0,
            limit(8_000_000),
        ),
        spot_market: resource_record(
            ResourceKind::Market,
            ExecutionRole::Spot,
            spot_market,
            domain_ref.clone(),
            Some(spot_venue.clone()),
            None,
            Some(base.clone()),
            Some(quote.clone()),
            0,
            limit(7_000_000),
        ),
        perp_market: resource_record(
            ResourceKind::Market,
            ExecutionRole::Perp,
            perp_market,
            domain_ref.clone(),
            Some(perp_venue.clone()),
            None,
            Some(base.clone()),
            Some(quote.clone()),
            0,
            limit(6_000_000),
        ),
        spot_venue: resource_record(
            ResourceKind::Venue,
            ExecutionRole::Spot,
            spot_venue,
            domain_ref.clone(),
            None,
            None,
            Some(base.clone()),
            Some(quote.clone()),
            0,
            limit(5_500_000),
        ),
        perp_venue: resource_record(
            ResourceKind::Venue,
            ExecutionRole::Perp,
            perp_venue,
            domain_ref.clone(),
            None,
            None,
            Some(base.clone()),
            Some(quote.clone()),
            0,
            limit(5_250_000),
        ),
        base_asset: resource_record(
            ResourceKind::Asset,
            ExecutionRole::None,
            base,
            domain_ref.clone(),
            None,
            None,
            None,
            None,
            9,
            asset_control.clone(),
        ),
        quote_asset: resource_record(
            ResourceKind::Asset,
            ExecutionRole::None,
            quote,
            domain_ref,
            None,
            None,
            None,
            None,
            6,
            asset_control,
        ),
    }
}

#[test]
fn cash_carry_admission_binds_graph_classes_and_quote_atom_limits() {
    let mut fixture = fixture();
    assert_eq!(
        validate_cash_carry_admission(&fixture.config, &fixture.admission, &fixture.resources())
            .unwrap(),
        5_250_000
    );

    fixture.spot_adapter.manifest.market = Some(fixture.admission.perp_market.clone());
    assert!(validate_cash_carry_admission(
        &fixture.config,
        &fixture.admission,
        &fixture.resources()
    )
    .is_err());
    fixture.spot_adapter.manifest.market = Some(fixture.admission.spot_market.clone());

    fixture
        .perp_market
        .control
        .quote_limit
        .as_mut()
        .unwrap()
        .quote_asset = manifest_ref(99, 1);
    assert!(validate_cash_carry_admission(
        &fixture.config,
        &fixture.admission,
        &fixture.resources()
    )
    .is_err());
    fixture
        .perp_market
        .control
        .quote_limit
        .as_mut()
        .unwrap()
        .quote_asset = fixture.admission.quote_asset.clone();

    fixture.admission.spot_quantity_atoms += 1;
    assert!(validate_cash_carry_admission(
        &fixture.config,
        &fixture.admission,
        &fixture.resources()
    )
    .is_err());
    fixture.admission.spot_quantity_atoms -= 1;

    fixture.admission.spot_limit_quote_atoms_per_base_lot += 1;
    assert!(validate_cash_carry_admission(
        &fixture.config,
        &fixture.admission,
        &fixture.resources()
    )
    .is_err());
    fixture.admission.spot_limit_quote_atoms_per_base_lot -= 1;

    fixture
        .spot_market
        .manifest
        .market_units
        .as_mut()
        .unwrap()
        .minimum_quote_notional_atoms = fixture.admission.package_notional_atoms + 1;
    assert!(validate_cash_carry_admission(
        &fixture.config,
        &fixture.admission,
        &fixture.resources()
    )
    .is_err());
    fixture
        .spot_market
        .manifest
        .market_units
        .as_mut()
        .unwrap()
        .minimum_quote_notional_atoms = 1_000_000;

    fixture
        .perp_market
        .manifest
        .market_units
        .as_mut()
        .unwrap()
        .multiplier_numerator = 2;
    assert!(validate_cash_carry_admission(
        &fixture.config,
        &fixture.admission,
        &fixture.resources()
    )
    .is_err());
    fixture
        .perp_market
        .manifest
        .market_units
        .as_mut()
        .unwrap()
        .multiplier_numerator = 1;

    fixture.admission.package_notional_atoms -= 1;
    assert!(validate_cash_carry_admission(
        &fixture.config,
        &fixture.admission,
        &fixture.resources()
    )
    .is_err());
    fixture.admission.package_notional_atoms += 1;

    fixture
        .spot_market
        .manifest
        .market_units
        .as_mut()
        .unwrap()
        .base_lot_atoms = 1;
    fixture.admission.spot_quantity_atoms = u64::MAX;
    fixture.admission.spot_limit_quote_atoms_per_base_lot = u64::MAX - 5;
    assert!(validate_cash_carry_admission(
        &fixture.config,
        &fixture.admission,
        &fixture.resources()
    )
    .is_err());
}

#[test]
fn lifecycle_preserves_exit_and_domain_changes_invalidate_every_record() {
    let mut fixture = fixture();
    fixture.spot_venue.control.lifecycle = Lifecycle::EntryPaused;
    assert!(validate_cash_carry_admission(
        &fixture.config,
        &fixture.admission,
        &fixture.resources()
    )
    .is_err());
    fixture.admission.action = ResourceAction::Exit;
    assert!(validate_cash_carry_admission(
        &fixture.config,
        &fixture.admission,
        &fixture.resources()
    )
    .is_ok());
    fixture.spot_venue.control.lifecycle = Lifecycle::AllPaused;
    assert!(validate_cash_carry_admission(
        &fixture.config,
        &fixture.admission,
        &fixture.resources()
    )
    .is_err());

    fixture.config.domain = domain(2, NEXT_DOMAIN_HASH);
    fixture.admission.domain = fixture.config.domain.clone();
    assert!(validate_cash_carry_admission(
        &fixture.config,
        &fixture.admission,
        &fixture.resources()
    )
    .is_err());
}

#[test]
fn control_and_market_unit_validation_rejects_unsafe_or_malformed_values() {
    let fixture = fixture();
    let current = fixture.spot_market.control.clone();
    let mut tighter = current.clone();
    tighter.lifecycle = Lifecycle::EntryPaused;
    tighter.quote_limit.as_mut().unwrap().maximum_notional_atoms -= 1;
    assert!(tighter.is_immediate_tightening_of(&current));

    let mut looser = current.clone();
    looser.quote_limit.as_mut().unwrap().maximum_notional_atoms += 1;
    assert!(!looser.is_immediate_tightening_of(&current));
    let mut cross_asset = tighter.clone();
    cross_asset.quote_limit.as_mut().unwrap().quote_asset = manifest_ref(90, 1);
    assert!(!cross_asset.is_immediate_tightening_of(&current));

    let zero = MarketUnits {
        base_decimals: 9,
        quote_decimals: 6,
        base_lot_atoms: 0,
        quote_tick_atoms_per_base_lot: 1,
        minimum_quote_notional_atoms: 1,
        multiplier_numerator: 1,
        multiplier_denominator: 1,
    };
    assert!(zero.validate(9, 6).is_err());
    let unreduced = MarketUnits {
        base_lot_atoms: 1,
        multiplier_numerator: 2,
        multiplier_denominator: 4,
        ..zero
    };
    assert!(unreduced.validate(9, 6).is_err());

    let mut zero_limit = current;
    zero_limit
        .quote_limit
        .as_mut()
        .unwrap()
        .maximum_notional_atoms = 0;
    assert!(zero_limit
        .validate_for(&fixture.spot_market.manifest)
        .is_err());
}

fn resource_addresses(seed: &[u8], identity: &ManifestRef) -> (Pubkey, Pubkey) {
    let index = Pubkey::find_program_address(
        &[RESOURCE_INDEX_SEED, seed, identity.subject_id.as_ref()],
        &naryx_core::id(),
    )
    .0;
    let record = Pubkey::find_program_address(
        &[
            RESOURCE_RECORD_SEED,
            seed,
            identity.subject_id.as_ref(),
            identity.manifest_version.to_be_bytes().as_ref(),
        ],
        &naryx_core::id(),
    )
    .0;
    (index, record)
}

fn write_record(env: &mut Env, address: Pubkey, record: &ResourceRecord) {
    let mut account = env.svm.get_account(&env.config).unwrap();
    account.data.clear();
    record.try_serialize(&mut account.data).unwrap();
    account.data.resize(8 + ResourceRecord::INIT_SPACE, 0);
    env.svm.set_account(address, account).unwrap();
}

fn write_program_data_header(env: &mut Env, address: Pubkey, slot: u64, authority: Pubkey) {
    let mut account = env.svm.get_account(&address).unwrap();
    account.data[4..12].copy_from_slice(&slot.to_le_bytes());
    account.data[12] = 1;
    account.data[13..PROGRAM_DATA_METADATA_LENGTH].copy_from_slice(authority.as_ref());
    env.svm.set_account(address, account).unwrap();
}

fn compute_limit_ix(units: u32) -> Instruction {
    let mut data = vec![2];
    data.extend_from_slice(&units.to_le_bytes());
    Instruction::new_with_bytes(
        Pubkey::from_str_const("ComputeBudget111111111111111111111111111111"),
        &data,
        vec![],
    )
}

#[test]
fn venue_code_identity_is_constant_cost_and_binds_program_data_header() {
    const PROGRAM_DATA_LENGTH: usize = 2 * 1024 * 1024 + 4096;
    let mut env = setup();
    let venue_program = Pubkey::new_unique();
    env.svm
        .add_program(
            venue_program,
            include_bytes!("../../../target/deploy/naryx_conformance_venue.so"),
        )
        .unwrap();
    let venue_program_data = get_program_data_address(&venue_program);
    let upgrade_authority = Pubkey::new_unique();
    let mut program_data = env.svm.get_account(&venue_program_data).unwrap();
    program_data.data.resize(PROGRAM_DATA_LENGTH, 0);
    env.svm
        .set_account(venue_program_data, program_data)
        .unwrap();
    write_program_data_header(&mut env, venue_program_data, 4_242, upgrade_authority);

    let mut owned = env.svm.get_account(&env.config).unwrap();
    owned.owner = venue_program;
    let venue_account = Pubkey::new_unique();
    let market_account = Pubkey::new_unique();
    env.svm.set_account(venue_account, owned.clone()).unwrap();
    env.svm.set_account(market_account, owned).unwrap();

    let base = manifest_ref(61, 1);
    let quote = manifest_ref(62, 1);
    let (base_record, quote_record) = (Pubkey::new_unique(), Pubkey::new_unique());
    for (address, identity, decimals) in [(base_record, &base, 9), (quote_record, &quote, 6)] {
        let record = resource_record(
            ResourceKind::Asset,
            ExecutionRole::None,
            identity.clone(),
            domain(1, DOMAIN_HASH),
            None,
            None,
            None,
            None,
            decimals,
            ResourceControl {
                lifecycle: Lifecycle::Active,
                quote_limit: None,
            },
        );
        write_record(&mut env, address, &record);
    }

    let venue = manifest_ref(63, 1);
    let (venue_index, venue_record) = resource_addresses(VENUE_RESOURCE_SEED, &venue);
    let propose_venue = core_ix(
        naryx_core::accounts::ProposeVenue {
            payer: env.payer.pubkey(),
            proposer: env.proposer.pubkey(),
            config: env.config,
            index: venue_index,
            record: venue_record,
            base_asset: base_record,
            quote_asset: quote_record,
            venue_program,
            venue_program_data,
            venue_account,
            system_program: anchor_lang::system_program::ID,
        },
        naryx_core::instruction::ProposeVenue {
            args: ProposeVenueArgs {
                identity: venue.clone(),
                role: ExecutionRole::Spot,
                base_asset: base.clone(),
                quote_asset: quote.clone(),
                control: quote_control(&quote, 6, 1_000_000_000, Lifecycle::Active),
            },
        },
    );
    let payer = env.payer.insecure_clone();
    let proposer = env.proposer.insecure_clone();
    let meta = send(
        &mut env.svm,
        &payer,
        &[&proposer],
        &[compute_limit_ix(1_400_000), propose_venue],
    )
    .unwrap();
    println!(
        "ProposeVenue with {PROGRAM_DATA_LENGTH}-byte ProgramData consumed {} CU",
        meta.compute_units_consumed
    );
    let live = env.svm.get_account(&venue_program_data).unwrap();
    let identity = program_data_header_identity(&live.data).unwrap();
    let mut recorded = read_record(&env.svm, venue_record);
    assert_eq!(recorded.manifest.code_identity, identity);
    assert!(meta.compute_units_consumed < 100_000);

    recorded.active = true;
    recorded.control = quote_control(&quote, 6, 1_000_000_000, Lifecycle::Active);
    recorded.pending_control = None;
    write_record(&mut env, venue_record, &recorded);

    let market = manifest_ref(64, 1);
    let (market_index, market_record) = resource_addresses(MARKET_RESOURCE_SEED, &market);
    let propose_market = core_ix(
        naryx_core::accounts::ProposeMarket {
            payer: env.payer.pubkey(),
            proposer: env.proposer.pubkey(),
            config: env.config,
            index: market_index,
            record: market_record,
            venue: venue_record,
            base_asset: base_record,
            quote_asset: quote_record,
            venue_program,
            venue_program_data,
            market_account,
            system_program: anchor_lang::system_program::ID,
        },
        naryx_core::instruction::ProposeMarket {
            args: ProposeMarketArgs {
                identity: market,
                role: ExecutionRole::Spot,
                venue,
                base_asset: base,
                quote_asset: quote.clone(),
                units: MarketUnits {
                    base_decimals: 9,
                    quote_decimals: 6,
                    base_lot_atoms: 1_000,
                    quote_tick_atoms_per_base_lot: 10,
                    minimum_quote_notional_atoms: 1_000_000,
                    multiplier_numerator: 1,
                    multiplier_denominator: 1,
                },
                control: quote_control(&quote, 6, 1_000_000_000, Lifecycle::Active),
            },
        },
    );

    write_program_data_header(&mut env, venue_program_data, 4_243, upgrade_authority);
    assert_custom_error(
        send(&mut env.svm, &payer, &[&proposer], &[propose_market.clone()]),
        ErrorCode::ResourceCodeIdentityMismatch,
    );
    write_program_data_header(&mut env, venue_program_data, 4_242, Pubkey::new_unique());
    assert_custom_error(
        send(&mut env.svm, &payer, &[&proposer], &[propose_market.clone()]),
        ErrorCode::ResourceCodeIdentityMismatch,
    );
    write_program_data_header(&mut env, venue_program_data, 4_242, upgrade_authority);
    send(&mut env.svm, &payer, &[&proposer], &[propose_market]).unwrap();
    assert_eq!(
        read_record(&env.svm, market_record).manifest.code_identity,
        identity
    );
}

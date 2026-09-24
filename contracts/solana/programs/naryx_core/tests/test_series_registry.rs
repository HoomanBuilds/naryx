use {
    anchor_lang::{
        prelude::Pubkey,
        solana_program::{
            bpf_loader_upgradeable::{get_program_data_address, UpgradeableLoaderState},
            instruction::Instruction,
            program_pack::Pack,
            system_instruction,
        },
        AccountDeserialize, InstructionData, ToAccountMetas,
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
            ASSET_RESOURCE_SEED, CASH_CARRY_SERIES_INDEX_SEED, CASH_CARRY_SERIES_RECORD_SEED,
            PROTOCOL_CONFIG_SEED, RESOURCE_INDEX_SEED, RESOURCE_RECORD_SEED,
        },
        error::ErrorCode,
        instructions::{GovernanceRoles, ProposeAssetArgs, ProposeCashCarrySeriesBindingArgs},
        state::{
            domain_ref_identity_hash, recognized_quote_convention_identity_hash,
            recognized_settlement_class_identity_hash, recognized_template_identity_hash,
            CashCarrySeriesBindingIndex, CashCarrySeriesBindingRecord, CashCarrySeriesBindingV1,
            Lifecycle, ManifestRef, ProtocolConfig, ResourceControl,
            CASH_CARRY_SERIES_BINDING_SCHEMA_VERSION, CASH_CARRY_SERIES_ENTRY_SIDE_ASK,
            CASH_CARRY_SERIES_TEMPLATE_VERSION,
        },
        wire::{DomainRef, HASH_BYTE_LENGTH},
    },
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::{versioned::VersionedTransaction, InstructionError, TransactionError},
};

const DOMAIN_ID: &str = "solana:devnet:naryx-core-v1";
const DOMAIN_HASH: [u8; HASH_BYTE_LENGTH] = [0x11; HASH_BYTE_LENGTH];
const CONFIG_DELAY_SLOTS: u64 = 8;

type TransactionResult = Result<TransactionMetadata, Box<FailedTransactionMetadata>>;

struct Env {
    svm: LiteSVM,
    payer: Keypair,
    proposer: Keypair,
    canceller: Keypair,
    executor: Keypair,
    pauser: Keypair,
    config: Pubkey,
    base_mint: Pubkey,
    quote_mint: Pubkey,
    base: ManifestRef,
    quote: ManifestRef,
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

fn manifest_ref(byte: u8, version: u32) -> ManifestRef {
    ManifestRef {
        subject_id: [byte; HASH_BYTE_LENGTH],
        manifest_version: version,
        manifest_hash: [byte.wrapping_add(0x40); HASH_BYTE_LENGTH],
    }
}

fn create_mint(svm: &mut LiteSVM, payer: &Keypair, decimals: u8) -> Pubkey {
    let mint = Keypair::new();
    let create = system_instruction::create_account(
        &payer.pubkey(),
        &mint.pubkey(),
        svm.minimum_balance_for_rent_exemption(Mint::LEN),
        Mint::LEN as u64,
        &TOKEN_PROGRAM_ID,
    );
    let initialize = spl_token::instruction::initialize_mint2(
        &TOKEN_PROGRAM_ID,
        &mint.pubkey(),
        &payer.pubkey(),
        None,
        decimals,
    )
    .unwrap();
    send(svm, payer, &[&mint], &[create, initialize]).unwrap();
    mint.pubkey()
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
    for signer in [
        &payer,
        &initializer,
        &proposer,
        &canceller,
        &executor,
        &pauser,
    ] {
        svm.airdrop(&signer.pubkey(), 3_000_000_000).unwrap();
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
    let base_mint = create_mint(&mut svm, &payer, 9);
    let quote_mint = create_mint(&mut svm, &payer, 6);
    let mut env = Env {
        svm,
        payer,
        proposer,
        canceller,
        executor,
        pauser,
        config,
        base_mint,
        quote_mint,
        base: manifest_ref(0x21, 1),
        quote: manifest_ref(0x22, 1),
    };
    let ix = core_ix(
        naryx_core::accounts::Initialize {
            payer: env.payer.pubkey(),
            initializer: initializer.pubkey(),
            program: naryx_core::id(),
            program_data,
            config,
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
    send(&mut env.svm, &env.payer, &[&initializer], &[ix]).unwrap();
    env.svm.warp_to_slot(20);
    let base = env.base.clone();
    let quote = env.quote.clone();
    let base_mint = env.base_mint;
    let quote_mint = env.quote_mint;
    register_asset(&mut env, base, base_mint, 9);
    register_asset(&mut env, quote, quote_mint, 6);
    env
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

fn register_asset(env: &mut Env, identity: ManifestRef, mint: Pubkey, decimals: u8) {
    let (index, record) = asset_addresses(&identity);
    let propose = core_ix(
        naryx_core::accounts::ProposeAsset {
            payer: env.payer.pubkey(),
            proposer: env.proposer.pubkey(),
            config: env.config,
            index,
            record,
            token_program: TOKEN_PROGRAM_ID,
            mint,
            system_program: anchor_lang::system_program::ID,
        },
        naryx_core::instruction::ProposeAsset {
            args: ProposeAssetArgs {
                identity: identity.clone(),
                decimals,
                control: ResourceControl {
                    lifecycle: Lifecycle::Active,
                    quote_limit: None,
                },
            },
        },
    );
    send(&mut env.svm, &env.payer, &[&env.proposer], &[propose]).unwrap();
    let proposed = read_config(&env.svm, env.config);
    env.svm.warp_to_slot(
        env.svm.get_sysvar::<anchor_lang::prelude::Clock>().slot + proposed.config_delay_slots,
    );
    let activate = core_ix(
        naryx_core::accounts::ActivateInitialResource {
            executor: env.executor.pubkey(),
            config: env.config,
            index,
            record,
        },
        naryx_core::instruction::ActivateInitialResource {},
    );
    send(&mut env.svm, &env.payer, &[&env.executor], &[activate]).unwrap();
}

fn register_asset_version(
    env: &mut Env,
    previous: &ManifestRef,
    identity: ManifestRef,
    mint: Pubkey,
    decimals: u8,
) {
    let (index, record) = asset_addresses(&identity);
    let previous_record = asset_addresses(previous).1;
    let propose = core_ix(
        naryx_core::accounts::ProposeAsset {
            payer: env.payer.pubkey(),
            proposer: env.proposer.pubkey(),
            config: env.config,
            index,
            record,
            token_program: TOKEN_PROGRAM_ID,
            mint,
            system_program: anchor_lang::system_program::ID,
        },
        naryx_core::instruction::ProposeAsset {
            args: ProposeAssetArgs {
                identity: identity.clone(),
                decimals,
                control: ResourceControl {
                    lifecycle: Lifecycle::Active,
                    quote_limit: None,
                },
            },
        },
    );
    send(&mut env.svm, &env.payer, &[&env.proposer], &[propose]).unwrap();
    let current_slot = env.svm.get_sysvar::<anchor_lang::prelude::Clock>().slot;
    env.svm.warp_to_slot(current_slot + CONFIG_DELAY_SLOTS);
    let activate = core_ix(
        naryx_core::accounts::ActivateResourceVersion {
            executor: env.executor.pubkey(),
            config: env.config,
            index,
            previous_record,
            record,
        },
        naryx_core::instruction::ActivateResourceVersion {},
    );
    send(&mut env.svm, &env.payer, &[&env.executor], &[activate]).unwrap();
}

fn domain() -> DomainRef {
    DomainRef::new(DOMAIN_ID, 1, DOMAIN_HASH).unwrap()
}

fn binding(base: ManifestRef, quote: ManifestRef, version: u32) -> CashCarrySeriesBindingV1 {
    CashCarrySeriesBindingV1 {
        schema_version: CASH_CARRY_SERIES_BINDING_SCHEMA_VERSION,
        binding_version: version,
        domain_ref_identity_hash: domain_ref_identity_hash(&domain()),
        series_manifest_hash: [0x31; HASH_BYTE_LENGTH],
        execution_class_manifest_hash: [0x32; HASH_BYTE_LENGTH],
        template_identity_hash: recognized_template_identity_hash().unwrap(),
        template_version: CASH_CARRY_SERIES_TEMPLATE_VERSION,
        template_manifest_hash: [0x33; HASH_BYTE_LENGTH],
        settlement_class_identity_hash: recognized_settlement_class_identity_hash(),
        base_asset: base,
        quote_asset: quote,
        quote_convention_identity_hash: recognized_quote_convention_identity_hash().unwrap(),
        entry_side: CASH_CARRY_SERIES_ENTRY_SIDE_ASK,
        spot_base_atoms_per_package_unit: 1_000_000_000,
        perp_quantity_atoms_per_package_unit: 1_000_000,
    }
}

fn series_addresses(binding: &CashCarrySeriesBindingV1) -> (Pubkey, Pubkey) {
    let identity = binding.identity_key();
    let index = Pubkey::find_program_address(
        &[CASH_CARRY_SERIES_INDEX_SEED, identity.as_ref()],
        &naryx_core::id(),
    )
    .0;
    let record = Pubkey::find_program_address(
        &[
            CASH_CARRY_SERIES_RECORD_SEED,
            identity.as_ref(),
            binding.binding_version.to_be_bytes().as_ref(),
        ],
        &naryx_core::id(),
    )
    .0;
    (index, record)
}

fn initial_proposal_ix(
    env: &Env,
    binding: CashCarrySeriesBindingV1,
    expected_hash: [u8; 32],
) -> Instruction {
    let (index, record) = series_addresses(&binding);
    let (base_asset_index, base_asset) = asset_addresses(&binding.base_asset);
    let (quote_asset_index, quote_asset) = asset_addresses(&binding.quote_asset);
    core_ix(
        naryx_core::accounts::ProposeInitialCashCarrySeriesBinding {
            payer: env.payer.pubkey(),
            proposer: env.proposer.pubkey(),
            config: env.config,
            index,
            record,
            base_asset_index,
            base_asset,
            quote_asset_index,
            quote_asset,
            system_program: anchor_lang::system_program::ID,
        },
        naryx_core::instruction::ProposeInitialCashCarrySeriesBinding {
            args: ProposeCashCarrySeriesBindingArgs {
                expected_identity_key: binding.identity_key(),
                expected_binding_hash: expected_hash,
                binding,
                lifecycle: Lifecycle::Active,
            },
        },
    )
}

fn activate_initial_ix(env: &Env, binding: &CashCarrySeriesBindingV1) -> Instruction {
    let (index, record) = series_addresses(binding);
    let (base_asset_index, base_asset) = asset_addresses(&binding.base_asset);
    let (quote_asset_index, quote_asset) = asset_addresses(&binding.quote_asset);
    core_ix(
        naryx_core::accounts::ActivateInitialCashCarrySeriesBinding {
            executor: env.executor.pubkey(),
            config: env.config,
            index,
            record,
            base_asset_index,
            base_asset,
            quote_asset_index,
            quote_asset,
        },
        naryx_core::instruction::ActivateInitialCashCarrySeriesBinding {},
    )
}

fn version_proposal_ix(
    env: &Env,
    previous: &CashCarrySeriesBindingV1,
    binding: CashCarrySeriesBindingV1,
) -> Instruction {
    let (index, record) = series_addresses(&binding);
    let previous_record = series_addresses(previous).1;
    let (base_asset_index, base_asset) = asset_addresses(&binding.base_asset);
    let (quote_asset_index, quote_asset) = asset_addresses(&binding.quote_asset);
    core_ix(
        naryx_core::accounts::ProposeCashCarrySeriesBindingVersion {
            payer: env.payer.pubkey(),
            proposer: env.proposer.pubkey(),
            config: env.config,
            index,
            previous_record,
            record,
            base_asset_index,
            base_asset,
            quote_asset_index,
            quote_asset,
            system_program: anchor_lang::system_program::ID,
        },
        naryx_core::instruction::ProposeCashCarrySeriesBindingVersion {
            args: ProposeCashCarrySeriesBindingArgs {
                expected_identity_key: binding.identity_key(),
                expected_binding_hash: binding.binding_hash(),
                binding,
                lifecycle: Lifecycle::Active,
            },
        },
    )
}

fn control_accounts(
    binding: &CashCarrySeriesBindingV1,
) -> (Pubkey, Pubkey, Pubkey, Pubkey, Pubkey, Pubkey) {
    let (index, record) = series_addresses(binding);
    let (base_index, base) = asset_addresses(&binding.base_asset);
    let (quote_index, quote) = asset_addresses(&binding.quote_asset);
    (index, record, base_index, base, quote_index, quote)
}

fn activate_control_ix(env: &Env, binding: &CashCarrySeriesBindingV1) -> Instruction {
    let (index, record, base_asset_index, base_asset, quote_asset_index, quote_asset) =
        control_accounts(binding);
    core_ix(
        naryx_core::accounts::ActivateCashCarrySeriesBindingControl {
            executor: env.executor.pubkey(),
            config: env.config,
            index,
            record,
            base_asset_index,
            base_asset,
            quote_asset_index,
            quote_asset,
        },
        naryx_core::instruction::ActivateCashCarrySeriesBindingControl {},
    )
}

fn read_config(svm: &LiteSVM, address: Pubkey) -> ProtocolConfig {
    let account = svm.get_account(&address).unwrap();
    ProtocolConfig::try_deserialize(&mut account.data.as_slice()).unwrap()
}

fn read_index(svm: &LiteSVM, address: Pubkey) -> CashCarrySeriesBindingIndex {
    let account = svm.get_account(&address).unwrap();
    CashCarrySeriesBindingIndex::try_deserialize(&mut account.data.as_slice()).unwrap()
}

fn read_record(svm: &LiteSVM, address: Pubkey) -> CashCarrySeriesBindingRecord {
    let account = svm.get_account(&address).unwrap();
    CashCarrySeriesBindingRecord::try_deserialize(&mut account.data.as_slice()).unwrap()
}

fn assert_custom_error(result: TransactionResult, expected: ErrorCode) {
    let failure = result.expect_err("transaction should fail");
    assert_eq!(
        failure.err,
        TransactionError::InstructionError(0, InstructionError::Custom(u32::from(expected)))
    );
}

#[test]
fn registration_control_and_terminal_deprecation_are_delayed_or_tightening_only() {
    let mut env = setup();
    env.svm.warp_to_slot(100);
    let binding = binding(env.base.clone(), env.quote.clone(), 1);
    let (index, record) = series_addresses(&binding);

    let ix = initial_proposal_ix(&env, binding.clone(), [0x99; 32]);
    assert_custom_error(
        send(&mut env.svm, &env.payer, &[&env.proposer], &[ix]),
        ErrorCode::SeriesBindingHashMismatch,
    );
    let ix = initial_proposal_ix(&env, binding.clone(), binding.binding_hash());
    send(&mut env.svm, &env.payer, &[&env.proposer], &[ix]).unwrap();
    assert_eq!(read_index(&env.svm, index).activation_slot, Some(108));

    env.svm.warp_to_slot(107);
    let ix = activate_initial_ix(&env, &binding);
    assert_custom_error(
        send(&mut env.svm, &env.payer, &[&env.executor], &[ix]),
        ErrorCode::SeriesBindingRegistrationNotReady,
    );
    env.svm.warp_to_slot(108);
    let ix = activate_initial_ix(&env, &binding);
    send(&mut env.svm, &env.payer, &[&env.executor], &[ix]).unwrap();
    assert_eq!(read_record(&env.svm, record).lifecycle, Lifecycle::Active);

    let (index, record, _, _, _, _) = control_accounts(&binding);
    let pause = core_ix(
        naryx_core::accounts::TightenCashCarrySeriesBinding {
            pauser: env.pauser.pubkey(),
            config: env.config,
            index,
            record,
        },
        naryx_core::instruction::TightenCashCarrySeriesBinding {
            lifecycle: Lifecycle::EntryPaused,
        },
    );
    send(&mut env.svm, &env.payer, &[&env.pauser], &[pause]).unwrap();
    assert_eq!(
        read_record(&env.svm, record).lifecycle,
        Lifecycle::EntryPaused
    );

    env.svm.warp_to_slot(200);
    let propose_reactivate = core_ix(
        naryx_core::accounts::ProposeCashCarrySeriesBindingControl {
            proposer: env.proposer.pubkey(),
            config: env.config,
            index,
            record,
        },
        naryx_core::instruction::ProposeCashCarrySeriesBindingControl {
            lifecycle: Lifecycle::Active,
        },
    );
    send(
        &mut env.svm,
        &env.payer,
        &[&env.proposer],
        &[propose_reactivate],
    )
    .unwrap();
    env.svm.warp_to_slot(207);
    let activate_reactivate = activate_control_ix(&env, &binding);
    assert_custom_error(
        send(
            &mut env.svm,
            &env.payer,
            &[&env.executor],
            &[activate_reactivate],
        ),
        ErrorCode::SeriesBindingControlProposalNotReady,
    );
    env.svm.warp_to_slot(208);
    let activate_reactivate = activate_control_ix(&env, &binding);
    send(
        &mut env.svm,
        &env.payer,
        &[&env.executor],
        &[activate_reactivate],
    )
    .unwrap();

    let deprecate = core_ix(
        naryx_core::accounts::TightenCashCarrySeriesBinding {
            pauser: env.pauser.pubkey(),
            config: env.config,
            index,
            record,
        },
        naryx_core::instruction::TightenCashCarrySeriesBinding {
            lifecycle: Lifecycle::Deprecated,
        },
    );
    send(&mut env.svm, &env.payer, &[&env.pauser], &[deprecate]).unwrap();
    assert_eq!(
        read_record(&env.svm, record).lifecycle,
        Lifecycle::Deprecated
    );
}

#[test]
fn invalid_and_semantically_mutated_bindings_fail_closed() {
    let mut env = setup();
    env.svm.warp_to_slot(300);
    let valid = binding(env.base.clone(), env.quote.clone(), 1);

    let mut invalid = valid.clone();
    invalid.spot_base_atoms_per_package_unit = 0;
    let ix = initial_proposal_ix(&env, invalid.clone(), invalid.binding_hash());
    assert_custom_error(
        send(&mut env.svm, &env.payer, &[&env.proposer], &[ix]),
        ErrorCode::SeriesBindingUnitZero,
    );

    invalid = valid.clone();
    invalid.series_manifest_hash = [0u8; 32];
    let ix = initial_proposal_ix(&env, invalid.clone(), invalid.binding_hash());
    assert_custom_error(
        send(&mut env.svm, &env.payer, &[&env.proposer], &[ix]),
        ErrorCode::SeriesBindingHashZero,
    );

    invalid = valid.clone();
    invalid.base_asset = env.quote.clone();
    let ix = initial_proposal_ix(&env, invalid.clone(), invalid.binding_hash());
    assert_custom_error(
        send(&mut env.svm, &env.payer, &[&env.proposer], &[ix]),
        ErrorCode::SeriesBindingAssetMismatch,
    );

    let ix = initial_proposal_ix(&env, valid.clone(), valid.binding_hash());
    send(&mut env.svm, &env.payer, &[&env.proposer], &[ix]).unwrap();
    env.svm.warp_to_slot(308);
    let ix = activate_initial_ix(&env, &valid);
    send(&mut env.svm, &env.payer, &[&env.executor], &[ix]).unwrap();

    let mut mutated = valid.clone();
    mutated.binding_version = 2;
    mutated.perp_quantity_atoms_per_package_unit += 1;
    let ix = version_proposal_ix(&env, &valid, mutated);
    assert_custom_error(
        send(&mut env.svm, &env.payer, &[&env.proposer], &[ix]),
        ErrorCode::SeriesBindingSemanticMutation,
    );
}

#[test]
fn asset_manifest_rotation_allows_only_a_new_binding_version_and_is_cancellable() {
    let mut env = setup();
    env.svm.warp_to_slot(400);
    let initial = binding(env.base.clone(), env.quote.clone(), 1);
    let ix = initial_proposal_ix(&env, initial.clone(), initial.binding_hash());
    send(&mut env.svm, &env.payer, &[&env.proposer], &[ix]).unwrap();
    env.svm.warp_to_slot(408);
    let ix = activate_initial_ix(&env, &initial);
    send(&mut env.svm, &env.payer, &[&env.executor], &[ix]).unwrap();

    let previous_base = env.base.clone();
    let rotated_base = ManifestRef {
        subject_id: previous_base.subject_id,
        manifest_version: 2,
        manifest_hash: [0x91; HASH_BYTE_LENGTH],
    };
    let base_mint = env.base_mint;
    register_asset_version(&mut env, &previous_base, rotated_base.clone(), base_mint, 9);

    let mut stale = initial.clone();
    stale.binding_version = 2;
    let ix = version_proposal_ix(&env, &initial, stale);
    assert_custom_error(
        send(&mut env.svm, &env.payer, &[&env.proposer], &[ix]),
        ErrorCode::SeriesBindingAssetMismatch,
    );

    let mut cancellable = initial.clone();
    cancellable.binding_version = 2;
    cancellable.base_asset = rotated_base.clone();
    let ix = version_proposal_ix(&env, &initial, cancellable.clone());
    send(&mut env.svm, &env.payer, &[&env.proposer], &[ix]).unwrap();
    let (index, record) = series_addresses(&cancellable);
    let cancel = core_ix(
        naryx_core::accounts::CancelCashCarrySeriesBindingRegistration {
            canceller: env.canceller.pubkey(),
            config: env.config,
            index,
            record,
        },
        naryx_core::instruction::CancelCashCarrySeriesBindingRegistration {},
    );
    send(&mut env.svm, &env.payer, &[&env.canceller], &[cancel]).unwrap();
    assert_eq!(
        read_index(&env.svm, index).pending_record,
        Pubkey::default()
    );
}

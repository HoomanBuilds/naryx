use {
    anchor_lang::{
        error::ErrorCode as AnchorErrorCode,
        prelude::Pubkey,
        solana_program::{
            bpf_loader_upgradeable::{get_program_data_address, UpgradeableLoaderState},
            instruction::Instruction,
        },
        AccountDeserialize, InstructionData, Space, ToAccountMetas,
    },
    litesvm::{
        types::{FailedTransactionMetadata, TransactionMetadata},
        LiteSVM,
    },
    naryx_core::{
        constants::PROTOCOL_CONFIG_SEED,
        error::ErrorCode,
        instructions::GovernanceRoles,
        state::{PendingDomain, ProtocolConfig, PROTOCOL_CONFIG_VERSION},
        wire::{DomainRef, ProtocolId, HASH_BYTE_LENGTH},
    },
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::{versioned::VersionedTransaction, InstructionError, TransactionError},
};

const DOMAIN_ID: &str = "solana:devnet:naryx-core-v1";
const ENVIRONMENT: &str = "devnet";

const MANIFEST_HASH: [u8; HASH_BYTE_LENGTH] = [0x11; HASH_BYTE_LENGTH];
const NEXT_MANIFEST_HASH: [u8; HASH_BYTE_LENGTH] = [0x22; HASH_BYTE_LENGTH];
const OTHER_MANIFEST_HASH: [u8; HASH_BYTE_LENGTH] = [0x33; HASH_BYTE_LENGTH];

const CONFIG_DELAY_SLOTS: u64 = 16;

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
    bump: u8,
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
        svm.airdrop(&signer.pubkey(), 1_000_000_000).unwrap();
    }

    let program_data = get_program_data_address(&naryx_core::id());
    let mut program_data_account = svm
        .get_account(&program_data)
        .expect("program data account exists");
    program_data_account
        .serialize_data(&UpgradeableLoaderState::ProgramData {
            slot: 0,
            upgrade_authority_address: Some(initializer.pubkey()),
        })
        .unwrap();
    svm.set_account(program_data, program_data_account).unwrap();

    let (config, bump) = Pubkey::find_program_address(&[PROTOCOL_CONFIG_SEED], &naryx_core::id());

    Env {
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
        bump,
    }
}

fn send(
    svm: &mut LiteSVM,
    payer: &Keypair,
    extra: &[&Keypair],
    ix: Instruction,
) -> TransactionResult {
    svm.expire_blockhash();
    let message =
        Message::new_with_blockhash(&[ix], Some(&payer.pubkey()), &svm.latest_blockhash());
    let mut signers: Vec<&Keypair> = vec![payer];
    signers.extend_from_slice(extra);
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(message), &signers).unwrap();
    svm.send_transaction(tx).map_err(Box::new)
}

fn build_ix<A: ToAccountMetas, D: InstructionData>(accounts: A, data: D) -> Instruction {
    Instruction::new_with_bytes(
        naryx_core::id(),
        &data.data(),
        accounts.to_account_metas(None),
    )
}

fn initialize_ix(
    env: &Env,
    initializer: Pubkey,
    environment: &str,
    domain_id: &str,
    version: u32,
    hash: [u8; HASH_BYTE_LENGTH],
    delay: u64,
    roles: GovernanceRoles,
) -> Instruction {
    build_ix(
        naryx_core::accounts::Initialize {
            payer: env.payer.pubkey(),
            initializer,
            program: naryx_core::id(),
            program_data: env.program_data,
            config: env.config,
            system_program: anchor_lang::system_program::ID,
        },
        naryx_core::instruction::Initialize {
            environment: environment.to_string(),
            domain_id: domain_id.to_string(),
            domain_manifest_version: version,
            domain_manifest_hash: hash,
            config_delay_slots: delay,
            roles,
        },
    )
}

fn propose_domain_ix(
    config: Pubkey,
    proposer: Pubkey,
    version: u32,
    hash: [u8; HASH_BYTE_LENGTH],
) -> Instruction {
    build_ix(
        naryx_core::accounts::ProposeDomain { proposer, config },
        naryx_core::instruction::ProposeDomain {
            domain_manifest_version: version,
            domain_manifest_hash: hash,
        },
    )
}

fn cancel_domain_proposal_ix(config: Pubkey, canceller: Pubkey) -> Instruction {
    build_ix(
        naryx_core::accounts::CancelDomainProposal { canceller, config },
        naryx_core::instruction::CancelDomainProposal {},
    )
}

fn activate_domain_ix(config: Pubkey, executor: Pubkey) -> Instruction {
    build_ix(
        naryx_core::accounts::ActivateDomain { executor, config },
        naryx_core::instruction::ActivateDomain {},
    )
}

fn pause_entry_ix(config: Pubkey, pauser: Pubkey) -> Instruction {
    build_ix(
        naryx_core::accounts::PauseEntry { pauser, config },
        naryx_core::instruction::PauseEntry {},
    )
}

fn schedule_unpause_ix(config: Pubkey, proposer: Pubkey) -> Instruction {
    build_ix(
        naryx_core::accounts::ScheduleUnpause { proposer, config },
        naryx_core::instruction::ScheduleUnpause {},
    )
}

fn cancel_unpause_ix(config: Pubkey, canceller: Pubkey) -> Instruction {
    build_ix(
        naryx_core::accounts::CancelUnpause { canceller, config },
        naryx_core::instruction::CancelUnpause {},
    )
}

fn activate_unpause_ix(config: Pubkey, executor: Pubkey) -> Instruction {
    build_ix(
        naryx_core::accounts::ActivateUnpause { executor, config },
        naryx_core::instruction::ActivateUnpause {},
    )
}

fn read_config(svm: &LiteSVM, config: &Pubkey) -> ProtocolConfig {
    let account = svm.get_account(config).expect("config account exists");
    ProtocolConfig::try_deserialize(&mut account.data.as_slice()).unwrap()
}

fn assert_custom_error(result: TransactionResult, expected: ErrorCode) {
    assert_error_code(result, u32::from(expected));
}

fn assert_error_code(result: TransactionResult, expected: u32) {
    let failure = result.expect_err("transaction should have failed");
    assert_eq!(
        failure.err,
        TransactionError::InstructionError(0, InstructionError::Custom(expected))
    );
}

fn initialize(env: &mut Env) {
    let ix = initialize_ix(
        env,
        env.initializer.pubkey(),
        ENVIRONMENT,
        DOMAIN_ID,
        1,
        MANIFEST_HASH,
        CONFIG_DELAY_SLOTS,
        env.roles(),
    );
    send(&mut env.svm, &env.payer, &[&env.initializer], ix)
        .expect("upgrade authority should initialize");
}

fn initial_domain() -> DomainRef {
    DomainRef::new(DOMAIN_ID, 1, MANIFEST_HASH).unwrap()
}

#[test]
fn initialize_is_fail_closed_and_creates_the_singleton_config_pda() {
    let mut env = setup();
    initialize(&mut env);

    let account = env.svm.get_account(&env.config).expect("config exists");
    assert_eq!(account.owner, naryx_core::id());
    assert_eq!(account.data.len(), 8 + ProtocolConfig::INIT_SPACE);

    let config = read_config(&env.svm, &env.config);
    assert_eq!(config.config_version, PROTOCOL_CONFIG_VERSION);
    assert_eq!(config.environment, ProtocolId::new(ENVIRONMENT).unwrap());
    assert_eq!(config.domain, initial_domain());
    assert_eq!(config.pending_domain, None);
    assert_eq!(config.proposer, env.proposer.pubkey());
    assert_eq!(config.canceller, env.canceller.pubkey());
    assert_eq!(config.executor, env.executor.pubkey());
    assert_eq!(config.pauser, env.pauser.pubkey());
    assert_eq!(config.config_delay_slots, CONFIG_DELAY_SLOTS);
    assert!(config.entry_paused);
    assert_eq!(config.pending_unpause_slot, None);
    assert_eq!(config.bump, env.bump);
    assert!(![
        config.proposer,
        config.canceller,
        config.executor,
        config.pauser
    ]
    .contains(&env.initializer.pubkey()));

    let ix = initialize_ix(
        &env,
        env.initializer.pubkey(),
        ENVIRONMENT,
        DOMAIN_ID,
        9,
        OTHER_MANIFEST_HASH,
        CONFIG_DELAY_SLOTS,
        env.roles(),
    );
    assert!(send(&mut env.svm, &env.payer, &[&env.initializer], ix).is_err());
    assert_eq!(read_config(&env.svm, &env.config).domain, initial_domain());
}

#[test]
fn initialize_rejects_unrelated_signer_and_invalid_governance_inputs() {
    let mut env = setup();
    let roles = env.roles();

    let ix = initialize_ix(
        &env,
        env.outsider.pubkey(),
        ENVIRONMENT,
        DOMAIN_ID,
        1,
        MANIFEST_HASH,
        CONFIG_DELAY_SLOTS,
        roles,
    );
    assert_error_code(
        send(&mut env.svm, &env.payer, &[&env.outsider], ix),
        u32::from(AnchorErrorCode::ConstraintRaw),
    );
    assert!(env.svm.get_account(&env.config).is_none());

    let ix = initialize_ix(
        &env,
        env.initializer.pubkey(),
        ENVIRONMENT,
        DOMAIN_ID,
        1,
        MANIFEST_HASH,
        0,
        roles,
    );
    assert_custom_error(
        send(&mut env.svm, &env.payer, &[&env.initializer], ix),
        ErrorCode::ConfigDelayZero,
    );
    assert!(env.svm.get_account(&env.config).is_none());

    let ix = initialize_ix(
        &env,
        env.initializer.pubkey(),
        ENVIRONMENT,
        DOMAIN_ID,
        1,
        MANIFEST_HASH,
        CONFIG_DELAY_SLOTS,
        GovernanceRoles {
            executor: Pubkey::default(),
            ..roles
        },
    );
    assert_custom_error(
        send(&mut env.svm, &env.payer, &[&env.initializer], ix),
        ErrorCode::GovernanceRoleKeyZero,
    );
    assert!(env.svm.get_account(&env.config).is_none());

    let ix = initialize_ix(
        &env,
        env.initializer.pubkey(),
        ENVIRONMENT,
        DOMAIN_ID,
        1,
        MANIFEST_HASH,
        CONFIG_DELAY_SLOTS,
        GovernanceRoles {
            pauser: roles.proposer,
            ..roles
        },
    );
    assert_custom_error(
        send(&mut env.svm, &env.payer, &[&env.initializer], ix),
        ErrorCode::GovernanceRoleDuplicate,
    );
    assert!(env.svm.get_account(&env.config).is_none());

    let ix = initialize_ix(
        &env,
        env.initializer.pubkey(),
        ENVIRONMENT,
        DOMAIN_ID,
        0,
        MANIFEST_HASH,
        CONFIG_DELAY_SLOTS,
        roles,
    );
    assert_custom_error(
        send(&mut env.svm, &env.payer, &[&env.initializer], ix),
        ErrorCode::DomainManifestVersionZero,
    );
    assert!(env.svm.get_account(&env.config).is_none());

    let ix = initialize_ix(
        &env,
        env.initializer.pubkey(),
        "",
        DOMAIN_ID,
        1,
        MANIFEST_HASH,
        CONFIG_DELAY_SLOTS,
        roles,
    );
    assert_custom_error(
        send(&mut env.svm, &env.payer, &[&env.initializer], ix),
        ErrorCode::ProtocolIdEmpty,
    );
    assert!(env.svm.get_account(&env.config).is_none());
}

#[test]
fn domain_id_is_immutable_role_gated_cancellable_and_exactly_delayed() {
    let mut env = setup();
    initialize(&mut env);

    let ix = activate_domain_ix(env.config, env.executor.pubkey());
    assert_custom_error(
        send(&mut env.svm, &env.payer, &[&env.executor], ix),
        ErrorCode::DomainProposalMissing,
    );

    let ix = propose_domain_ix(env.config, env.outsider.pubkey(), 2, NEXT_MANIFEST_HASH);
    assert_custom_error(
        send(&mut env.svm, &env.payer, &[&env.outsider], ix),
        ErrorCode::UnauthorizedRole,
    );

    let ix = propose_domain_ix(env.config, env.proposer.pubkey(), 1, MANIFEST_HASH);
    assert_custom_error(
        send(&mut env.svm, &env.payer, &[&env.proposer], ix),
        ErrorCode::DomainManifestVersionNotIncreasing,
    );

    env.svm.warp_to_slot(100);
    let ix = propose_domain_ix(env.config, env.proposer.pubkey(), 2, NEXT_MANIFEST_HASH);
    send(&mut env.svm, &env.payer, &[&env.proposer], ix).expect("proposal should succeed");

    let proposed = PendingDomain {
        domain: DomainRef::new(DOMAIN_ID, 2, NEXT_MANIFEST_HASH).unwrap(),
        activation_slot: 100 + CONFIG_DELAY_SLOTS,
    };
    let config = read_config(&env.svm, &env.config);
    assert_eq!(config.pending_domain, Some(proposed.clone()));
    assert_eq!(config.domain, initial_domain());

    let ix = propose_domain_ix(env.config, env.proposer.pubkey(), 3, OTHER_MANIFEST_HASH);
    assert_custom_error(
        send(&mut env.svm, &env.payer, &[&env.proposer], ix),
        ErrorCode::DomainProposalExists,
    );

    let ix = cancel_domain_proposal_ix(env.config, env.outsider.pubkey());
    assert_custom_error(
        send(&mut env.svm, &env.payer, &[&env.outsider], ix),
        ErrorCode::UnauthorizedRole,
    );

    let ix = cancel_domain_proposal_ix(env.config, env.canceller.pubkey());
    send(&mut env.svm, &env.payer, &[&env.canceller], ix).expect("cancel should succeed");
    assert_eq!(read_config(&env.svm, &env.config).pending_domain, None);

    let ix = propose_domain_ix(env.config, env.proposer.pubkey(), 2, NEXT_MANIFEST_HASH);
    send(&mut env.svm, &env.payer, &[&env.proposer], ix).expect("re-proposal should succeed");

    env.svm.warp_to_slot(proposed.activation_slot - 1);
    let ix = activate_domain_ix(env.config, env.executor.pubkey());
    assert_custom_error(
        send(&mut env.svm, &env.payer, &[&env.executor], ix),
        ErrorCode::DomainProposalNotReady,
    );
    assert_eq!(read_config(&env.svm, &env.config).domain, initial_domain());

    env.svm.warp_to_slot(proposed.activation_slot);
    let ix = activate_domain_ix(env.config, env.outsider.pubkey());
    assert_custom_error(
        send(&mut env.svm, &env.payer, &[&env.outsider], ix),
        ErrorCode::UnauthorizedRole,
    );

    let ix = activate_domain_ix(env.config, env.executor.pubkey());
    send(&mut env.svm, &env.payer, &[&env.executor], ix).expect("activation should succeed");

    let config = read_config(&env.svm, &env.config);
    assert_eq!(config.domain, proposed.domain);
    assert_eq!(config.domain.domain_id(), DOMAIN_ID);
    assert_eq!(config.environment.as_str(), ENVIRONMENT);
    assert_eq!(config.pending_domain, None);

    let ix = propose_domain_ix(env.config, env.proposer.pubkey(), 2, OTHER_MANIFEST_HASH);
    assert_custom_error(
        send(&mut env.svm, &env.payer, &[&env.proposer], ix),
        ErrorCode::DomainManifestVersionNotIncreasing,
    );
}

#[test]
fn entry_pause_is_immediate_and_unpause_is_delayed() {
    let mut env = setup();
    initialize(&mut env);

    let ix = pause_entry_ix(env.config, env.pauser.pubkey());
    assert_custom_error(
        send(&mut env.svm, &env.payer, &[&env.pauser], ix),
        ErrorCode::EntryAlreadyPaused,
    );

    let ix = activate_unpause_ix(env.config, env.executor.pubkey());
    assert_custom_error(
        send(&mut env.svm, &env.payer, &[&env.executor], ix),
        ErrorCode::UnpauseNotScheduled,
    );

    env.svm.warp_to_slot(200);
    let ix = schedule_unpause_ix(env.config, env.outsider.pubkey());
    assert_custom_error(
        send(&mut env.svm, &env.payer, &[&env.outsider], ix),
        ErrorCode::UnauthorizedRole,
    );

    let ix = schedule_unpause_ix(env.config, env.proposer.pubkey());
    send(&mut env.svm, &env.payer, &[&env.proposer], ix).expect("schedule should succeed");
    assert_eq!(
        read_config(&env.svm, &env.config).pending_unpause_slot,
        Some(200 + CONFIG_DELAY_SLOTS)
    );

    let ix = schedule_unpause_ix(env.config, env.proposer.pubkey());
    assert_custom_error(
        send(&mut env.svm, &env.payer, &[&env.proposer], ix),
        ErrorCode::UnpauseAlreadyScheduled,
    );

    env.svm.warp_to_slot(200 + CONFIG_DELAY_SLOTS - 1);
    let ix = activate_unpause_ix(env.config, env.executor.pubkey());
    assert_custom_error(
        send(&mut env.svm, &env.payer, &[&env.executor], ix),
        ErrorCode::UnpauseNotReady,
    );
    assert!(read_config(&env.svm, &env.config).entry_paused);

    env.svm.warp_to_slot(200 + CONFIG_DELAY_SLOTS);
    let ix = activate_unpause_ix(env.config, env.outsider.pubkey());
    assert_custom_error(
        send(&mut env.svm, &env.payer, &[&env.outsider], ix),
        ErrorCode::UnauthorizedRole,
    );

    let ix = activate_unpause_ix(env.config, env.executor.pubkey());
    send(&mut env.svm, &env.payer, &[&env.executor], ix).expect("unpause should succeed");
    assert!(!read_config(&env.svm, &env.config).entry_paused);

    let ix = pause_entry_ix(env.config, env.outsider.pubkey());
    assert_custom_error(
        send(&mut env.svm, &env.payer, &[&env.outsider], ix),
        ErrorCode::UnauthorizedRole,
    );

    let ix = pause_entry_ix(env.config, env.pauser.pubkey());
    send(&mut env.svm, &env.payer, &[&env.pauser], ix).expect("pause should succeed");
    let config = read_config(&env.svm, &env.config);
    assert!(config.entry_paused);
    assert_eq!(config.pending_unpause_slot, None);

    let ix = pause_entry_ix(env.config, env.pauser.pubkey());
    assert_custom_error(
        send(&mut env.svm, &env.payer, &[&env.pauser], ix),
        ErrorCode::EntryAlreadyPaused,
    );

    let ix = schedule_unpause_ix(env.config, env.proposer.pubkey());
    send(&mut env.svm, &env.payer, &[&env.proposer], ix).expect("schedule should succeed");

    let ix = cancel_unpause_ix(env.config, env.outsider.pubkey());
    assert_custom_error(
        send(&mut env.svm, &env.payer, &[&env.outsider], ix),
        ErrorCode::UnauthorizedRole,
    );

    let ix = cancel_unpause_ix(env.config, env.canceller.pubkey());
    send(&mut env.svm, &env.payer, &[&env.canceller], ix).expect("cancel should succeed");
    assert_eq!(
        read_config(&env.svm, &env.config).pending_unpause_slot,
        None
    );

    let ix = schedule_unpause_ix(env.config, env.proposer.pubkey());
    send(&mut env.svm, &env.payer, &[&env.proposer], ix).expect("reschedule should succeed");
    let stale_activation_slot = 200 + 2 * CONFIG_DELAY_SLOTS;
    assert_eq!(
        read_config(&env.svm, &env.config).pending_unpause_slot,
        Some(stale_activation_slot)
    );

    let ix = pause_entry_ix(env.config, env.pauser.pubkey());
    send(&mut env.svm, &env.payer, &[&env.pauser], ix)
        .expect("re-pause should clear the scheduled unpause");
    let config = read_config(&env.svm, &env.config);
    assert!(config.entry_paused);
    assert_eq!(config.pending_unpause_slot, None);

    env.svm.warp_to_slot(stale_activation_slot);
    let ix = activate_unpause_ix(env.config, env.executor.pubkey());
    assert_custom_error(
        send(&mut env.svm, &env.payer, &[&env.executor], ix),
        ErrorCode::UnpauseNotScheduled,
    );
}

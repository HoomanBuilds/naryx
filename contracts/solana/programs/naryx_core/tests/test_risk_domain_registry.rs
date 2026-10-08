use {
    anchor_lang::{
        prelude::Pubkey,
        solana_program::{
            bpf_loader_upgradeable::{get_program_data_address, UpgradeableLoaderState},
            instruction::Instruction,
        },
        AccountDeserialize, InstructionData, ToAccountMetas,
    },
    litesvm::{
        types::{FailedTransactionMetadata, TransactionMetadata},
        LiteSVM,
    },
    naryx_core::{
        constants::{PROTOCOL_CONFIG_SEED, RISK_DOMAIN_INDEX_SEED, RISK_DOMAIN_RECORD_SEED},
        error::ErrorCode,
        instructions::{GovernanceRoles, ProposeRiskDomainArgs},
        state::{
            domain_ref_identity_hash, Lifecycle, ManifestRef, RiskDomainDependencyLimit,
            RiskDomainPolicyV1, RiskDomainRecord, RiskDomainSeriesRef, RISK_DOMAIN_SCHEMA_VERSION,
        },
        wire::DomainRef,
    },
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::{versioned::VersionedTransaction, InstructionError, TransactionError},
};

const CONFIG_DELAY_SLOTS: u64 = 8;
const DOMAIN_HASH: [u8; 32] = [0x11; 32];
const RISK_DOMAIN_ID: [u8; 32] = [0x22; 32];

type TransactionResult = Result<TransactionMetadata, Box<FailedTransactionMetadata>>;

struct Env {
    svm: LiteSVM,
    payer: Keypair,
    proposer: Keypair,
    executor: Keypair,
    pauser: Keypair,
    config: Pubkey,
}

fn send(
    svm: &mut LiteSVM,
    payer: &Keypair,
    signer: &Keypair,
    instruction: Instruction,
) -> TransactionResult {
    svm.expire_blockhash();
    let message = Message::new_with_blockhash(
        &[instruction],
        Some(&payer.pubkey()),
        &svm.latest_blockhash(),
    );
    let transaction =
        VersionedTransaction::try_new(VersionedMessage::Legacy(message), &[payer, signer]).unwrap();
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
    let config = Pubkey::find_program_address(&[PROTOCOL_CONFIG_SEED], &naryx_core::id()).0;
    let initialize = core_ix(
        naryx_core::accounts::Initialize {
            payer: payer.pubkey(),
            initializer: initializer.pubkey(),
            program: naryx_core::id(),
            program_data,
            config,
            system_program: anchor_lang::system_program::ID,
        },
        naryx_core::instruction::Initialize {
            environment: "devnet".to_string(),
            domain_id: "solana:devnet:naryx-core-v1".to_string(),
            domain_manifest_version: 1,
            domain_manifest_hash: DOMAIN_HASH,
            config_delay_slots: CONFIG_DELAY_SLOTS,
            roles: GovernanceRoles {
                proposer: proposer.pubkey(),
                canceller: canceller.pubkey(),
                executor: executor.pubkey(),
                pauser: pauser.pubkey(),
            },
        },
    );
    send(&mut svm, &payer, &initializer, initialize).unwrap();
    Env {
        svm,
        payer,
        proposer,
        executor,
        pauser,
        config,
    }
}

fn policy() -> RiskDomainPolicyV1 {
    let domain = DomainRef::new("solana:devnet:naryx-core-v1", 1, DOMAIN_HASH).unwrap();
    RiskDomainPolicyV1 {
        schema_version: RISK_DOMAIN_SCHEMA_VERSION,
        manifest_version: 1,
        manifest_hash: [0x33; 32],
        domain_ref_identity_hash: domain_ref_identity_hash(&domain),
        accounting_asset: ManifestRef {
            subject_id: [0x44; 32],
            manifest_version: 1,
            manifest_hash: [0x55; 32],
        },
        gross_cap_quote_atoms: 10_000_000,
        net_cap_quote_atoms: 2_000_000,
        minimum_margin_floor_quote_atoms: 500_000,
        maximum_leverage_bps: 50_000,
        maximum_staleness_ms: 5_000,
        maximum_time_to_unwind_ms: 60_000,
        required_recovery_reserve_quote_atoms: 100_000,
        aggregate_haircut_bps: 3_000,
        eligible_series: vec![RiskDomainSeriesRef {
            series_id: [0x66; 32],
            manifest_version: 1,
            manifest_hash: [0x77; 32],
        }],
        dependency_limits: vec![RiskDomainDependencyLimit {
            dependency_id: [0x88; 32],
            maximum_gross_quote_atoms: 4_000_000,
        }],
    }
}

fn addresses() -> (Pubkey, Pubkey) {
    let policy = policy();
    let index = Pubkey::find_program_address(
        &[RISK_DOMAIN_INDEX_SEED, RISK_DOMAIN_ID.as_ref()],
        &naryx_core::id(),
    )
    .0;
    let record = Pubkey::find_program_address(
        &[
            RISK_DOMAIN_RECORD_SEED,
            RISK_DOMAIN_ID.as_ref(),
            policy.manifest_version.to_be_bytes().as_ref(),
        ],
        &naryx_core::id(),
    )
    .0;
    (index, record)
}

fn assert_custom_error(result: TransactionResult, expected: ErrorCode) {
    let failure = result.expect_err("transaction should fail");
    assert_eq!(
        failure.err,
        TransactionError::InstructionError(0, InstructionError::Custom(u32::from(expected)))
    );
}

#[test]
fn risk_domain_activation_and_pause_are_enforced() {
    let mut env = setup();
    let (index, record) = addresses();
    env.svm.warp_to_slot(100);
    let propose = core_ix(
        naryx_core::accounts::ProposeInitialRiskDomain {
            payer: env.payer.pubkey(),
            proposer: env.proposer.pubkey(),
            config: env.config,
            index,
            record,
            system_program: anchor_lang::system_program::ID,
        },
        naryx_core::instruction::ProposeInitialRiskDomain {
            args: ProposeRiskDomainArgs {
                risk_domain_id: RISK_DOMAIN_ID,
                policy: policy(),
            },
        },
    );
    send(&mut env.svm, &env.payer, &env.proposer, propose).unwrap();

    let activate = || {
        core_ix(
            naryx_core::accounts::ActivateInitialRiskDomain {
                executor: env.executor.pubkey(),
                config: env.config,
                index,
                record,
            },
            naryx_core::instruction::ActivateInitialRiskDomain {},
        )
    };
    env.svm.warp_to_slot(107);
    assert_custom_error(
        send(&mut env.svm, &env.payer, &env.executor, activate()),
        ErrorCode::RiskDomainProposalNotReady,
    );
    env.svm.warp_to_slot(108);
    send(&mut env.svm, &env.payer, &env.executor, activate()).unwrap();

    let account = env.svm.get_account(&record).unwrap();
    let active = RiskDomainRecord::try_deserialize(&mut account.data.as_slice()).unwrap();
    assert!(active.active);
    assert_eq!(active.lifecycle, Lifecycle::Active);

    let pause = core_ix(
        naryx_core::accounts::ControlRiskDomain {
            actor: env.pauser.pubkey(),
            config: env.config,
            index,
            record,
        },
        naryx_core::instruction::PauseRiskDomainEntry {},
    );
    send(&mut env.svm, &env.payer, &env.pauser, pause).unwrap();
    let account = env.svm.get_account(&record).unwrap();
    let paused = RiskDomainRecord::try_deserialize(&mut account.data.as_slice()).unwrap();
    assert_eq!(paused.lifecycle, Lifecycle::EntryPaused);
}

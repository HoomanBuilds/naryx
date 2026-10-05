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
        constants::{FEE_POLICY_SEED, PROTOCOL_CONFIG_SEED},
        error::ErrorCode,
        instructions::{GovernanceRoles, ProposeFeePolicyArgs},
        state::{domain_ref_identity_hash, FeePolicyDirection, FeePolicyRecord, ManifestRef},
        wire::DomainRef,
    },
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::{versioned::VersionedTransaction, InstructionError, TransactionError},
};

const CONFIG_DELAY_SLOTS: u64 = 8;
const DOMAIN_HASH: [u8; 32] = [0x11; 32];

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

fn quote_asset() -> ManifestRef {
    ManifestRef {
        subject_id: [0x22; 32],
        manifest_version: 3,
        manifest_hash: [0x33; 32],
    }
}

fn policy_address(direction: FeePolicyDirection, quote_asset: &ManifestRef) -> Pubkey {
    let domain = DomainRef::new("solana:devnet:naryx-core-v1", 1, DOMAIN_HASH).unwrap();
    Pubkey::find_program_address(
        &[
            FEE_POLICY_SEED,
            domain_ref_identity_hash(&domain).as_ref(),
            direction.seed().as_ref(),
            quote_asset.subject_id.as_ref(),
        ],
        &naryx_core::id(),
    )
    .0
}

fn propose_ix(env: &Env, version: u32, manifest_hash: [u8; 32]) -> Instruction {
    let direction = FeePolicyDirection::Entry;
    let quote_asset = quote_asset();
    core_ix(
        naryx_core::accounts::ProposeFeePolicy {
            payer: env.payer.pubkey(),
            proposer: env.proposer.pubkey(),
            config: env.config,
            policy: policy_address(direction, &quote_asset),
            system_program: anchor_lang::system_program::ID,
        },
        naryx_core::instruction::ProposeFeePolicy {
            args: ProposeFeePolicyArgs {
                expected_domain_identity_hash: domain_ref_identity_hash(
                    &DomainRef::new("solana:devnet:naryx-core-v1", 1, DOMAIN_HASH).unwrap(),
                ),
                direction,
                quote_asset,
                version,
                manifest_hash,
                maximum_protocol_fee_bps: 10,
                maximum_solver_fee_bps: 25,
                protocol_fee_recipient: Pubkey::new_unique(),
            },
        },
    )
}

fn read_policy(svm: &LiteSVM, address: Pubkey) -> FeePolicyRecord {
    let account = svm.get_account(&address).unwrap();
    FeePolicyRecord::try_deserialize(&mut account.data.as_slice()).unwrap()
}

fn assert_custom_error(result: TransactionResult, expected: ErrorCode) {
    let failure = result.expect_err("transaction should fail");
    assert_eq!(
        failure.err,
        TransactionError::InstructionError(0, InstructionError::Custom(u32::from(expected)))
    );
}

#[test]
fn policy_activation_pause_and_resume_follow_governance_delay() {
    let mut env = setup();
    env.svm.warp_to_slot(100);
    let quote_asset = quote_asset();
    let policy = policy_address(FeePolicyDirection::Entry, &quote_asset);
    let propose = propose_ix(&env, 1, [0x44; 32]);
    send(&mut env.svm, &env.payer, &env.proposer, propose).unwrap();
    assert_eq!(
        read_policy(&env.svm, policy)
            .pending
            .as_ref()
            .unwrap()
            .activation_slot,
        108
    );

    let activate = || {
        core_ix(
            naryx_core::accounts::ActivateFeePolicy {
                executor: env.executor.pubkey(),
                config: env.config,
                policy,
            },
            naryx_core::instruction::ActivateFeePolicy {},
        )
    };
    env.svm.warp_to_slot(107);
    assert_custom_error(
        send(&mut env.svm, &env.payer, &env.executor, activate()),
        ErrorCode::FeePolicyProposalNotReady,
    );
    env.svm.warp_to_slot(108);
    send(&mut env.svm, &env.payer, &env.executor, activate()).unwrap();
    let active = read_policy(&env.svm, policy);
    assert_eq!(active.active_version, 1);
    assert_eq!(active.maximum_protocol_fee_bps, 10);
    assert_eq!(active.maximum_solver_fee_bps, 25);

    let pause = core_ix(
        naryx_core::accounts::PauseFeePolicy {
            pauser: env.pauser.pubkey(),
            config: env.config,
            policy,
        },
        naryx_core::instruction::PauseFeePolicy {},
    );
    send(&mut env.svm, &env.payer, &env.pauser, pause).unwrap();
    assert!(read_policy(&env.svm, policy).paused);

    env.svm.warp_to_slot(200);
    let propose_resume = core_ix(
        naryx_core::accounts::ProposeFeePolicyResume {
            proposer: env.proposer.pubkey(),
            config: env.config,
            policy,
        },
        naryx_core::instruction::ProposeFeePolicyResume {},
    );
    send(&mut env.svm, &env.payer, &env.proposer, propose_resume).unwrap();
    let activate_resume = || {
        core_ix(
            naryx_core::accounts::ActivateFeePolicyResume {
                executor: env.executor.pubkey(),
                config: env.config,
                policy,
            },
            naryx_core::instruction::ActivateFeePolicyResume {},
        )
    };
    env.svm.warp_to_slot(207);
    assert_custom_error(
        send(&mut env.svm, &env.payer, &env.executor, activate_resume()),
        ErrorCode::FeePolicyResumeNotReady,
    );
    env.svm.warp_to_slot(208);
    send(&mut env.svm, &env.payer, &env.executor, activate_resume()).unwrap();
    assert!(!read_policy(&env.svm, policy).paused);
}

use {
    anchor_lang::{
        prelude::Pubkey,
        solana_program::{
            bpf_loader_upgradeable::get_program_data_address, instruction::Instruction,
            program_pack::Pack, system_instruction,
        },
        AccountDeserialize, AccountSerialize, AnchorSerialize, InstructionData, Space,
        ToAccountMetas,
    },
    anchor_spl::token::{
        spl_token::{self, state::Account as SplAccount, state::Mint},
        ID as TOKEN_PROGRAM_ID,
    },
    litesvm::{
        types::{FailedTransactionMetadata, TransactionMetadata},
        LiteSVM,
    },
    naryx_core::{
        instructions::program_identity::program_data_header_identity,
        state::{
            domain_ref_identity_hash, DescriptorRef, ExecutionRole, FeePolicyDirection,
            FeePolicyRecord, Lifecycle, ManifestRef, ProtocolConfig, QuoteLimit, ResourceControl,
            ResourceIndex, ResourceKind, ResourceManifest, ResourceRecord, SettlementClass,
            SettlementRef, SolverRegistry, INVENTORY_ADAPTER_CLASS_ID, PROTOCOL_CONFIG_VERSION,
        },
        DomainRef, ProtocolId, ADAPTER_RESOURCE_SEED, ASSET_RESOURCE_SEED, FEE_POLICY_SEED,
        PROTOCOL_CONFIG_SEED, RESOURCE_INDEX_SEED, RESOURCE_RECORD_SEED, SOLVER_REGISTRY_SEED,
    },
    naryx_inventory_adapter::{
        error::ErrorCode as InventoryError, ExactInventoryLeg, LOCK, PACKAGE_INVENTORY_SEED,
        PACKAGE_INVENTORY_VAULT_SEED, RELEASE,
    },
    naryx_multi_strategy::{
        error::ErrorCode, MultiStrategyAccount, StrategyCallArgs, StrategyExecutionArgs,
        StrategyFeeTerms, StrategyOperation, StrategyPosition, MULTI_STRATEGY_ACCOUNT_SEED,
        STRATEGY_POSITION_SEED, STRATEGY_RECEIPT_SEED,
    },
    solana_account::Account,
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::{versioned::VersionedTransaction, InstructionError, TransactionError},
};

type TransactionResult = Result<TransactionMetadata, Box<FailedTransactionMetadata>>;

const QUOTE: ManifestRef = ManifestRef {
    subject_id: [0x71; 32],
    manifest_version: 1,
    manifest_hash: [0x72; 32],
};
const ADAPTER: ManifestRef = ManifestRef {
    subject_id: [0x61; 32],
    manifest_version: 1,
    manifest_hash: [0x62; 32],
};
const FEE_POLICY_HASH: [u8; 32] = [0x73; 32];
const PACKAGE_A: [u8; 32] = [0xa1; 32];
const PACKAGE_B: [u8; 32] = [0xb2; 32];
const FUNDED_ATOMS: u64 = 1_000;

struct Env {
    svm: LiteSVM,
    owner: Keypair,
    solver: Keypair,
    domain: DomainRef,
    template: DescriptorRef,
    mint: Pubkey,
    strategy_account: Pubkey,
    strategy_token: Pubkey,
    owner_token: Pubkey,
    protocol_fee_token: Pubkey,
    solver_fee_token: Pubkey,
    config: Pubkey,
    adapter_index: Pubkey,
    adapter_record: Pubkey,
    nonce: u64,
}

fn send(
    svm: &mut LiteSVM,
    payer: &Keypair,
    extra: &[&Keypair],
    ixs: &[Instruction],
) -> TransactionResult {
    svm.expire_blockhash();
    let mut instructions = vec![compute_limit_ix(1_400_000)];
    instructions.extend_from_slice(ixs);
    let message = Message::new_with_blockhash(
        &instructions,
        Some(&payer.pubkey()),
        &svm.latest_blockhash(),
    );
    let mut signers = vec![payer];
    signers.extend_from_slice(extra);
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(message), &signers).unwrap();
    svm.send_transaction(tx).map_err(Box::new)
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

fn ix<A: ToAccountMetas, D: InstructionData>(program: Pubkey, accounts: A, data: D) -> Instruction {
    Instruction::new_with_bytes(program, &data.data(), accounts.to_account_metas(None))
}

fn assert_custom(result: TransactionResult, expected: u32) {
    let failure = result.expect_err("transaction should fail");
    assert_eq!(
        failure.err,
        TransactionError::InstructionError(1, InstructionError::Custom(expected)),
        "{:#?}",
        failure.meta.logs
    );
}

fn pda(seeds: &[&[u8]], program: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(seeds, program).0
}

fn write<T: AccountSerialize + Space>(
    svm: &mut LiteSVM,
    address: Pubkey,
    owner: Pubkey,
    value: &T,
) {
    let mut data = Vec::new();
    value.try_serialize(&mut data).unwrap();
    data.resize(8 + T::INIT_SPACE, 0);
    let account = Account {
        lamports: svm.minimum_balance_for_rent_exemption(data.len()),
        data,
        owner,
        executable: false,
        rent_epoch: 0,
    };
    svm.set_account(address, account).unwrap();
}

fn create_mint(svm: &mut LiteSVM, payer: &Keypair) -> Pubkey {
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
        6,
    )
    .unwrap();
    send(svm, payer, &[&mint], &[create, initialize]).unwrap();
    mint.pubkey()
}

fn create_token_account(svm: &mut LiteSVM, payer: &Keypair, mint: Pubkey, owner: Pubkey) -> Pubkey {
    let account = Keypair::new();
    let create = system_instruction::create_account(
        &payer.pubkey(),
        &account.pubkey(),
        svm.minimum_balance_for_rent_exemption(SplAccount::LEN),
        SplAccount::LEN as u64,
        &TOKEN_PROGRAM_ID,
    );
    let initialize = spl_token::instruction::initialize_account3(
        &TOKEN_PROGRAM_ID,
        &account.pubkey(),
        &mint,
        &owner,
    )
    .unwrap();
    send(svm, payer, &[&account], &[create, initialize]).unwrap();
    account.pubkey()
}

fn balance(svm: &LiteSVM, address: Pubkey) -> u64 {
    SplAccount::unpack(&svm.get_account(&address).unwrap().data)
        .unwrap()
        .amount
}

fn inventory_addresses(env: &Env, package_id: [u8; 32]) -> (Pubkey, Pubkey) {
    let inventory = pda(
        &[
            PACKAGE_INVENTORY_SEED,
            env.strategy_account.as_ref(),
            package_id.as_ref(),
            env.mint.as_ref(),
        ],
        &naryx_inventory_adapter::id(),
    );
    let vault = pda(
        &[PACKAGE_INVENTORY_VAULT_SEED, inventory.as_ref()],
        &naryx_inventory_adapter::id(),
    );
    (inventory, vault)
}

fn position_address(env: &Env, package_id: [u8; 32]) -> Pubkey {
    pda(
        &[
            STRATEGY_POSITION_SEED,
            env.strategy_account.as_ref(),
            package_id.as_ref(),
        ],
        &naryx_multi_strategy::id(),
    )
}

fn strategy_account(env: &Env) -> MultiStrategyAccount {
    let account = env.svm.get_account(&env.strategy_account).unwrap();
    MultiStrategyAccount::try_deserialize(&mut account.data.as_slice()).unwrap()
}

fn position(env: &Env, package_id: [u8; 32]) -> StrategyPosition {
    let account = env
        .svm
        .get_account(&position_address(env, package_id))
        .unwrap();
    StrategyPosition::try_deserialize(&mut account.data.as_slice()).unwrap()
}

fn setup() -> Env {
    let mut svm = LiteSVM::new();
    for (id, elf) in [
        (
            naryx_core::id(),
            include_bytes!("../../../target/deploy/naryx_core.so").as_slice(),
        ),
        (
            naryx_multi_strategy::id(),
            include_bytes!("../../../target/deploy/naryx_multi_strategy.so").as_slice(),
        ),
        (
            naryx_inventory_adapter::id(),
            include_bytes!("../../../target/deploy/naryx_inventory_adapter.so").as_slice(),
        ),
    ] {
        svm.add_program(id, elf).unwrap();
    }
    let owner = Keypair::new();
    let solver = Keypair::new();
    svm.airdrop(&owner.pubkey(), 10_000_000_000).unwrap();

    let domain = DomainRef::new("solana:localnet:naryx-core-v1", 1, [0x44; 32]).unwrap();
    let template = DescriptorRef::new("treasury-inventory-hedge-v1", 1, [0x51; 32]).unwrap();
    let core = naryx_core::id();
    let config = pda(&[PROTOCOL_CONFIG_SEED], &core);
    write(
        &mut svm,
        config,
        core,
        &ProtocolConfig {
            config_version: PROTOCOL_CONFIG_VERSION,
            environment: ProtocolId::new("localnet").unwrap(),
            domain: domain.clone(),
            pending_domain: None,
            proposer: owner.pubkey(),
            canceller: owner.pubkey(),
            executor: owner.pubkey(),
            pauser: owner.pubkey(),
            config_delay_slots: 2,
            entry_paused: false,
            pending_unpause_slot: None,
            bump: Pubkey::find_program_address(&[PROTOCOL_CONFIG_SEED], &core).1,
        },
    );
    let solver_registry = pda(&[SOLVER_REGISTRY_SEED], &core);
    write(
        &mut svm,
        solver_registry,
        core,
        &SolverRegistry {
            active: vec![solver.pubkey()],
            pending: vec![],
            bump: Pubkey::find_program_address(&[SOLVER_REGISTRY_SEED], &core).1,
        },
    );

    let mint = create_mint(&mut svm, &owner);
    let protocol_recipient = Pubkey::new_unique();
    let domain_identity = domain_ref_identity_hash(&domain);
    for direction in [FeePolicyDirection::Entry, FeePolicyDirection::Exit] {
        let (address, bump) = Pubkey::find_program_address(
            &[
                FEE_POLICY_SEED,
                domain_identity.as_ref(),
                direction.seed().as_ref(),
                QUOTE.subject_id.as_ref(),
            ],
            &core,
        );
        write(
            &mut svm,
            address,
            core,
            &FeePolicyRecord {
                domain: domain.clone(),
                domain_identity_hash: domain_identity,
                direction,
                quote_asset: QUOTE,
                active_version: 1,
                active_manifest_hash: FEE_POLICY_HASH,
                maximum_protocol_fee_bps: 0,
                maximum_solver_fee_bps: 0,
                protocol_fee_recipient: protocol_recipient,
                paused: false,
                pending: None,
                pending_resume_slot: None,
                bump,
            },
        );
    }

    let base_manifest = ResourceManifest {
        kind: ResourceKind::Asset,
        domain: domain.clone(),
        identity: QUOTE,
        subject_address: mint,
        program_id: TOKEN_PROGRAM_ID,
        program_data: Pubkey::default(),
        code_identity: [0u8; 32],
        decimals: 6,
        quote_decimals: 6,
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
    let inventory_program = naryx_inventory_adapter::id();
    let program_data = get_program_data_address(&inventory_program);
    let code_identity =
        program_data_header_identity(&svm.get_account(&program_data).unwrap().data).unwrap();
    let adapter_manifest = ResourceManifest {
        kind: ResourceKind::Adapter,
        identity: ADAPTER,
        subject_address: inventory_program,
        program_id: inventory_program,
        program_data,
        code_identity,
        role: ExecutionRole::Inventory,
        adapter_class: Some(DescriptorRef::new(INVENTORY_ADAPTER_CLASS_ID, 1, [0x63; 32]).unwrap()),
        quote_asset: Some(QUOTE),
        allowed_template: Some(template.clone()),
        settlement: Some(settlement()),
        ..base_manifest.clone()
    };
    let mut resource_addresses = Vec::new();
    for (seed, manifest, quote_limit) in [
        (ASSET_RESOURCE_SEED, base_manifest, None),
        (
            ADAPTER_RESOURCE_SEED,
            adapter_manifest,
            Some(QuoteLimit {
                quote_asset: QUOTE,
                quote_decimals: 6,
                maximum_notional_atoms: FUNDED_ATOMS,
            }),
        ),
    ] {
        let identity = manifest.identity.clone();
        let version = identity.manifest_version.to_be_bytes();
        let (index, index_bump) = Pubkey::find_program_address(
            &[RESOURCE_INDEX_SEED, seed, identity.subject_id.as_ref()],
            &core,
        );
        let (record, record_bump) = Pubkey::find_program_address(
            &[
                RESOURCE_RECORD_SEED,
                seed,
                identity.subject_id.as_ref(),
                version.as_ref(),
            ],
            &core,
        );
        write(
            &mut svm,
            index,
            core,
            &ResourceIndex {
                kind: manifest.kind,
                subject_id: identity.subject_id,
                latest_version: identity.manifest_version,
                active_record: record,
                active_identity: Some(identity),
                pending_record: Pubkey::default(),
                pending_identity: None,
                activation_slot: None,
                bump: index_bump,
            },
        );
        write(
            &mut svm,
            record,
            core,
            &ResourceRecord {
                manifest,
                control: ResourceControl {
                    lifecycle: Lifecycle::Active,
                    quote_limit,
                },
                pending_control: None,
                active: true,
                bump: record_bump,
            },
        );
        resource_addresses.push((index, record));
    }
    let (adapter_index, adapter_record) = resource_addresses[1];

    let strategy_account = pda(
        &[MULTI_STRATEGY_ACCOUNT_SEED, owner.pubkey().as_ref()],
        &naryx_multi_strategy::id(),
    );
    send(
        &mut svm,
        &owner,
        &[],
        &[ix(
            naryx_multi_strategy::id(),
            naryx_multi_strategy::accounts::InitializeMultiStrategyAccount {
                owner: owner.pubkey(),
                config,
                strategy_account,
                system_program: anchor_lang::system_program::ID,
            },
            naryx_multi_strategy::instruction::InitializeMultiStrategyAccount {},
        )],
    )
    .unwrap();
    let strategy_token = create_token_account(&mut svm, &owner, mint, strategy_account);
    let mint_to = spl_token::instruction::mint_to(
        &TOKEN_PROGRAM_ID,
        &mint,
        &strategy_token,
        &owner.pubkey(),
        &[],
        FUNDED_ATOMS,
    )
    .unwrap();
    send(&mut svm, &owner, &[], &[mint_to]).unwrap();
    let owner_token = create_token_account(&mut svm, &owner, mint, owner.pubkey());
    let protocol_fee_token = create_token_account(&mut svm, &owner, mint, protocol_recipient);
    let solver_fee_token = create_token_account(&mut svm, &owner, mint, solver.pubkey());

    let mut env = Env {
        svm,
        owner,
        solver,
        domain,
        template,
        mint,
        strategy_account,
        strategy_token,
        owner_token,
        protocol_fee_token,
        solver_fee_token,
        config,
        adapter_index,
        adapter_record,
        nonce: 0,
    };
    for package_id in [PACKAGE_A, PACKAGE_B] {
        let (inventory, vault) = inventory_addresses(&env, package_id);
        let initialize = ix(
            inventory_program,
            naryx_inventory_adapter::accounts::InitializePackageInventory {
                payer: env.owner.pubkey(),
                strategy_account: env.strategy_account,
                mint: env.mint,
                inventory,
                vault,
                system_program: anchor_lang::system_program::ID,
                token_program: TOKEN_PROGRAM_ID,
            },
            naryx_inventory_adapter::instruction::InitializePackageInventory { package_id },
        );
        send(&mut env.svm, &env.owner, &[], &[initialize]).unwrap();
    }
    env
}

fn settlement() -> SettlementRef {
    SettlementRef {
        class: SettlementClass::AtomicPostcondition,
        version: 1,
        manifest_hash: [0x52; 32],
    }
}

/// One inventory leg against `inventory_package`'s inventory. The leg names the same package.
fn inventory_call(
    env: &Env,
    inventory_package: [u8; 32],
    action: u8,
    atoms: u64,
    pre_inventory: u64,
    risk_increasing: bool,
) -> (StrategyCallArgs, Vec<anchor_lang::prelude::AccountMeta>) {
    let post_inventory = if action == LOCK {
        pre_inventory + atoms
    } else {
        pre_inventory - atoms
    };
    let leg = ExactInventoryLeg {
        package_id: inventory_package,
        order_hash: [0x11; 32],
        quote_hash: [0x12; 32],
        route_hash: [0x13; 32],
        action,
        input_atoms: atoms,
        expected_pre_inventory_atoms: pre_inventory,
        expected_post_inventory_atoms: post_inventory,
    };
    let (inventory, vault) = inventory_addresses(env, inventory_package);
    let program = naryx_inventory_adapter::id();
    let mut metas = vec![
        anchor_lang::prelude::AccountMeta::new_readonly(env.adapter_index, false),
        anchor_lang::prelude::AccountMeta::new_readonly(env.adapter_record, false),
        anchor_lang::prelude::AccountMeta::new_readonly(program, false),
        anchor_lang::prelude::AccountMeta::new_readonly(get_program_data_address(&program), false),
    ];
    metas.extend(
        naryx_inventory_adapter::accounts::ExecutePackageInventory {
            strategy_account: env.strategy_account,
            inventory,
            strategy_token: env.strategy_token,
            vault,
            mint: env.mint,
            token_program: TOKEN_PROGRAM_ID,
        }
        .to_account_metas(None)
        .into_iter()
        .map(|meta| anchor_lang::prelude::AccountMeta {
            is_signer: false,
            ..meta
        }),
    );
    let call = StrategyCallArgs {
        adapter: ADAPTER,
        stage: 0,
        risk_increasing,
        gross_notional_atoms: atoms,
        account_count: 6,
        payload: {
            let mut payload = Vec::new();
            leg.serialize(&mut payload).unwrap();
            payload
        },
    };
    (call, metas)
}

fn execution(
    env: &Env,
    package_id: [u8; 32],
    operation: StrategyOperation,
    previous_state_hash: [u8; 32],
    next_state_hash: [u8; 32],
    total_gross_notional_atoms: u64,
    recovery: bool,
) -> StrategyExecutionArgs {
    let fees = if recovery {
        StrategyFeeTerms {
            direction: FeePolicyDirection::Exit,
            quote_asset: ManifestRef {
                subject_id: [0u8; 32],
                manifest_version: 0,
                manifest_hash: [0u8; 32],
            },
            policy_version: 0,
            policy_manifest_hash: [0u8; 32],
            protocol_fee_atoms: 0,
            solver_fee_atoms: 0,
        }
    } else {
        StrategyFeeTerms {
            direction: if matches!(
                operation,
                StrategyOperation::Enter | StrategyOperation::Increase
            ) {
                FeePolicyDirection::Entry
            } else {
                FeePolicyDirection::Exit
            },
            quote_asset: QUOTE,
            policy_version: 1,
            policy_manifest_hash: FEE_POLICY_HASH,
            protocol_fee_atoms: 0,
            solver_fee_atoms: 0,
        }
    };
    StrategyExecutionArgs {
        domain: env.domain.clone(),
        package_id,
        order_hash: [0x21; 32],
        graph_hash: [0x22; 32],
        quote_hash: [0x23; 32],
        route_hash: [0x24; 32],
        template: env.template.clone(),
        settlement: settlement(),
        operation,
        previous_state_hash,
        next_state_hash,
        total_gross_notional_atoms,
        fees,
        solver: if recovery {
            Pubkey::default()
        } else {
            env.solver.pubkey()
        },
        nonce: env.nonce,
        deadline_slot: env.svm.get_sysvar::<anchor_lang::prelude::Clock>().slot + 1_000,
    }
}

fn execute(
    env: &mut Env,
    execution: StrategyExecutionArgs,
    call: (StrategyCallArgs, Vec<anchor_lang::prelude::AccountMeta>),
) -> TransactionResult {
    let program = naryx_multi_strategy::id();
    let (call, remaining) = call;
    let recovery = execution.solver == Pubkey::default();
    let position = position_address(env, execution.package_id);
    let receipt = pda(
        &[
            STRATEGY_RECEIPT_SEED,
            env.strategy_account.as_ref(),
            execution.nonce.to_be_bytes().as_ref(),
        ],
        &program,
    );
    let mut instruction = if recovery {
        ix(
            program,
            naryx_multi_strategy::accounts::ExecuteMultiStrategyRecovery {
                owner: env.owner.pubkey(),
                config: env.config,
                strategy_account: env.strategy_account,
                position,
                receipt,
                system_program: anchor_lang::system_program::ID,
            },
            naryx_multi_strategy::instruction::ExecuteMultiStrategyRecovery {
                execution: execution.clone(),
                calls: vec![call],
            },
        )
    } else {
        let core = naryx_core::id();
        let direction = execution.fees.direction;
        ix(
            program,
            naryx_multi_strategy::accounts::ExecuteMultiStrategy {
                owner: env.owner.pubkey(),
                solver: env.solver.pubkey(),
                config: env.config,
                solver_registry: pda(&[SOLVER_REGISTRY_SEED], &core),
                fee_policy: pda(
                    &[
                        FEE_POLICY_SEED,
                        domain_ref_identity_hash(&env.domain).as_ref(),
                        direction.seed().as_ref(),
                        QUOTE.subject_id.as_ref(),
                    ],
                    &core,
                ),
                quote_asset_index: pda(
                    &[
                        RESOURCE_INDEX_SEED,
                        ASSET_RESOURCE_SEED,
                        QUOTE.subject_id.as_ref(),
                    ],
                    &core,
                ),
                quote_asset_record: pda(
                    &[
                        RESOURCE_RECORD_SEED,
                        ASSET_RESOURCE_SEED,
                        QUOTE.subject_id.as_ref(),
                        QUOTE.manifest_version.to_be_bytes().as_ref(),
                    ],
                    &core,
                ),
                quote_mint: env.mint,
                owner_fee_token: env.owner_token,
                protocol_fee_token: env.protocol_fee_token,
                solver_fee_token: env.solver_fee_token,
                strategy_account: env.strategy_account,
                position,
                receipt,
                token_program: TOKEN_PROGRAM_ID,
                system_program: anchor_lang::system_program::ID,
            },
            naryx_multi_strategy::instruction::ExecuteMultiStrategy {
                execution: execution.clone(),
                calls: vec![call],
            },
        )
    };
    instruction.accounts.extend(remaining);
    let owner = env.owner.insecure_clone();
    let solver = env.solver.insecure_clone();
    let extra: Vec<&Keypair> = if recovery { vec![] } else { vec![&solver] };
    let result = send(&mut env.svm, &owner, &extra, &[instruction]);
    if result.is_ok() {
        env.nonce += 1;
    }
    result
}

fn enter(env: &mut Env, package_id: [u8; 32], atoms: u64, state: [u8; 32]) {
    let call = inventory_call(env, package_id, LOCK, atoms, 0, true);
    let execution = execution(
        env,
        package_id,
        StrategyOperation::Enter,
        [0u8; 32],
        state,
        atoms,
        false,
    );
    execute(env, execution, call).unwrap();
}

fn exit(
    env: &mut Env,
    package_id: [u8; 32],
    atoms: u64,
    state: [u8; 32],
    recovery: bool,
) -> TransactionResult {
    let call = inventory_call(env, package_id, RELEASE, atoms, atoms, false);
    let execution = execution(
        env,
        package_id,
        StrategyOperation::Exit,
        state,
        [0u8; 32],
        atoms,
        recovery,
    );
    execute(env, execution, call)
}

fn withdraw_ix(
    owner: Pubkey,
    strategy_account: Pubkey,
    mint: Pubkey,
    source: Pubkey,
    destination: Pubkey,
    amount: u64,
) -> Instruction {
    ix(
        naryx_multi_strategy::id(),
        naryx_multi_strategy::accounts::WithdrawIdleToken {
            owner,
            strategy_account,
            mint,
            source,
            destination,
            token_program: TOKEN_PROGRAM_ID,
        },
        naryx_multi_strategy::instruction::WithdrawIdleToken { amount },
    )
}

#[test]
fn owner_withdraws_idle_tokens_only_after_every_package_exits() {
    let mut env = setup();
    let recipient = Pubkey::new_unique();
    let destination = create_token_account(&mut env.svm, &env.owner, env.mint, recipient);
    let owner = env.owner.insecure_clone();

    enter(&mut env, PACKAGE_A, 400, [0x31; 32]);
    assert_eq!(strategy_account(&env).open_package_count, 1);
    assert_custom(
        send(
            &mut env.svm,
            &owner,
            &[],
            &[withdraw_ix(
                owner.pubkey(),
                env.strategy_account,
                env.mint,
                env.strategy_token,
                destination,
                1,
            )],
        ),
        u32::from(ErrorCode::PackageOpen),
    );

    exit(&mut env, PACKAGE_A, 400, [0x31; 32], false).unwrap();
    assert_eq!(strategy_account(&env).open_package_count, 0);
    assert_eq!(balance(&env.svm, env.strategy_token), FUNDED_ATOMS);

    let attacker = Keypair::new();
    env.svm.airdrop(&attacker.pubkey(), 1_000_000_000).unwrap();
    assert_custom(
        send(
            &mut env.svm,
            &attacker,
            &[],
            &[withdraw_ix(
                attacker.pubkey(),
                env.strategy_account,
                env.mint,
                env.strategy_token,
                destination,
                1,
            )],
        ),
        u32::from(anchor_lang::error::ErrorCode::ConstraintSeeds),
    );
    let other_mint = create_mint(&mut env.svm, &owner);
    let wrong_mint_destination = create_token_account(&mut env.svm, &owner, other_mint, recipient);
    assert_custom(
        send(
            &mut env.svm,
            &owner,
            &[],
            &[withdraw_ix(
                owner.pubkey(),
                env.strategy_account,
                env.mint,
                env.strategy_token,
                wrong_mint_destination,
                1,
            )],
        ),
        u32::from(anchor_lang::error::ErrorCode::ConstraintTokenMint),
    );
    assert_custom(
        send(
            &mut env.svm,
            &owner,
            &[],
            &[withdraw_ix(
                owner.pubkey(),
                env.strategy_account,
                env.mint,
                env.owner_token,
                destination,
                1,
            )],
        ),
        u32::from(anchor_lang::error::ErrorCode::ConstraintTokenOwner),
    );
    let (_, vault_a) = inventory_addresses(&env, PACKAGE_A);
    assert_custom(
        send(
            &mut env.svm,
            &owner,
            &[],
            &[withdraw_ix(
                owner.pubkey(),
                env.strategy_account,
                env.mint,
                vault_a,
                destination,
                1,
            )],
        ),
        u32::from(anchor_lang::error::ErrorCode::ConstraintTokenOwner),
    );

    send(
        &mut env.svm,
        &owner,
        &[],
        &[withdraw_ix(
            owner.pubkey(),
            env.strategy_account,
            env.mint,
            env.strategy_token,
            destination,
            FUNDED_ATOMS,
        )],
    )
    .unwrap();
    assert_eq!(balance(&env.svm, env.strategy_token), 0);
    assert_eq!(balance(&env.svm, destination), FUNDED_ATOMS);
}

#[test]
fn exited_package_can_be_entered_again() {
    let mut env = setup();
    enter(&mut env, PACKAGE_A, 300, [0x31; 32]);
    exit(&mut env, PACKAGE_A, 300, [0x31; 32], true).unwrap();
    let closed = position(&env, PACKAGE_A);
    assert!(!closed.active && closed.package_id == [0u8; 32]);

    enter(&mut env, PACKAGE_A, 500, [0x32; 32]);
    let reopened = position(&env, PACKAGE_A);
    assert!(reopened.active);
    assert_eq!(reopened.package_id, PACKAGE_A);
    assert_eq!(reopened.state_hash, [0x32; 32]);
    assert_eq!(strategy_account(&env).open_package_count, 1);
}

#[test]
fn exit_cannot_release_another_package_inventory() {
    let mut env = setup();
    enter(&mut env, PACKAGE_A, 100, [0x31; 32]);
    enter(&mut env, PACKAGE_B, 200, [0x41; 32]);
    let (_, vault_b) = inventory_addresses(&env, PACKAGE_B);

    let foreign = inventory_call(&env, PACKAGE_B, RELEASE, 200, 200, false);
    let execution = execution(
        &env,
        PACKAGE_A,
        StrategyOperation::Exit,
        [0x31; 32],
        [0u8; 32],
        200,
        true,
    );
    assert_custom(
        execute(&mut env, execution, foreign),
        u32::from(InventoryError::PackageMismatch),
    );
    assert_eq!(balance(&env.svm, vault_b), 200);

    exit(&mut env, PACKAGE_A, 100, [0x31; 32], true).unwrap();
    assert_eq!(balance(&env.svm, env.strategy_token), FUNDED_ATOMS - 200);
    assert_eq!(balance(&env.svm, vault_b), 200);
}

#[test]
fn risk_increasing_leg_cannot_run_under_a_reducing_label() {
    let mut env = setup();
    enter(&mut env, PACKAGE_A, 100, [0x31; 32]);
    let (_, vault_a) = inventory_addresses(&env, PACKAGE_A);

    let mislabelled = inventory_call(&env, PACKAGE_A, LOCK, 900, 100, false);
    let execution = execution(
        &env,
        PACKAGE_A,
        StrategyOperation::Decrease,
        [0x31; 32],
        [0x33; 32],
        900,
        true,
    );
    assert_custom(
        execute(&mut env, execution, mislabelled),
        u32::from(InventoryError::RiskDirectionMismatch),
    );
    assert_eq!(balance(&env.svm, vault_a), 100);

    exit(&mut env, PACKAGE_A, 100, [0x31; 32], true).unwrap();
    assert_eq!(balance(&env.svm, vault_a), 0);
    assert_eq!(balance(&env.svm, env.strategy_token), FUNDED_ATOMS);
}

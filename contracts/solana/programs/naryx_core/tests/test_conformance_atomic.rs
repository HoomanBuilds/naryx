#![cfg(feature = "conformance")]

use {
    anchor_lang::{
        prelude::{Clock, Pubkey},
        solana_program::{
            bpf_loader_upgradeable::{get_program_data_address, UpgradeableLoaderState},
            instruction::Instruction,
            program_pack::Pack,
            system_instruction,
        },
        AccountDeserialize, InstructionData, ToAccountMetas,
    },
    anchor_spl::token::{
        spl_token::{self, state::Account as SplAccount, state::Mint},
        ID as TOKEN_PROGRAM_ID,
    },
    litesvm::{
        types::{FailedTransactionMetadata, TransactionMetadata},
        LiteSVM,
    },
    naryx_conformance_venue::{
        constants::{
            MARKET_SEED, PERP_QUOTE_VAULT_SEED, POSITION_SEED, SPOT_BASE_VAULT_SEED,
            SPOT_QUOTE_VAULT_SEED,
        },
        state::PerpPosition,
    },
    naryx_core::{
        constants::{CONFORMANCE_RECEIPT_SEED, PROTOCOL_CONFIG_SEED},
        error::ErrorCode,
        instructions::{
            execute_conformance_atomic::execution_digest, ConformanceAction,
            ConformanceExecutionArgs, GovernanceRoles,
        },
        state::{ConformanceExecutionReceipt, ProtocolConfig},
        wire::HASH_BYTE_LENGTH,
    },
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::{versioned::VersionedTransaction, InstructionError, TransactionError},
};

const CONFIG_DELAY_SLOTS: u64 = 2;
const DOMAIN_HASH: [u8; HASH_BYTE_LENGTH] = [0x44; HASH_BYTE_LENGTH];

type TransactionResult = Result<TransactionMetadata, Box<FailedTransactionMetadata>>;

struct Env {
    svm: LiteSVM,
    payer: Keypair,
    trader: Keypair,
    proposer: Keypair,
    executor: Keypair,
    solver: Keypair,
    pauser: Keypair,
    config: Pubkey,
    solver_registry: Pubkey,
    base_mint: Pubkey,
    market: Pubkey,
    position: Pubkey,
    trader_base: Pubkey,
    trader_quote: Pubkey,
    spot_base_vault: Pubkey,
    spot_quote_vault: Pubkey,
    perp_quote_vault: Pubkey,
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

fn venue_ix<A: ToAccountMetas, D: InstructionData>(accounts: A, data: D) -> Instruction {
    Instruction::new_with_bytes(
        naryx_conformance_venue::id(),
        &data.data(),
        accounts.to_account_metas(None),
    )
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
        0,
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

fn mint_to(svm: &mut LiteSVM, payer: &Keypair, mint: Pubkey, account: Pubkey, amount: u64) {
    let instruction = spl_token::instruction::mint_to(
        &TOKEN_PROGRAM_ID,
        &mint,
        &account,
        &payer.pubkey(),
        &[],
        amount,
    )
    .unwrap();
    send(svm, payer, &[], &[instruction]).unwrap();
}

fn token_balance(svm: &LiteSVM, address: Pubkey) -> u64 {
    let account = svm.get_account(&address).unwrap();
    SplAccount::unpack(&account.data).unwrap().amount
}

fn read_position(svm: &LiteSVM, address: Pubkey) -> PerpPosition {
    let account = svm.get_account(&address).unwrap();
    PerpPosition::try_deserialize(&mut account.data.as_slice()).unwrap()
}

fn read_config(svm: &LiteSVM, address: Pubkey) -> ProtocolConfig {
    let account = svm.get_account(&address).unwrap();
    ProtocolConfig::try_deserialize(&mut account.data.as_slice()).unwrap()
}

fn read_receipt(svm: &LiteSVM, address: Pubkey) -> ConformanceExecutionReceipt {
    let account = svm.get_account(&address).unwrap();
    ConformanceExecutionReceipt::try_deserialize(&mut account.data.as_slice()).unwrap()
}

fn receipt_address(trader: Pubkey, order_hash: [u8; 32]) -> Pubkey {
    Pubkey::find_program_address(
        &[
            CONFORMANCE_RECEIPT_SEED,
            trader.as_ref(),
            order_hash.as_ref(),
        ],
        &naryx_core::id(),
    )
    .0
}

fn setup(unpause_entry: bool) -> Env {
    let mut svm = LiteSVM::new();
    svm.add_program(
        naryx_core::id(),
        include_bytes!("../../../target/deploy/naryx_core.so"),
    )
    .unwrap();
    svm.add_program(
        naryx_conformance_venue::id(),
        include_bytes!("../../../target/deploy/naryx_conformance_venue.so"),
    )
    .unwrap();

    let payer = Keypair::new();
    let trader = Keypair::new();
    let proposer = Keypair::new();
    let canceller = Keypair::new();
    let executor = Keypair::new();
    let solver = Keypair::new();
    let pauser = Keypair::new();
    for signer in [&payer, &trader, &proposer, &canceller, &executor, &pauser] {
        svm.airdrop(&signer.pubkey(), 2_000_000_000).unwrap();
    }

    let program_data = get_program_data_address(&naryx_core::id());
    let mut program_data_account = svm.get_account(&program_data).unwrap();
    program_data_account
        .serialize_data(&UpgradeableLoaderState::ProgramData {
            slot: 0,
            upgrade_authority_address: Some(payer.pubkey()),
        })
        .unwrap();
    svm.set_account(program_data, program_data_account).unwrap();

    let (config, _) = Pubkey::find_program_address(&[PROTOCOL_CONFIG_SEED], &naryx_core::id());
    let (solver_registry, _) = Pubkey::find_program_address(
        &[naryx_core::constants::SOLVER_REGISTRY_SEED],
        &naryx_core::id(),
    );
    let initialize_core = core_ix(
        naryx_core::accounts::Initialize {
            payer: payer.pubkey(),
            initializer: payer.pubkey(),
            program: naryx_core::id(),
            program_data,
            config,
            system_program: anchor_lang::system_program::ID,
        },
        naryx_core::instruction::Initialize {
            environment: "localnet".to_string(),
            domain_id: "solana:localnet:naryx-core-v1".to_string(),
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
    send(&mut svm, &payer, &[], &[initialize_core]).unwrap();

    let base_mint = create_mint(&mut svm, &payer);
    let quote_mint = create_mint(&mut svm, &payer);
    let trader_base = create_token_account(&mut svm, &payer, base_mint, trader.pubkey());
    let trader_quote = create_token_account(&mut svm, &payer, quote_mint, trader.pubkey());
    let (market, _) = Pubkey::find_program_address(
        &[
            MARKET_SEED,
            payer.pubkey().as_ref(),
            base_mint.as_ref(),
            quote_mint.as_ref(),
        ],
        &naryx_conformance_venue::id(),
    );
    let (spot_base_vault, _) = Pubkey::find_program_address(
        &[SPOT_BASE_VAULT_SEED, market.as_ref()],
        &naryx_conformance_venue::id(),
    );
    let (spot_quote_vault, _) = Pubkey::find_program_address(
        &[SPOT_QUOTE_VAULT_SEED, market.as_ref()],
        &naryx_conformance_venue::id(),
    );
    let (perp_quote_vault, _) = Pubkey::find_program_address(
        &[PERP_QUOTE_VAULT_SEED, market.as_ref()],
        &naryx_conformance_venue::id(),
    );
    let initialize_market = venue_ix(
        naryx_conformance_venue::accounts::InitializeMarket {
            admin: payer.pubkey(),
            base_mint,
            quote_mint,
            market,
            spot_base_vault,
            spot_quote_vault,
            perp_quote_vault,
            token_program: TOKEN_PROGRAM_ID,
            system_program: anchor_lang::system_program::ID,
        },
        naryx_conformance_venue::instruction::InitializeMarket {
            price_quote_atoms: 3,
            price_base_atoms: 2,
            spot_fee_bps: 100,
            initial_margin_bps: 2_000,
            max_spot_base_atoms: 10,
            max_perp_base_atoms: 10,
        },
    );
    send(&mut svm, &payer, &[], &[initialize_market]).unwrap();
    mint_to(&mut svm, &payer, base_mint, spot_base_vault, 100);
    mint_to(&mut svm, &payer, quote_mint, spot_quote_vault, 100);
    mint_to(&mut svm, &payer, base_mint, trader_base, 10);
    mint_to(&mut svm, &payer, quote_mint, trader_quote, 100);

    let (position, _) = Pubkey::find_program_address(
        &[POSITION_SEED, market.as_ref(), trader.pubkey().as_ref()],
        &naryx_conformance_venue::id(),
    );
    let initialize_position = venue_ix(
        naryx_conformance_venue::accounts::InitializePosition {
            trader: trader.pubkey(),
            market,
            position,
            system_program: anchor_lang::system_program::ID,
        },
        naryx_conformance_venue::instruction::InitializePosition {},
    );
    send(&mut svm, &payer, &[&trader], &[initialize_position]).unwrap();

    let mut env = Env {
        svm,
        payer,
        trader,
        proposer,
        executor,
        solver,
        pauser,
        config,
        solver_registry,
        base_mint,
        market,
        position,
        trader_base,
        trader_quote,
        spot_base_vault,
        spot_quote_vault,
        perp_quote_vault,
    };
    env.register_solver();
    if unpause_entry {
        env.unpause_entry();
    }
    env
}

impl Env {
    fn register_solver(&mut self) {
        self.svm.warp_to_slot(50);
        let propose = core_ix(
            naryx_core::accounts::ProposeSolver {
                proposer: self.proposer.pubkey(),
                config: self.config,
                registry: self.solver_registry,
                system_program: anchor_lang::system_program::ID,
            },
            naryx_core::instruction::ProposeSolver {
                key: self.solver.pubkey(),
            },
        );
        send(&mut self.svm, &self.payer, &[&self.proposer], &[propose]).unwrap();
        self.svm.warp_to_slot(50 + CONFIG_DELAY_SLOTS);
        let activate = core_ix(
            naryx_core::accounts::ActivateSolver {
                executor: self.executor.pubkey(),
                config: self.config,
                registry: self.solver_registry,
            },
            naryx_core::instruction::ActivateSolver {
                key: self.solver.pubkey(),
            },
        );
        send(&mut self.svm, &self.payer, &[&self.executor], &[activate]).unwrap();
    }

    fn unpause_entry(&mut self) {
        self.svm.warp_to_slot(100);
        let schedule = core_ix(
            naryx_core::accounts::ScheduleUnpause {
                proposer: self.proposer.pubkey(),
                config: self.config,
            },
            naryx_core::instruction::ScheduleUnpause {},
        );
        send(&mut self.svm, &self.payer, &[&self.proposer], &[schedule]).unwrap();
        self.svm.warp_to_slot(100 + CONFIG_DELAY_SLOTS);
        let activate = core_ix(
            naryx_core::accounts::ActivateUnpause {
                executor: self.executor.pubkey(),
                config: self.config,
            },
            naryx_core::instruction::ActivateUnpause {},
        );
        send(&mut self.svm, &self.payer, &[&self.executor], &[activate]).unwrap();
        assert!(!read_config(&self.svm, self.config).entry_paused);
    }

    fn pause_entry(&mut self) {
        let pause = core_ix(
            naryx_core::accounts::PauseEntry {
                pauser: self.pauser.pubkey(),
                config: self.config,
            },
            naryx_core::instruction::PauseEntry {},
        );
        send(&mut self.svm, &self.payer, &[&self.pauser], &[pause]).unwrap();
    }

    fn execution_ix(
        &self,
        order_hash: [u8; 32],
        action: ConformanceAction,
        spot_quote_limit_atoms: u64,
        collateral_quote_limit_atoms: u64,
        expiry_slot: u64,
    ) -> Vec<Instruction> {
        self.execution_ix_with(
            order_hash,
            action,
            2,
            spot_quote_limit_atoms,
            collateral_quote_limit_atoms,
            expiry_slot,
            u64::from(order_hash[0]),
        )
    }

    fn execution_ix_with(
        &self,
        order_hash: [u8; 32],
        action: ConformanceAction,
        base_quantity_atoms: u64,
        spot_quote_limit_atoms: u64,
        collateral_quote_limit_atoms: u64,
        expiry_slot: u64,
        nonce: u64,
    ) -> Vec<Instruction> {
        let receipt = receipt_address(self.trader.pubkey(), order_hash);
        let nonce_marker = Pubkey::find_program_address(
            &[
                naryx_core::constants::CONFORMANCE_NONCE_SEED,
                self.trader.pubkey().as_ref(),
                nonce.to_be_bytes().as_ref(),
            ],
            &naryx_core::id(),
        )
        .0;
        let entry_receipt = if action == ConformanceAction::Exit {
            Some(receipt_address(self.trader.pubkey(), [0x11; 32]))
        } else {
            None
        };
        let entry = entry_receipt.map(|address| read_receipt(&self.svm, address));
        let accounts = naryx_core::accounts::ExecuteConformanceAtomic {
            trader: self.trader.pubkey(),
            config: self.config,
            solver_registry: self.solver_registry,
            receipt,
            nonce_marker,
            entry_receipt,
            market: self.market,
            position: self.position,
            trader_base: self.trader_base,
            trader_quote: self.trader_quote,
            spot_base_vault: self.spot_base_vault,
            spot_quote_vault: self.spot_quote_vault,
            perp_quote_vault: self.perp_quote_vault,
            conformance_program: naryx_conformance_venue::id(),
            token_program: TOKEN_PROGRAM_ID,
            system_program: anchor_lang::system_program::ID,
            instructions_sysvar: solana_instructions_sysvar::id(),
        };
        let args = ConformanceExecutionArgs {
            action,
            base_quantity_atoms,
            spot_quote_limit_atoms,
            collateral_quote_limit_atoms,
            expiry_slot,
            nonce,
            entry_execution_digest: entry
                .as_ref()
                .map(|receipt| receipt.execution_digest)
                .unwrap_or([0; 32]),
            expected_pre_short_base_atoms: entry
                .as_ref()
                .map(|receipt| receipt.post_short_base_atoms)
                .unwrap_or(0),
            expected_pre_collateral_quote_atoms: entry
                .as_ref()
                .map(|receipt| receipt.post_collateral_quote_atoms)
                .unwrap_or(0),
        };
        let quote_hash = [0x22; 32];
        let route_hash = [0x33; 32];
        let digest = execution_digest(
            &read_config(&self.svm, self.config).domain,
            order_hash,
            quote_hash,
            route_hash,
            args,
            &[
                naryx_core::id(),
                self.trader.pubkey(),
                self.config,
                self.solver_registry,
                self.solver.pubkey(),
                receipt,
                nonce_marker,
                entry_receipt.unwrap_or(naryx_core::id()),
                self.market,
                self.position,
                self.trader_base,
                self.trader_quote,
                self.spot_base_vault,
                self.spot_quote_vault,
                self.perp_quote_vault,
                naryx_conformance_venue::id(),
                TOKEN_PROGRAM_ID,
                anchor_lang::system_program::ID,
                solana_instructions_sysvar::id(),
            ],
        );
        let signature = self.solver.sign_message(&digest);
        let verification = solana_ed25519_program::new_ed25519_instruction_with_signature(
            &digest,
            signature.as_ref().try_into().unwrap(),
            self.solver.pubkey().as_ref().try_into().unwrap(),
        );
        let execution = core_ix(
            accounts,
            naryx_core::instruction::ExecuteConformanceAtomic {
                order_hash,
                quote_hash,
                route_hash,
                args,
            },
        );
        vec![verification, execution]
    }

    fn current_slot(&self) -> u64 {
        self.svm.get_sysvar::<Clock>().slot
    }

    fn snapshot(&self) -> (u64, u64, u64, u64, u64, u64, u64) {
        let position = read_position(&self.svm, self.position);
        (
            token_balance(&self.svm, self.trader_base),
            token_balance(&self.svm, self.trader_quote),
            token_balance(&self.svm, self.spot_base_vault),
            token_balance(&self.svm, self.spot_quote_vault),
            token_balance(&self.svm, self.perp_quote_vault),
            position.short_base_atoms,
            position.collateral_quote_atoms,
        )
    }

    fn execute(&mut self, instructions: Vec<Instruction>) -> TransactionResult {
        send(&mut self.svm, &self.payer, &[&self.trader], &instructions)
    }
}

#[test]
fn successful_entry_records_authoritative_pre_and_post_state() {
    let mut env = setup(true);
    let order_hash = [0x11; 32];
    let slot = env.current_slot();
    let instruction = env.execution_ix(order_hash, ConformanceAction::Entry, 4, 1, slot + 1);
    env.execute(instruction).unwrap();

    assert_eq!(env.snapshot(), (12, 95, 98, 104, 1, 2, 1));
    let receipt = read_receipt(&env.svm, receipt_address(env.trader.pubkey(), order_hash));
    assert_eq!(receipt.domain, read_config(&env.svm, env.config).domain);
    assert_eq!(receipt.order_hash, order_hash);
    assert_eq!(receipt.quote_hash, [0x22; 32]);
    assert_eq!(receipt.route_hash, [0x33; 32]);
    assert_eq!(receipt.trader, env.trader.pubkey());
    assert_eq!(receipt.solver, env.solver.pubkey());
    assert_eq!(receipt.nonce, 0x11);
    assert_ne!(receipt.execution_digest, [0; 32]);
    assert_eq!(receipt.action, 1);
    assert_eq!(receipt.base_quantity_atoms, 2);
    assert_eq!(receipt.pre_base_balance, 10);
    assert_eq!(receipt.post_base_balance, 12);
    assert_eq!(receipt.pre_quote_balance, 100);
    assert_eq!(receipt.post_quote_balance, 95);
    assert_eq!(receipt.pre_short_base_atoms, 0);
    assert_eq!(receipt.post_short_base_atoms, 2);
    assert_eq!(receipt.pre_collateral_quote_atoms, 0);
    assert_eq!(receipt.post_collateral_quote_atoms, 1);
    assert_eq!(receipt.execution_slot, slot);
}

#[test]
fn successful_exit_remains_available_while_entry_is_paused() {
    let mut env = setup(true);
    let entry = env.execution_ix(
        [0x11; 32],
        ConformanceAction::Entry,
        4,
        1,
        env.current_slot() + 2,
    );
    env.execute(entry).unwrap();
    env.pause_entry();

    let exit_hash = [0x12; 32];
    let exit = env.execution_ix(
        exit_hash,
        ConformanceAction::Exit,
        2,
        1,
        env.current_slot() + 1,
    );
    env.execute(exit).unwrap();

    assert_eq!(env.snapshot(), (10, 98, 100, 102, 0, 0, 0));
    let receipt = read_receipt(&env.svm, receipt_address(env.trader.pubkey(), exit_hash));
    assert_eq!(receipt.action, 2);
    assert_eq!(receipt.pre_short_base_atoms, 2);
    assert_eq!(receipt.post_short_base_atoms, 0);
}

#[test]
fn exit_cannot_replay_after_the_authoritative_position_is_closed() {
    let mut env = setup(true);
    let entry = env.execution_ix(
        [0x11; 32],
        ConformanceAction::Entry,
        4,
        1,
        env.current_slot() + 3,
    );
    env.execute(entry).unwrap();
    let exit_hash = [0x12; 32];
    let exit = env.execution_ix(
        exit_hash,
        ConformanceAction::Exit,
        2,
        1,
        env.current_slot() + 2,
    );
    env.execute(exit).unwrap();
    let closed = env.snapshot();
    let replay = env.execution_ix(
        exit_hash,
        ConformanceAction::Exit,
        2,
        1,
        env.current_slot() + 1,
    );
    assert!(env.execute(replay).is_err());
    assert_eq!(env.snapshot(), closed);
}

#[test]
fn successful_order_cannot_replay() {
    let mut env = setup(true);
    let order_hash = [0x13; 32];
    let first = env.execution_ix(
        order_hash,
        ConformanceAction::Entry,
        4,
        1,
        env.current_slot() + 2,
    );
    env.execute(first).unwrap();
    let after_first = env.snapshot();
    let replay = env.execution_ix(
        order_hash,
        ConformanceAction::Entry,
        4,
        1,
        env.current_slot() + 2,
    );
    assert!(env.execute(replay).is_err());
    assert_eq!(env.snapshot(), after_first);
}

#[test]
fn nonce_cannot_be_reused_for_another_order() {
    let mut env = setup(true);
    let expiry = env.current_slot() + 2;
    let first = env.execution_ix_with([0x71; 32], ConformanceAction::Entry, 2, 4, 1, expiry, 9);
    env.execute(first).unwrap();
    let before = env.snapshot();
    let second = env.execution_ix_with([0x72; 32], ConformanceAction::Entry, 2, 4, 1, expiry, 9);
    assert!(env.execute(second).is_err());
    assert_eq!(env.snapshot(), before);
    assert!(env
        .svm
        .get_account(&receipt_address(env.trader.pubkey(), [0x72; 32]))
        .is_none());
}

#[test]
fn solver_signature_must_match_registered_key_and_exact_digest() {
    let mut env = setup(true);
    let before = env.snapshot();
    let mut wrong_key = env.execution_ix(
        [0x81; 32],
        ConformanceAction::Entry,
        4,
        1,
        env.current_slot() + 2,
    );
    let stranger = Keypair::new();
    let digest = wrong_key[0].data[112..144].to_vec();
    wrong_key[0].data[48..112].copy_from_slice(stranger.sign_message(&digest).as_ref());
    wrong_key[0].data[16..48].copy_from_slice(stranger.pubkey().as_ref());
    let failure = env.execute(wrong_key).unwrap_err();
    // A key outside the active solver set is refused before its digest is even compared.
    assert_eq!(
        failure.err,
        TransactionError::InstructionError(
            1,
            InstructionError::Custom(u32::from(ErrorCode::ConformanceSolverInvalid))
        )
    );

    let mut wrong_digest = env.execution_ix(
        [0x82; 32],
        ConformanceAction::Entry,
        4,
        1,
        env.current_slot() + 2,
    );
    wrong_digest[0].data[112] ^= 1;
    let altered_digest = wrong_digest[0].data[112..144].to_vec();
    wrong_digest[0].data[48..112]
        .copy_from_slice(env.solver.sign_message(&altered_digest).as_ref());
    let failure = env.execute(wrong_digest).unwrap_err();
    assert_eq!(
        failure.err,
        TransactionError::InstructionError(
            1,
            InstructionError::Custom(u32::from(ErrorCode::ConformanceSignatureMismatch))
        )
    );
    assert_eq!(env.snapshot(), before);
}

#[test]
fn signature_binds_accounts_and_quantity() {
    let mut env = setup(true);
    let before = env.snapshot();
    let mut wrong_account = env.execution_ix(
        [0x83; 32],
        ConformanceAction::Entry,
        4,
        1,
        env.current_slot() + 2,
    );
    let base_index = wrong_account[1]
        .accounts
        .iter()
        .position(|meta| meta.pubkey == env.trader_base)
        .unwrap();
    let substitute_base =
        create_token_account(&mut env.svm, &env.payer, env.base_mint, env.trader.pubkey());
    wrong_account[1].accounts[base_index].pubkey = substitute_base;
    let failure = env.execute(wrong_account).unwrap_err();
    assert_eq!(
        failure.err,
        TransactionError::InstructionError(
            1,
            InstructionError::Custom(u32::from(ErrorCode::ConformanceSignatureMismatch))
        )
    );

    let mut wrong_quantity = env.execution_ix(
        [0x84; 32],
        ConformanceAction::Entry,
        4,
        1,
        env.current_slot() + 2,
    );
    wrong_quantity[1].data[105] = 3;
    let failure = env.execute(wrong_quantity).unwrap_err();
    assert_eq!(
        failure.err,
        TransactionError::InstructionError(
            1,
            InstructionError::Custom(u32::from(ErrorCode::ConformanceSignatureMismatch))
        )
    );

    let mut wrong_expiry = env.execution_ix(
        [0x87; 32],
        ConformanceAction::Entry,
        4,
        1,
        env.current_slot() + 3,
    );
    wrong_expiry[1].data[129] ^= 1;
    let failure = env.execute(wrong_expiry).unwrap_err();
    assert_eq!(
        failure.err,
        TransactionError::InstructionError(
            1,
            InstructionError::Custom(u32::from(ErrorCode::ConformanceSignatureMismatch))
        )
    );
    assert_eq!(env.snapshot(), before);
}

#[test]
fn signature_instruction_accepts_safe_local_offsets() {
    let mut env = setup(true);
    let mut instructions = env.execution_ix(
        [0x85; 32],
        ConformanceAction::Entry,
        4,
        1,
        env.current_slot() + 2,
    );
    instructions[0].data.insert(16, 0);
    for (offset, value) in [(2, 49u16), (6, 17), (10, 113)] {
        instructions[0].data[offset..offset + 2].copy_from_slice(&value.to_le_bytes());
    }
    env.execute(instructions).unwrap();
}

#[test]
fn signature_instruction_resolves_external_instruction_references() {
    let mut env = setup(true);
    let mut instructions = env.execution_ix(
        [0x89; 32],
        ConformanceAction::Entry,
        4,
        1,
        env.current_slot() + 2,
    );
    let signature_source = instructions.remove(0);
    let mut referenced_verifier = Instruction {
        program_id: solana_sdk_ids::ed25519_program::id(),
        accounts: Vec::new(),
        data: vec![1, 0],
    };
    for value in [48u16, 0, 16, 0, 112, 32, 0] {
        referenced_verifier
            .data
            .extend_from_slice(&value.to_le_bytes());
    }
    instructions.insert(0, referenced_verifier);
    instructions.insert(0, signature_source);

    env.execute(instructions).unwrap();
}

#[test]
fn solver_set_additions_wait_for_the_delay_and_removals_revoke_at_once() {
    let mut env = setup(true);
    let next_solver = Keypair::new();
    let proposal = core_ix(
        naryx_core::accounts::ProposeSolver {
            proposer: env.proposer.pubkey(),
            config: env.config,
            registry: env.solver_registry,
            system_program: anchor_lang::system_program::ID,
        },
        naryx_core::instruction::ProposeSolver {
            key: next_solver.pubkey(),
        },
    );
    let mut unauthorized = proposal.clone();
    unauthorized.accounts[0].pubkey = env.pauser.pubkey();
    assert!(send(&mut env.svm, &env.payer, &[&env.pauser], &[unauthorized]).is_err());
    send(&mut env.svm, &env.payer, &[&env.proposer], &[proposal]).unwrap();
    let activate = core_ix(
        naryx_core::accounts::ActivateSolver {
            executor: env.executor.pubkey(),
            config: env.config,
            registry: env.solver_registry,
        },
        naryx_core::instruction::ActivateSolver {
            key: next_solver.pubkey(),
        },
    );
    let failure = send(
        &mut env.svm,
        &env.payer,
        &[&env.executor],
        &[activate.clone()],
    )
    .unwrap_err();
    assert_eq!(
        failure.err,
        TransactionError::InstructionError(
            0,
            InstructionError::Custom(u32::from(ErrorCode::ConformanceSolverProposalNotReady))
        )
    );
    env.svm
        .warp_to_slot(env.current_slot() + CONFIG_DELAY_SLOTS);
    send(&mut env.svm, &env.payer, &[&env.executor], &[activate]).unwrap();

    // Removing a solver needs the pauser and takes effect at once.
    let remove = core_ix(
        naryx_core::accounts::RemoveSolver {
            pauser: env.pauser.pubkey(),
            config: env.config,
            registry: env.solver_registry,
        },
        naryx_core::instruction::RemoveSolver {
            key: env.solver.pubkey(),
        },
    );
    let mut unauthorized_removal = remove.clone();
    unauthorized_removal.accounts[0].pubkey = env.executor.pubkey();
    assert!(send(
        &mut env.svm,
        &env.payer,
        &[&env.executor],
        &[unauthorized_removal]
    )
    .is_err());
    send(&mut env.svm, &env.payer, &[&env.pauser], &[remove]).unwrap();

    let stale = env.execution_ix(
        [0x86; 32],
        ConformanceAction::Entry,
        4,
        1,
        env.current_slot() + 1,
    );
    let failure = env.execute(stale).unwrap_err();
    assert_eq!(
        failure.err,
        TransactionError::InstructionError(
            1,
            InstructionError::Custom(u32::from(ErrorCode::ConformanceSolverInvalid))
        )
    );

    // The added solver settles with its own signature.
    env.solver = next_solver;
    let fresh = env.execution_ix(
        [0x87; 32],
        ConformanceAction::Entry,
        4,
        1,
        env.current_slot() + 1,
    );
    env.execute(fresh).unwrap();
}

#[test]
fn signature_binds_active_domain_reference() {
    let mut env = setup(true);
    let signed = env.execution_ix(
        [0x88; 32],
        ConformanceAction::Entry,
        4,
        1,
        env.current_slot() + 10,
    );
    let propose = core_ix(
        naryx_core::accounts::ProposeDomain {
            proposer: env.proposer.pubkey(),
            config: env.config,
        },
        naryx_core::instruction::ProposeDomain {
            domain_manifest_version: 2,
            domain_manifest_hash: [0x55; 32],
        },
    );
    send(&mut env.svm, &env.payer, &[&env.proposer], &[propose]).unwrap();
    env.svm
        .warp_to_slot(env.current_slot() + CONFIG_DELAY_SLOTS);
    let activate = core_ix(
        naryx_core::accounts::ActivateDomain {
            executor: env.executor.pubkey(),
            config: env.config,
        },
        naryx_core::instruction::ActivateDomain {},
    );
    send(&mut env.svm, &env.payer, &[&env.executor], &[activate]).unwrap();
    let failure = env.execute(signed).unwrap_err();
    assert_eq!(
        failure.err,
        TransactionError::InstructionError(
            1,
            InstructionError::Custom(u32::from(ErrorCode::ConformanceSignatureMismatch))
        )
    );
}

#[test]
fn half_open_expiry_rejects_the_current_slot_without_state() {
    let mut env = setup(true);
    let order_hash = [0x14; 32];
    let before = env.snapshot();
    let expired = env.execution_ix(
        order_hash,
        ConformanceAction::Entry,
        4,
        1,
        env.current_slot(),
    );
    let failure = env.execute(expired).unwrap_err();
    assert_eq!(
        failure.err,
        TransactionError::InstructionError(
            1,
            InstructionError::Custom(u32::from(ErrorCode::ConformanceOrderExpired))
        )
    );
    assert_eq!(env.snapshot(), before);
    assert!(env
        .svm
        .get_account(&receipt_address(env.trader.pubkey(), order_hash))
        .is_none());
}

#[test]
fn entry_pause_rejects_entry_without_blocking_exit_semantics() {
    let mut env = setup(false);
    let order_hash = [0x15; 32];
    let before = env.snapshot();
    let entry = env.execution_ix(
        order_hash,
        ConformanceAction::Entry,
        4,
        1,
        env.current_slot() + 1,
    );
    let failure = env.execute(entry).unwrap_err();
    assert_eq!(
        failure.err,
        TransactionError::InstructionError(
            1,
            InstructionError::Custom(u32::from(ErrorCode::ConformanceEntryPaused))
        )
    );
    assert_eq!(env.snapshot(), before);
    assert!(env
        .svm
        .get_account(&receipt_address(env.trader.pubkey(), order_hash))
        .is_none());
}

#[test]
fn second_leg_failure_rolls_back_first_leg_and_receipt_creation() {
    let mut env = setup(true);
    let order_hash = [0x16; 32];
    let before = env.snapshot();
    let fails_second_leg = env.execution_ix(
        order_hash,
        ConformanceAction::Entry,
        4,
        0,
        env.current_slot() + 1,
    );
    assert!(env.execute(fails_second_leg).is_err());
    assert_eq!(env.snapshot(), before);
    assert!(env
        .svm
        .get_account(&receipt_address(env.trader.pubkey(), order_hash))
        .is_none());
}

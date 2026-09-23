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
        instructions::{ConformanceAction, ConformanceExecutionArgs, GovernanceRoles},
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
    pauser: Keypair,
    config: Pubkey,
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
        pauser,
        config,
        market,
        position,
        trader_base,
        trader_quote,
        spot_base_vault,
        spot_quote_vault,
        perp_quote_vault,
    };
    if unpause_entry {
        env.unpause_entry();
    }
    env
}

impl Env {
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
    ) -> Instruction {
        core_ix(
            naryx_core::accounts::ExecuteConformanceAtomic {
                trader: self.trader.pubkey(),
                config: self.config,
                receipt: receipt_address(self.trader.pubkey(), order_hash),
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
            },
            naryx_core::instruction::ExecuteConformanceAtomic {
                order_hash,
                quote_hash: [0x22; 32],
                route_hash: [0x33; 32],
                args: ConformanceExecutionArgs {
                    action,
                    base_quantity_atoms: 2,
                    spot_quote_limit_atoms,
                    collateral_quote_limit_atoms,
                    expiry_slot,
                },
            },
        )
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

    fn execute(&mut self, instruction: Instruction) -> TransactionResult {
        send(&mut self.svm, &self.payer, &[&self.trader], &[instruction])
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
    assert_eq!(receipt.order_hash, order_hash);
    assert_eq!(receipt.quote_hash, [0x22; 32]);
    assert_eq!(receipt.route_hash, [0x33; 32]);
    assert_eq!(receipt.trader, env.trader.pubkey());
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
            0,
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
            0,
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

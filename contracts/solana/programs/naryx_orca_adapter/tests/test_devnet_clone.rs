use {
    anchor_lang::{
        prelude::{Clock, Pubkey},
        solana_program::{instruction::Instruction, program_pack::Pack},
        InstructionData, ToAccountMetas,
    },
    anchor_spl::token::{
        spl_token::state::{Account as SplAccount, AccountState},
        ID as TOKEN_PROGRAM_ID,
    },
    litesvm::{
        types::{FailedTransactionMetadata, TransactionMetadata},
        LiteSVM,
    },
    naryx_orca_adapter::constants::ORCA_WHIRLPOOL_PROGRAM_ID,
    solana_account::Account,
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
    std::{env, fs, path::PathBuf},
};

const WHIRLPOOL: &str = "B9G57dSEh9hmMLGkCgyfSpvzuir52pPppsRapfZwSZwc";
const TOKEN_MINT_A: &str = "d7W9C9hdBzrxZ4oURnEYJQYJzrSRXcPX2KbVCt6JPH4";
const TOKEN_MINT_B: &str = "6vsWi38sVMw3wkJoZrhtGwSVv6kYCjnDREGgED9Nxq1J";
const TOKEN_VAULT_A: &str = "HHu5Gjyp9RJMYKPfJ3SizvLMGQXLRJJ8SYKLYwkGpvX9";
const TOKEN_VAULT_B: &str = "BeY7NwznDroBP3m2KVugptGnoR2XPPK5zeVpQg7fPk8K";
const TICK_ARRAY_0: &str = "BsomkG4EHvBr49gpth27FckZvr7wvmPYxXibKJtJsHNd";
const TICK_ARRAY_1: &str = "4h7gTPfCjVTqMpBth9SBnc63K91ycSt4iQkxYiCFRBTY";
type TransactionResult = Result<TransactionMetadata, Box<FailedTransactionMetadata>>;

fn address(value: &str) -> Pubkey {
    value.parse().unwrap()
}

fn fixture_path(name: &str) -> PathBuf {
    PathBuf::from(env::var("ORCA_DEVNET_FIXTURE_DIR").unwrap()).join(name)
}

fn fixture_number<T: std::str::FromStr>(name: &str) -> T
where
    T::Err: std::fmt::Debug,
{
    fs::read_to_string(fixture_path(name))
        .unwrap()
        .trim()
        .parse()
        .unwrap()
}

fn cloned_account(name: &str, owner: Pubkey, lamports: u64) -> Account {
    Account {
        lamports,
        data: fs::read(fixture_path(name)).unwrap(),
        owner,
        executable: false,
        rent_epoch: u64::MAX,
    }
}

fn token_account(mint: Pubkey, owner: Pubkey, amount: u64, lamports: u64) -> Account {
    let mut data = vec![0; SplAccount::LEN];
    SplAccount::pack(
        SplAccount {
            mint,
            owner,
            amount,
            delegate: None.into(),
            state: AccountState::Initialized,
            is_native: None.into(),
            delegated_amount: 0,
            close_authority: None.into(),
        },
        &mut data,
    )
    .unwrap();
    Account {
        lamports,
        data,
        owner: TOKEN_PROGRAM_ID,
        executable: false,
        rent_epoch: u64::MAX,
    }
}

fn send(
    svm: &mut LiteSVM,
    payer: &Keypair,
    signers: &[&Keypair],
    instruction: Instruction,
) -> TransactionResult {
    svm.expire_blockhash();
    let message = Message::new_with_blockhash(
        &[instruction],
        Some(&payer.pubkey()),
        &svm.latest_blockhash(),
    );
    let mut all_signers = vec![payer];
    all_signers.extend_from_slice(signers);
    let transaction =
        VersionedTransaction::try_new(VersionedMessage::Legacy(message), &all_signers).unwrap();
    svm.send_transaction(transaction).map_err(Box::new)
}

fn balance(svm: &LiteSVM, account: Pubkey) -> u64 {
    SplAccount::unpack(&svm.get_account(&account).unwrap().data)
        .unwrap()
        .amount
}

fn assert_failed_with_log(result: TransactionResult, expected: &str) {
    let failure = result.expect_err("transaction should fail");
    assert!(failure.meta.logs.iter().any(|log| log.contains(expected)));
}

fn setup() -> (LiteSVM, Keypair, Keypair, Pubkey, Pubkey) {
    let mut svm = LiteSVM::new();
    svm.add_program(
        naryx_orca_adapter::id(),
        include_bytes!("../../../target/deploy/naryx_orca_adapter.so"),
    )
    .unwrap();
    svm.add_program_from_file(ORCA_WHIRLPOOL_PROGRAM_ID, fixture_path("orca-devnet.so"))
        .unwrap();
    svm.set_sysvar(&Clock {
        slot: fixture_number("context-slot"),
        unix_timestamp: fixture_number("unix-timestamp"),
        ..Clock::default()
    });

    let payer = Keypair::new();
    let trader = Keypair::new();
    svm.airdrop(&payer.pubkey(), 2_000_000_000).unwrap();
    let whirlpool = address(WHIRLPOOL);
    let tick_array_0 = address(TICK_ARRAY_0);
    let tick_array_1 = address(TICK_ARRAY_1);
    let vault_a = address(TOKEN_VAULT_A);
    let vault_b = address(TOKEN_VAULT_B);
    svm.set_account(
        whirlpool,
        cloned_account("whirlpool.bin", ORCA_WHIRLPOOL_PROGRAM_ID, 5_435_760),
    )
    .unwrap();
    svm.set_account(
        tick_array_0,
        cloned_account("tick0.bin", ORCA_WHIRLPOOL_PROGRAM_ID, 70_407_360),
    )
    .unwrap();
    svm.set_account(
        tick_array_1,
        cloned_account("tick1.bin", ORCA_WHIRLPOOL_PROGRAM_ID, 70_407_360),
    )
    .unwrap();
    svm.set_account(
        vault_a,
        cloned_account("vault-a.bin", TOKEN_PROGRAM_ID, 2_039_280),
    )
    .unwrap();
    svm.set_account(
        vault_b,
        cloned_account("vault-b.bin", TOKEN_PROGRAM_ID, 2_039_280),
    )
    .unwrap();

    let trader_a = Pubkey::new_unique();
    let trader_b = Pubkey::new_unique();
    svm.set_account(
        trader_a,
        token_account(address(TOKEN_MINT_A), trader.pubkey(), 1_000, 2_039_280),
    )
    .unwrap();
    svm.set_account(
        trader_b,
        token_account(address(TOKEN_MINT_B), trader.pubkey(), 0, 2_039_280),
    )
    .unwrap();
    (svm, payer, trader, trader_a, trader_b)
}

fn exact_input_instruction(
    trader: Pubkey,
    trader_a: Pubkey,
    trader_b: Pubkey,
    minimum_amount_out: u64,
) -> Instruction {
    let whirlpool = address(WHIRLPOOL);
    let tick_array_0 = address(TICK_ARRAY_0);
    let tick_array_1 = address(TICK_ARRAY_1);
    let oracle =
        Pubkey::find_program_address(&[b"oracle", whirlpool.as_ref()], &ORCA_WHIRLPOOL_PROGRAM_ID)
            .0;
    Instruction::new_with_bytes(
        naryx_orca_adapter::id(),
        &naryx_orca_adapter::instruction::SwapExactInput {
            amount_in: 100,
            minimum_amount_out,
            sqrt_price_limit: 0,
            a_to_b: true,
        }
        .data(),
        naryx_orca_adapter::accounts::SwapOrca {
            token_authority: trader,
            token_owner_account_a: trader_a,
            token_owner_account_b: trader_b,
            token_vault_a: address(TOKEN_VAULT_A),
            token_vault_b: address(TOKEN_VAULT_B),
            whirlpool,
            tick_array_0,
            tick_array_1,
            tick_array_2: tick_array_1,
            oracle,
            token_program: TOKEN_PROGRAM_ID,
            whirlpool_program: ORCA_WHIRLPOOL_PROGRAM_ID,
        }
        .to_account_metas(None),
    )
}

fn exact_output_instruction(
    trader: Pubkey,
    trader_a: Pubkey,
    trader_b: Pubkey,
    maximum_amount_in: u64,
) -> Instruction {
    let whirlpool = address(WHIRLPOOL);
    let tick_array_0 = address(TICK_ARRAY_0);
    let tick_array_1 = address(TICK_ARRAY_1);
    let oracle =
        Pubkey::find_program_address(&[b"oracle", whirlpool.as_ref()], &ORCA_WHIRLPOOL_PROGRAM_ID)
            .0;
    Instruction::new_with_bytes(
        naryx_orca_adapter::id(),
        &naryx_orca_adapter::instruction::SwapExactOutput {
            amount_out: 50,
            maximum_amount_in,
            sqrt_price_limit: 0,
            a_to_b: true,
        }
        .data(),
        naryx_orca_adapter::accounts::SwapOrca {
            token_authority: trader,
            token_owner_account_a: trader_a,
            token_owner_account_b: trader_b,
            token_vault_a: address(TOKEN_VAULT_A),
            token_vault_b: address(TOKEN_VAULT_B),
            whirlpool,
            tick_array_0,
            tick_array_1,
            tick_array_2: tick_array_1,
            oracle,
            token_program: TOKEN_PROGRAM_ID,
            whirlpool_program: ORCA_WHIRLPOOL_PROGRAM_ID,
        }
        .to_account_metas(None),
    )
}

#[test]
#[ignore = "requires read-only Orca devnet fixture files"]
fn exact_input_executes_against_cloned_orca_devnet_and_rolls_back_on_limit_failure() {
    let (mut svm, payer, trader, trader_a, trader_b) = setup();
    let result = send(
        &mut svm,
        &payer,
        &[&trader],
        exact_input_instruction(trader.pubkey(), trader_a, trader_b, u64::MAX),
    );
    assert_failed_with_log(result, "AmountOutBelowMinimum");
    assert_eq!(balance(&svm, trader_a), 1_000);
    assert_eq!(balance(&svm, trader_b), 0);

    send(
        &mut svm,
        &payer,
        &[&trader],
        exact_input_instruction(trader.pubkey(), trader_a, trader_b, 1),
    )
    .unwrap();
    assert_eq!(balance(&svm, trader_a), 900);
    assert!(balance(&svm, trader_b) >= 1);
}

#[test]
#[ignore = "requires read-only Orca devnet fixture files"]
fn exact_output_executes_against_cloned_orca_devnet_and_rolls_back_on_limit_failure() {
    let (mut svm, payer, trader, trader_a, trader_b) = setup();
    let result = send(
        &mut svm,
        &payer,
        &[&trader],
        exact_output_instruction(trader.pubkey(), trader_a, trader_b, 1),
    );
    assert_failed_with_log(result, "AmountInAboveMaximum");
    assert_eq!(balance(&svm, trader_a), 1_000);
    assert_eq!(balance(&svm, trader_b), 0);

    send(
        &mut svm,
        &payer,
        &[&trader],
        exact_output_instruction(trader.pubkey(), trader_a, trader_b, 100),
    )
    .unwrap();
    assert!(1_000 - balance(&svm, trader_a) <= 100);
    assert_eq!(balance(&svm, trader_b), 50);
}

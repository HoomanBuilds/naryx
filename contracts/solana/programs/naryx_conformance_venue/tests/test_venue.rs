use {
    anchor_lang::{
        prelude::Pubkey,
        solana_program::{instruction::Instruction, program_pack::Pack, system_instruction},
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
        error::ErrorCode,
        math::{mul_div_ceil, mul_div_floor, validate_market_parameters},
        state::PerpPosition,
    },
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::{versioned::VersionedTransaction, InstructionError, TransactionError},
};

type TransactionResult = Result<TransactionMetadata, Box<FailedTransactionMetadata>>;

struct Env {
    svm: LiteSVM,
    admin: Keypair,
    trader: Keypair,
    outsider: Keypair,
    trader_base: Pubkey,
    trader_quote: Pubkey,
    wrong_base: Pubkey,
    market: Pubkey,
    spot_base_vault: Pubkey,
    spot_quote_vault: Pubkey,
    perp_quote_vault: Pubkey,
    position: Pubkey,
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

fn build_ix<A: ToAccountMetas, D: InstructionData>(accounts: A, data: D) -> Instruction {
    Instruction::new_with_bytes(
        naryx_conformance_venue::id(),
        &data.data(),
        accounts.to_account_metas(None),
    )
}

fn create_mint(svm: &mut LiteSVM, payer: &Keypair) -> Keypair {
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
    mint
}

fn create_token_account(
    svm: &mut LiteSVM,
    payer: &Keypair,
    mint: Pubkey,
    owner: Pubkey,
) -> Keypair {
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
    account
}

fn mint_to(svm: &mut LiteSVM, admin: &Keypair, mint: Pubkey, account: Pubkey, amount: u64) {
    let instruction = spl_token::instruction::mint_to(
        &TOKEN_PROGRAM_ID,
        &mint,
        &account,
        &admin.pubkey(),
        &[],
        amount,
    )
    .unwrap();
    send(svm, admin, &[], &[instruction]).unwrap();
}

fn token_balance(svm: &LiteSVM, address: Pubkey) -> u64 {
    let account = svm.get_account(&address).unwrap();
    SplAccount::unpack(&account.data).unwrap().amount
}

fn position(svm: &LiteSVM, address: Pubkey) -> PerpPosition {
    let account = svm.get_account(&address).unwrap();
    PerpPosition::try_deserialize(&mut account.data.as_slice()).unwrap()
}

fn assert_custom_error(result: TransactionResult, expected: ErrorCode) {
    let failure = result.expect_err("transaction should fail");
    assert_eq!(
        failure.err,
        TransactionError::InstructionError(0, InstructionError::Custom(u32::from(expected)))
    );
}

fn setup() -> Env {
    let mut svm = LiteSVM::new();
    svm.add_program(
        naryx_conformance_venue::id(),
        include_bytes!("../../../target/deploy/naryx_conformance_venue.so"),
    )
    .unwrap();
    let admin = Keypair::new();
    let trader = Keypair::new();
    let outsider = Keypair::new();
    for signer in [&admin, &trader, &outsider] {
        svm.airdrop(&signer.pubkey(), 2_000_000_000).unwrap();
    }

    let base_mint_keypair = create_mint(&mut svm, &admin);
    let quote_mint_keypair = create_mint(&mut svm, &admin);
    let base_mint = base_mint_keypair.pubkey();
    let quote_mint = quote_mint_keypair.pubkey();
    let trader_base_keypair = create_token_account(&mut svm, &admin, base_mint, trader.pubkey());
    let trader_quote_keypair = create_token_account(&mut svm, &admin, quote_mint, trader.pubkey());
    let wrong_base_keypair = create_token_account(&mut svm, &admin, quote_mint, trader.pubkey());
    let trader_base = trader_base_keypair.pubkey();
    let trader_quote = trader_quote_keypair.pubkey();
    let wrong_base = wrong_base_keypair.pubkey();

    let (market, _) = Pubkey::find_program_address(
        &[
            MARKET_SEED,
            admin.pubkey().as_ref(),
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
    let initialize_market = build_ix(
        naryx_conformance_venue::accounts::InitializeMarket {
            admin: admin.pubkey(),
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
    send(&mut svm, &admin, &[], &[initialize_market]).unwrap();

    mint_to(&mut svm, &admin, base_mint, spot_base_vault, 100);
    mint_to(&mut svm, &admin, quote_mint, spot_quote_vault, 100);
    mint_to(&mut svm, &admin, base_mint, trader_base, 10);
    mint_to(&mut svm, &admin, quote_mint, trader_quote, 10);

    let (position, _) = Pubkey::find_program_address(
        &[POSITION_SEED, market.as_ref(), trader.pubkey().as_ref()],
        &naryx_conformance_venue::id(),
    );
    let initialize_position = build_ix(
        naryx_conformance_venue::accounts::InitializePosition {
            trader: trader.pubkey(),
            market,
            position,
            system_program: anchor_lang::system_program::ID,
        },
        naryx_conformance_venue::instruction::InitializePosition {},
    );
    send(&mut svm, &admin, &[&trader], &[initialize_position]).unwrap();

    Env {
        svm,
        admin,
        trader,
        outsider,
        trader_base,
        trader_quote,
        wrong_base,
        market,
        spot_base_vault,
        spot_quote_vault,
        perp_quote_vault,
        position,
    }
}

impl Env {
    fn buy_ix(&self, base_atoms_out: u64, max_quote_atoms_in: u64) -> Instruction {
        build_ix(
            naryx_conformance_venue::accounts::SpotBuyExactOutput {
                trader: self.trader.pubkey(),
                market: self.market,
                trader_base: self.trader_base,
                trader_quote: self.trader_quote,
                spot_base_vault: self.spot_base_vault,
                spot_quote_vault: self.spot_quote_vault,
                token_program: TOKEN_PROGRAM_ID,
            },
            naryx_conformance_venue::instruction::SpotBuyExactOutput {
                base_atoms_out,
                max_quote_atoms_in,
            },
        )
    }

    fn sell_ix(&self, base_atoms_in: u64, min_quote_atoms_out: u64) -> Instruction {
        build_ix(
            naryx_conformance_venue::accounts::SpotSellExactInput {
                trader: self.trader.pubkey(),
                market: self.market,
                trader_base: self.trader_base,
                trader_quote: self.trader_quote,
                spot_base_vault: self.spot_base_vault,
                spot_quote_vault: self.spot_quote_vault,
                token_program: TOKEN_PROGRAM_ID,
            },
            naryx_conformance_venue::instruction::SpotSellExactInput {
                base_atoms_in,
                min_quote_atoms_out,
            },
        )
    }

    fn open_ix(&self, base_atoms: u64, max_collateral_quote_atoms: u64) -> Instruction {
        build_ix(
            naryx_conformance_venue::accounts::OpenShortExact {
                trader: self.trader.pubkey(),
                market: self.market,
                position: self.position,
                trader_quote: self.trader_quote,
                perp_quote_vault: self.perp_quote_vault,
                token_program: TOKEN_PROGRAM_ID,
            },
            naryx_conformance_venue::instruction::OpenShortExact {
                base_atoms,
                max_collateral_quote_atoms,
            },
        )
    }

    fn close_ix(&self, base_atoms: u64, min_collateral_return_atoms: u64) -> Instruction {
        build_ix(
            naryx_conformance_venue::accounts::CloseShortExact {
                trader: self.trader.pubkey(),
                market: self.market,
                position: self.position,
                trader_quote: self.trader_quote,
                perp_quote_vault: self.perp_quote_vault,
                token_program: TOKEN_PROGRAM_ID,
            },
            naryx_conformance_venue::instruction::CloseShortExact {
                base_atoms,
                min_collateral_return_atoms,
            },
        )
    }

    fn pause_ix(&self, admin: Pubkey, paused: bool) -> Instruction {
        build_ix(
            naryx_conformance_venue::accounts::SetPaused {
                market: self.market,
                admin,
            },
            naryx_conformance_venue::instruction::SetPaused { paused },
        )
    }
}

#[test]
fn conformance_venue_executes_spot_and_short_lifecycle_fail_closed() {
    let mut env = setup();

    let buy = env.buy_ix(1, 3);
    send(&mut env.svm, &env.admin, &[&env.trader], &[buy]).unwrap();
    assert_eq!(token_balance(&env.svm, env.trader_base), 11);
    assert_eq!(token_balance(&env.svm, env.trader_quote), 7);

    let sell = env.sell_ix(2, 2);
    send(&mut env.svm, &env.admin, &[&env.trader], &[sell]).unwrap();
    assert_eq!(token_balance(&env.svm, env.trader_base), 9);
    assert_eq!(token_balance(&env.svm, env.trader_quote), 9);

    let wrong_admin = env.pause_ix(env.outsider.pubkey(), true);
    assert_custom_error(
        send(&mut env.svm, &env.admin, &[&env.outsider], &[wrong_admin]),
        ErrorCode::UnauthorizedAdmin,
    );

    let pause = env.pause_ix(env.admin.pubkey(), true);
    send(&mut env.svm, &env.admin, &[], &[pause]).unwrap();
    let paused_buy = env.buy_ix(1, 3);
    assert_custom_error(
        send(&mut env.svm, &env.admin, &[&env.trader], &[paused_buy]),
        ErrorCode::MarketPaused,
    );
    let unpause = env.pause_ix(env.admin.pubkey(), false);
    send(&mut env.svm, &env.admin, &[], &[unpause]).unwrap();

    let cap = env.buy_ix(11, u64::MAX);
    assert_custom_error(
        send(&mut env.svm, &env.admin, &[&env.trader], &[cap]),
        ErrorCode::AmountCapExceeded,
    );

    let mint_mismatch = build_ix(
        naryx_conformance_venue::accounts::SpotBuyExactOutput {
            trader: env.trader.pubkey(),
            market: env.market,
            trader_base: env.wrong_base,
            trader_quote: env.trader_quote,
            spot_base_vault: env.spot_base_vault,
            spot_quote_vault: env.spot_quote_vault,
            token_program: TOKEN_PROGRAM_ID,
        },
        naryx_conformance_venue::instruction::SpotBuyExactOutput {
            base_atoms_out: 1,
            max_quote_atoms_in: 3,
        },
    );
    assert_custom_error(
        send(&mut env.svm, &env.admin, &[&env.trader], &[mint_mismatch]),
        ErrorCode::MintMismatch,
    );

    let open = env.open_ix(5, 2);
    send(&mut env.svm, &env.admin, &[&env.trader], &[open]).unwrap();
    assert_eq!(token_balance(&env.svm, env.perp_quote_vault), 2);
    assert_eq!(position(&env.svm, env.position).short_base_atoms, 5);

    let over_close = env.close_ix(6, 0);
    assert_custom_error(
        send(&mut env.svm, &env.admin, &[&env.trader], &[over_close]),
        ErrorCode::ReduceOnlyViolation,
    );
    let partial_close = env.close_ix(3, 1);
    send(&mut env.svm, &env.admin, &[&env.trader], &[partial_close]).unwrap();
    let remaining = position(&env.svm, env.position);
    assert_eq!(remaining.short_base_atoms, 2);
    assert_eq!(remaining.collateral_quote_atoms, 1);
    let final_close = env.close_ix(2, 1);
    send(&mut env.svm, &env.admin, &[&env.trader], &[final_close]).unwrap();
    assert_eq!(position(&env.svm, env.position).short_base_atoms, 0);
    assert_eq!(token_balance(&env.svm, env.perp_quote_vault), 0);

    let insufficient = env.buy_ix(10, 16);
    assert!(send(&mut env.svm, &env.admin, &[&env.trader], &[insufficient]).is_err());
}

#[test]
fn exact_math_rounds_in_the_declared_direction() {
    assert_eq!(mul_div_ceil(1, 3, 2).unwrap(), 2);
    assert_eq!(mul_div_floor(1, 3, 2).unwrap(), 1);
    assert_eq!(
        mul_div_ceil(u64::MAX, u64::MAX, u64::MAX).unwrap(),
        u64::MAX
    );
}

#[test]
fn market_configuration_boundaries_fail_closed() {
    validate_market_parameters(3, 2, 100, 2_000, 10, 10).unwrap();
    assert!(validate_market_parameters(0, 2, 100, 2_000, 10, 10).is_err());
    assert!(validate_market_parameters(6, 4, 100, 2_000, 10, 10).is_err());
    assert!(validate_market_parameters(3, 2, 10_001, 2_000, 10, 10).is_err());
    assert!(validate_market_parameters(3, 2, 100, 0, 10, 10).is_err());
    assert!(validate_market_parameters(3, 2, 100, 2_000, 0, 10).is_err());
}

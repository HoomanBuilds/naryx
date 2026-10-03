use {
    anchor_lang::{
        prelude::{Clock, Pubkey},
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
    naryx_test_perp::{
        error::TestPerpError, InitializeMarketArgs, OrderSide, PlaceMarketOrderArgs,
        TestPerpPosition, COLLATERAL_VAULT_SEED, FEE_VAULT_SEED, INSURANCE_VAULT_SEED, MARKET_SEED,
        POSITION_SEED, PRICE_UPDATE_V2_DISCRIMINATOR, PYTH_RECEIVER_PROGRAM_ID,
        TEST_COLLATERAL_FAUCET_SEED, TEST_COLLATERAL_MAX_BALANCE_ATOMS,
        TEST_COLLATERAL_MAX_CLAIM_ATOMS,
    },
    solana_account::Account,
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::{versioned::VersionedTransaction, InstructionError, TransactionError},
};

type TransactionResult = Result<TransactionMetadata, Box<FailedTransactionMetadata>>;

const FEED: [u8; 32] = [7; 32];
const USD_100: i64 = 10_000_000_000;
// $100 with exponent -8, 6 collateral decimals, 9 base decimals, and 0.001 base per lot.
const ORACLE_PER_LOT_AT_100: u64 = 100_000;
const START_TS: i64 = 1_800_000_000;

struct Env {
    svm: LiteSVM,
    owner: Keypair,
    keeper: Keypair,
    trader: Keypair,
    mint: Pubkey,
    oracle: Pubkey,
    market: Pubkey,
    collateral_vault: Pubkey,
    fee_vault: Pubkey,
    insurance_vault: Pubkey,
    position: Pubkey,
    trader_usdc: Pubkey,
}

fn send(
    svm: &mut LiteSVM,
    payer: &Keypair,
    extra: &[&Keypair],
    ixs: &[Instruction],
) -> TransactionResult {
    svm.expire_blockhash();
    let message = Message::new_with_blockhash(ixs, Some(&payer.pubkey()), &svm.latest_blockhash());
    let mut signers = vec![payer];
    signers.extend_from_slice(extra);
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(message), &signers).unwrap();
    svm.send_transaction(tx).map_err(Box::new)
}

fn ix<A: ToAccountMetas, D: InstructionData>(program: Pubkey, accounts: A, data: D) -> Instruction {
    Instruction::new_with_bytes(program, &data.data(), accounts.to_account_metas(None))
}

fn assert_error(result: TransactionResult, expected: TestPerpError) {
    let failure = result.expect_err("transaction should fail");
    assert_eq!(
        failure.err,
        TransactionError::InstructionError(0, InstructionError::Custom(u32::from(expected)))
    );
}

fn price_update(feed: [u8; 32], price: i64, conf: u64, publish_time: i64, full: bool) -> Vec<u8> {
    let mut data = PRICE_UPDATE_V2_DISCRIMINATOR.to_vec();
    data.extend_from_slice(&[0u8; 32]);
    if full {
        data.push(1);
    } else {
        data.extend_from_slice(&[0, 3]);
    }
    data.extend_from_slice(&feed);
    data.extend_from_slice(&price.to_le_bytes());
    data.extend_from_slice(&conf.to_le_bytes());
    data.extend_from_slice(&(-8i32).to_le_bytes());
    data.extend_from_slice(&publish_time.to_le_bytes());
    data.extend_from_slice(&publish_time.to_le_bytes());
    data.extend_from_slice(&price.to_le_bytes());
    data.extend_from_slice(&conf.to_le_bytes());
    data.extend_from_slice(&1u64.to_le_bytes());
    data
}

fn set_price(env: &mut Env, data: Vec<u8>) {
    env.svm
        .set_account(
            env.oracle,
            Account {
                lamports: 1_000_000_000,
                data,
                owner: PYTH_RECEIVER_PROGRAM_ID,
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();
}

fn now(env: &Env) -> i64 {
    env.svm.get_sysvar::<Clock>().unix_timestamp
}

fn set_usd_price(env: &mut Env, price: i64) {
    let publish_time = now(env);
    set_price(env, price_update(FEED, price, 100_000, publish_time, true));
}

fn warp(env: &mut Env, seconds: i64) {
    let mut clock = env.svm.get_sysvar::<Clock>();
    clock.unix_timestamp += seconds;
    clock.slot += 1;
    env.svm.set_sysvar(&clock);
}

fn token_account(svm: &mut LiteSVM, payer: &Keypair, mint: Pubkey, owner: Pubkey) -> Pubkey {
    let account = Keypair::new();
    let create = system_instruction::create_account(
        &payer.pubkey(),
        &account.pubkey(),
        svm.minimum_balance_for_rent_exemption(SplAccount::LEN),
        SplAccount::LEN as u64,
        &TOKEN_PROGRAM_ID,
    );
    let init = spl_token::instruction::initialize_account3(
        &TOKEN_PROGRAM_ID,
        &account.pubkey(),
        &mint,
        &owner,
    )
    .unwrap();
    send(svm, payer, &[&account], &[create, init]).unwrap();
    account.pubkey()
}

fn mint_to(env: &mut Env, to: Pubkey, amount: u64) {
    let ix = spl_token::instruction::mint_to(
        &TOKEN_PROGRAM_ID,
        &env.mint,
        &to,
        &env.owner.pubkey(),
        &[],
        amount,
    )
    .unwrap();
    send(&mut env.svm, &env.owner, &[], &[ix]).unwrap();
}

fn balance(env: &Env, address: Pubkey) -> u64 {
    SplAccount::unpack(&env.svm.get_account(&address).unwrap().data)
        .unwrap()
        .amount
}

fn position(env: &Env) -> TestPerpPosition {
    let account = env.svm.get_account(&env.position).unwrap();
    TestPerpPosition::try_deserialize(&mut account.data.as_slice()).unwrap()
}

fn pda(seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, &naryx_test_perp::id()).0
}

fn setup() -> Env {
    let mut svm = LiteSVM::new();
    let test_perp_binary = std::fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../target/deploy/naryx_test_perp.so"
    ))
    .unwrap();
    svm.add_program(naryx_test_perp::id(), &test_perp_binary)
        .unwrap();
    let test_perp_adapter_binary = std::fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../target/deploy/naryx_test_perp_adapter.so"
    ))
    .unwrap();
    svm.add_program(naryx_test_perp_adapter::id(), &test_perp_adapter_binary)
        .unwrap();
    let mut clock = svm.get_sysvar::<Clock>();
    clock.unix_timestamp = START_TS;
    svm.set_sysvar(&clock);

    let owner = Keypair::new();
    let keeper = Keypair::new();
    let trader = Keypair::new();
    for signer in [&owner, &keeper, &trader] {
        svm.airdrop(&signer.pubkey(), 10_000_000_000).unwrap();
    }
    let mint = Keypair::new();
    let create = system_instruction::create_account(
        &owner.pubkey(),
        &mint.pubkey(),
        svm.minimum_balance_for_rent_exemption(Mint::LEN),
        Mint::LEN as u64,
        &TOKEN_PROGRAM_ID,
    );
    let init = spl_token::instruction::initialize_mint2(
        &TOKEN_PROGRAM_ID,
        &mint.pubkey(),
        &owner.pubkey(),
        None,
        6,
    )
    .unwrap();
    send(&mut svm, &owner, &[&mint], &[create, init]).unwrap();

    let oracle = Pubkey::new_unique();
    let market = pda(&[MARKET_SEED, owner.pubkey().as_ref(), FEED.as_ref()]);
    let collateral_vault = pda(&[COLLATERAL_VAULT_SEED, market.as_ref()]);
    let fee_vault = pda(&[FEE_VAULT_SEED, market.as_ref()]);
    let insurance_vault = pda(&[INSURANCE_VAULT_SEED, market.as_ref()]);
    let position = pda(&[POSITION_SEED, market.as_ref(), trader.pubkey().as_ref()]);
    let trader_usdc = token_account(&mut svm, &owner, mint.pubkey(), trader.pubkey());
    let mut env = Env {
        svm,
        owner,
        keeper,
        trader,
        mint: mint.pubkey(),
        oracle,
        market,
        collateral_vault,
        fee_vault,
        insurance_vault,
        position,
        trader_usdc,
    };
    set_usd_price(&mut env, USD_100);

    let initialize = ix(
        naryx_test_perp::id(),
        naryx_test_perp::accounts::InitializeMarket {
            owner: env.owner.pubkey(),
            collateral_mint: env.mint,
            oracle,
            market,
            collateral_vault,
            fee_vault,
            insurance_vault,
            token_program: TOKEN_PROGRAM_ID,
            system_program: anchor_lang::system_program::ID,
        },
        naryx_test_perp::instruction::InitializeMarket {
            args: InitializeMarketArgs {
                feed_id: FEED,
                funding_keeper: env.keeper.pubkey(),
                base_decimals: 9,
                max_price_age_seconds: 60,
                max_confidence_bps: 50,
                taker_fee_bps: 5,
                half_spread_bps: 2,
                impact_bps_per_unit: 1,
                impact_unit_lots: 1_000,
                max_slippage_bps: 500,
                initial_margin_bps: 1_000,
                maintenance_margin_bps: 500,
                liquidation_penalty_bps: 100,
                base_lot_atoms: 1_000_000,
                quote_tick_atoms_per_base_lot: 1,
                max_position_lots: 1_000_000,
                max_funding_rate_per_second: 1_000_000,
            },
        },
    );
    send(&mut env.svm, &env.owner, &[], &[initialize]).unwrap();
    let init_position = ix(
        naryx_test_perp::id(),
        naryx_test_perp::accounts::InitializePosition {
            owner: env.trader.pubkey(),
            market,
            position,
            system_program: anchor_lang::system_program::ID,
        },
        naryx_test_perp::instruction::InitializePosition {},
    );
    send(&mut env.svm, &env.trader, &[], &[init_position]).unwrap();
    mint_to(&mut env, insurance_vault, 1_000_000_000);
    mint_to(&mut env, trader_usdc, 100_000_000);
    deposit(&mut env, 20_000_000);
    env
}

fn deposit(env: &mut Env, amount: u64) {
    let deposit = ix(
        naryx_test_perp::id(),
        naryx_test_perp::accounts::Deposit {
            owner: env.trader.pubkey(),
            market: env.market,
            position: env.position,
            collateral_vault: env.collateral_vault,
            owner_collateral: env.trader_usdc,
            token_program: TOKEN_PROGRAM_ID,
        },
        naryx_test_perp::instruction::Deposit { amount },
    );
    send(&mut env.svm, &env.trader, &[], &[deposit]).unwrap();
}

fn trade_accounts(env: &Env, authority: Pubkey) -> naryx_test_perp::accounts::TradePosition {
    naryx_test_perp::accounts::TradePosition {
        authority,
        market: env.market,
        position: env.position,
        oracle: env.oracle,
        collateral_vault: env.collateral_vault,
        fee_vault: env.fee_vault,
        insurance_vault: env.insurance_vault,
        token_program: TOKEN_PROGRAM_ID,
    }
}

fn order(
    env: &mut Env,
    signer: &Keypair,
    side: OrderSide,
    base_lots: u64,
    limit: u64,
    reduce_only: bool,
) -> TransactionResult {
    let order = ix(
        naryx_test_perp::id(),
        trade_accounts(env, signer.pubkey()),
        naryx_test_perp::instruction::PlaceMarketOrder {
            args: PlaceMarketOrderArgs {
                side,
                base_lots,
                limit_price_in_ticks: limit,
                last_valid_slot: u64::MAX,
                reduce_only,
                client_order_id: 1,
            },
        },
    );
    send(&mut env.svm, signer, &[], &[order])
}

fn withdraw(env: &mut Env, signer: &Keypair, amount: u64) -> TransactionResult {
    let withdraw = ix(
        naryx_test_perp::id(),
        naryx_test_perp::accounts::Withdraw {
            owner: signer.pubkey(),
            market: env.market,
            position: env.position,
            oracle: env.oracle,
            collateral_vault: env.collateral_vault,
            fee_vault: env.fee_vault,
            insurance_vault: env.insurance_vault,
            owner_collateral: env.trader_usdc,
            token_program: TOKEN_PROGRAM_ID,
        },
        naryx_test_perp::instruction::Withdraw { amount },
    );
    send(&mut env.svm, signer, &[], &[withdraw])
}

fn set_delegate(env: &mut Env, delegate: Pubkey) {
    let set = ix(
        naryx_test_perp::id(),
        naryx_test_perp::accounts::SetDelegate {
            owner: env.trader.pubkey(),
            position: env.position,
        },
        naryx_test_perp::instruction::SetDelegate { delegate },
    );
    send(&mut env.svm, &env.trader, &[], &[set]).unwrap();
}

#[test]
fn oracle_fill_fee_margin_and_delegate_withdraw_boundary() {
    let mut env = setup();
    let delegate = Keypair::new();
    env.svm.airdrop(&delegate.pubkey(), 1_000_000_000).unwrap();
    set_delegate(&mut env, delegate.pubkey());
    assert_error(
        withdraw(&mut env, &delegate, 1),
        TestPerpError::Unauthorized,
    );

    // Short 1 base unit: 2 bps half spread plus 1 bps impact, rounded down for the seller.
    let fill = ORACLE_PER_LOT_AT_100 * 9_997 / 10_000;
    assert_error(
        order(&mut env, &delegate, OrderSide::Ask, 1_000, fill + 1, false),
        TestPerpError::LimitPriceExceeded,
    );
    order(&mut env, &delegate, OrderSide::Ask, 1_000, fill, false).unwrap();
    let fee = (fill * 1_000 * 5).div_ceil(10_000);
    let short = position(&env);
    assert_eq!(
        (short.base_lots, short.entry_notional_atoms),
        (-1_000, fill * 1_000)
    );
    assert_eq!(short.collateral_atoms, 20_000_000 - fee);
    assert_eq!(balance(&env, env.fee_vault), fee);

    // 3 base units need 30 USDC of initial margin against about 20 USDC of equity.
    assert_error(
        order(&mut env, &delegate, OrderSide::Ask, 2_000, 1, false),
        TestPerpError::InsufficientInitialMargin,
    );
    let trader = env.trader.insecure_clone();
    assert_error(
        withdraw(&mut env, &trader, 10_100_000),
        TestPerpError::InsufficientFreeCollateral,
    );

    // The fill follows the Pyth price: cover at $110 plus spread and impact, rounded up.
    set_usd_price(&mut env, 11_000_000_000);
    let cover = (110_000u64 * 10_003).div_ceil(10_000);
    order(&mut env, &delegate, OrderSide::Bid, 1_000, cover, true).unwrap();
    let loss = (cover - fill) * 1_000;
    let cover_fee = (cover * 1_000 * 5).div_ceil(10_000);
    let flat = position(&env);
    assert_eq!((flat.base_lots, flat.entry_notional_atoms), (0, 0));
    assert_eq!(flat.collateral_atoms, 20_000_000 - fee - loss - cover_fee);
    assert_eq!(balance(&env, env.insurance_vault), 1_000_000_000 + loss);
    assert_eq!(balance(&env, env.fee_vault), fee + cover_fee);
    assert_eq!(balance(&env, env.collateral_vault), flat.collateral_atoms);
}

#[test]
fn oracle_rejects_stale_wide_wrong_feed_and_partial_updates() {
    let mut env = setup();
    let trader = env.trader.insecure_clone();
    let t = now(&env);
    for (data, error) in [
        (
            price_update(FEED, USD_100, 100_000, t - 61, true),
            TestPerpError::OracleStale,
        ),
        (
            price_update(FEED, USD_100, 50_000_001, t, true),
            TestPerpError::OracleConfidenceTooWide,
        ),
        (
            price_update([8; 32], USD_100, 100_000, t, true),
            TestPerpError::OracleFeedMismatch,
        ),
        (
            price_update(FEED, USD_100, 100_000, t, false),
            TestPerpError::OracleNotFullyVerified,
        ),
    ] {
        set_price(&mut env, data);
        assert_error(
            order(&mut env, &trader, OrderSide::Ask, 1_000, 1, false),
            error,
        );
    }
    set_price(
        &mut env,
        price_update(FEED, USD_100, 50_000_000, t - 60, true),
    );
    order(&mut env, &trader, OrderSide::Ask, 1_000, 1, false).unwrap();
}

#[test]
fn positive_funding_pays_shorts_and_underwater_short_is_liquidated() {
    let mut env = setup();
    let trader = env.trader.insecure_clone();
    order(&mut env, &trader, OrderSide::Ask, 1_000, 1, false).unwrap();
    let keeper = env.keeper.insecure_clone();
    let set_rate = ix(
        naryx_test_perp::id(),
        naryx_test_perp::accounts::SetFundingRate {
            funding_keeper: keeper.pubkey(),
            market: env.market,
            oracle: env.oracle,
        },
        naryx_test_perp::instruction::SetFundingRate {
            funding_rate_per_second: 1_000,
        },
    );
    send(&mut env.svm, &keeper, &[], &[set_rate.clone()]).unwrap();
    let mut too_high = set_rate;
    too_high.data = naryx_test_perp::instruction::SetFundingRate {
        funding_rate_per_second: -1_000_001,
    }
    .data();
    assert_error(
        send(&mut env.svm, &keeper, &[], &[too_high]),
        TestPerpError::FundingRateOutOfBounds,
    );

    // 1e-9 per second for 1,000 seconds on 100 USDC of short notional credits 100 atoms.
    warp(&mut env, 1_000);
    set_usd_price(&mut env, USD_100);
    let before = position(&env).collateral_atoms;
    withdraw(&mut env, &trader, 1).unwrap();
    assert_eq!(position(&env).collateral_atoms, before + 100 - 1);

    let liquidate = ix(
        naryx_test_perp::id(),
        trade_accounts(&env, keeper.pubkey()),
        naryx_test_perp::instruction::Liquidate {},
    );
    assert_error(
        send(&mut env.svm, &keeper, &[], &[liquidate.clone()]),
        TestPerpError::NotLiquidatable,
    );

    set_usd_price(&mut env, 11_800_000_000);
    let pre = position(&env);
    let fees_before = balance(&env, env.fee_vault);
    send(&mut env.svm, &keeper, &[], &[liquidate]).unwrap();
    let loss = 118_000 * 1_000 - pre.entry_notional_atoms;
    let penalty = 118_000_000u64.div_ceil(100);
    let post = position(&env);
    assert_eq!(post.base_lots, 0);
    assert_eq!(post.collateral_atoms, pre.collateral_atoms - loss - penalty);
    assert_eq!(balance(&env, env.fee_vault), fees_before + penalty);
}

#[test]
fn adapter_strategy_enters_and_closes_exact_short_as_delegate() {
    let mut env = setup();
    let controller = Keypair::new();
    env.svm
        .airdrop(&controller.pubkey(), 1_000_000_000)
        .unwrap();
    let strategy_id = [9u8; 32];
    let strategy = Pubkey::find_program_address(
        &[
            naryx_test_perp_adapter::TEST_PERP_STRATEGY_SEED,
            env.trader.pubkey().as_ref(),
            strategy_id.as_ref(),
        ],
        &naryx_test_perp_adapter::id(),
    )
    .0;
    set_delegate(&mut env, strategy);
    let init = ix(
        naryx_test_perp_adapter::id(),
        naryx_test_perp_adapter::accounts::InitializeTestPerpStrategy {
            owner: env.trader.pubkey(),
            strategy,
            market: env.market,
            position: env.position,
            system_program: anchor_lang::system_program::ID,
        },
        naryx_test_perp_adapter::instruction::InitializeTestPerpStrategy {
            args: naryx_test_perp_adapter::InitializeTestPerpStrategyArgs {
                strategy_id,
                controller: controller.pubkey(),
                max_base_lots: 1_000,
            },
        },
    );
    send(&mut env.svm, &env.trader.insecure_clone(), &[], &[init]).unwrap();

    let accounts = naryx_test_perp_adapter::accounts::ExecuteTestPerpOrder {
        strategy,
        controller: controller.pubkey(),
        test_perp_program: naryx_test_perp::id(),
        market: env.market,
        position: env.position,
        oracle: env.oracle,
        collateral_vault: env.collateral_vault,
        fee_vault: env.fee_vault,
        insurance_vault: env.insurance_vault,
        token_program: TOKEN_PROGRAM_ID,
    };
    let args = naryx_test_perp_adapter::TestPerpMarketOrderArgs {
        base_lots: 1_000,
        limit_price_in_ticks: 99_970,
        last_valid_slot: u64::MAX,
        min_post_collateral_quote_lots: 19_000_000,
        client_order_id: 7,
    };
    let enter = ix(
        naryx_test_perp_adapter::id(),
        accounts.clone(),
        naryx_test_perp_adapter::instruction::TestPerpEnterShort { args },
    );
    send(&mut env.svm, &controller, &[], &[enter.clone()]).unwrap();
    assert_eq!(position(&env).base_lots, -1_000);
    assert!(send(&mut env.svm, &controller, &[], &[enter]).is_err());

    let close = ix(
        naryx_test_perp_adapter::id(),
        accounts,
        naryx_test_perp_adapter::instruction::TestPerpCloseShort {
            args: naryx_test_perp_adapter::TestPerpMarketOrderArgs {
                limit_price_in_ticks: 100_030,
                ..args
            },
        },
    );
    send(&mut env.svm, &controller, &[], &[close]).unwrap();
    assert_eq!(position(&env).base_lots, 0);
}

fn faucet_mint(
    svm: &mut LiteSVM,
    payer: &Keypair,
    authority: Pubkey,
    freeze: Option<&Pubkey>,
) -> Pubkey {
    let mint = Keypair::new();
    let create = system_instruction::create_account(
        &payer.pubkey(),
        &mint.pubkey(),
        svm.minimum_balance_for_rent_exemption(Mint::LEN),
        Mint::LEN as u64,
        &TOKEN_PROGRAM_ID,
    );
    let init = spl_token::instruction::initialize_mint2(
        &TOKEN_PROGRAM_ID,
        &mint.pubkey(),
        &authority,
        freeze,
        6,
    )
    .unwrap();
    send(svm, payer, &[&mint], &[create, init]).unwrap();
    mint.pubkey()
}

fn claim(
    env: &mut Env,
    signer: &Keypair,
    mint: Pubkey,
    to: Pubkey,
    amount: u64,
) -> TransactionResult {
    let claim = ix(
        naryx_test_perp::id(),
        naryx_test_perp::accounts::ClaimTestCollateral {
            recipient: signer.pubkey(),
            mint,
            faucet_authority: pda(&[TEST_COLLATERAL_FAUCET_SEED]),
            recipient_collateral: to,
            token_program: TOKEN_PROGRAM_ID,
        },
        naryx_test_perp::instruction::ClaimTestCollateral { amount },
    );
    send(&mut env.svm, signer, &[], &[claim])
}

#[test]
fn faucet_claims_bounded_test_collateral_into_the_signers_own_account() {
    let mut env = setup();
    let faucet = pda(&[TEST_COLLATERAL_FAUCET_SEED]);
    let owner = env.owner.insecure_clone();
    let trader = env.trader.insecure_clone();
    let mint = faucet_mint(&mut env.svm, &owner, faucet, None);
    let account = token_account(&mut env.svm, &trader, mint, trader.pubkey());

    claim(
        &mut env,
        &trader,
        mint,
        account,
        TEST_COLLATERAL_MAX_CLAIM_ATOMS,
    )
    .unwrap();
    assert_eq!(balance(&env, account), TEST_COLLATERAL_MAX_CLAIM_ATOMS);
    assert_error(
        claim(&mut env, &trader, mint, account, 0),
        TestPerpError::ZeroAmount,
    );
    assert_error(
        claim(
            &mut env,
            &trader,
            mint,
            account,
            TEST_COLLATERAL_MAX_CLAIM_ATOMS + 1,
        ),
        TestPerpError::FaucetLimitExceeded,
    );

    // Another wallet cannot claim into the trader's account, and nobody claims past the balance limit.
    let keeper = env.keeper.insecure_clone();
    assert!(claim(&mut env, &keeper, mint, account, 1).is_err());
    let full = TEST_COLLATERAL_MAX_BALANCE_ATOMS / TEST_COLLATERAL_MAX_CLAIM_ATOMS;
    for _ in 1..full {
        claim(
            &mut env,
            &trader,
            mint,
            account,
            TEST_COLLATERAL_MAX_CLAIM_ATOMS,
        )
        .unwrap();
    }
    assert_eq!(balance(&env, account), TEST_COLLATERAL_MAX_BALANCE_ATOMS);
    assert_error(
        claim(&mut env, &trader, mint, account, 1),
        TestPerpError::FaucetLimitExceeded,
    );

    // A mint the faucet does not own, or one with a freeze authority, is never minted.
    let foreign = env.mint;
    let foreign_account = token_account(&mut env.svm, &trader, foreign, trader.pubkey());
    assert!(claim(&mut env, &trader, foreign, foreign_account, 1).is_err());
    let frozen = faucet_mint(&mut env.svm, &owner, faucet, Some(&owner.pubkey()));
    let frozen_account = token_account(&mut env.svm, &trader, frozen, trader.pubkey());
    assert_error(
        claim(&mut env, &trader, frozen, frozen_account, 1),
        TestPerpError::InvalidFaucetMint,
    );
}

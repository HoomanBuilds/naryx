use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::set_return_data;
use anchor_spl::token::Token;
use naryx_test_perp::{
    program::NaryxTestPerp, OrderSide, PlaceMarketOrderArgs, TestPerpMarket, TestPerpPosition,
};

use crate::{
    error::TestPerpAdapterError, read_position_and_collateral, TestPerpStrategy,
    TEST_PERP_PROGRAM_ID, TEST_PERP_STRATEGY_SEED,
};
use solana_sha256_hasher::hashv;

const ENTER_SHORT_DISCRIMINATOR: [u8; 8] = [0x69, 0xb8, 0x33, 0x73, 0xed, 0x51, 0x4e, 0x70];
const CLOSE_SHORT_DISCRIMINATOR: [u8; 8] = [0xd4, 0x96, 0x10, 0xa3, 0xd8, 0xde, 0x26, 0xe6];
const TYPED_EVIDENCE_DOMAIN: &[u8] = b"naryx.test-perp.typed-leg-evidence.v1";

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InitializeTestPerpStrategyArgs {
    pub strategy_id: [u8; 32],
    pub controller: Pubkey,
    pub max_base_lots: u64,
}

#[derive(Accounts)]
#[instruction(args: InitializeTestPerpStrategyArgs)]
pub struct InitializeTestPerpStrategy<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        init,
        payer = owner,
        space = 8 + TestPerpStrategy::INIT_SPACE,
        seeds = [TEST_PERP_STRATEGY_SEED, owner.key().as_ref(), args.strategy_id.as_ref()],
        bump
    )]
    pub strategy: Account<'info, TestPerpStrategy>,
    pub market: Box<Account<'info, TestPerpMarket>>,
    #[account(
        has_one = market @ TestPerpAdapterError::InvalidMarketIdentity,
        has_one = owner @ TestPerpAdapterError::InvalidMarketIdentity
    )]
    pub position: Box<Account<'info, TestPerpPosition>>,
    pub system_program: Program<'info, System>,
}

pub fn initialize(
    ctx: Context<InitializeTestPerpStrategy>,
    args: InitializeTestPerpStrategyArgs,
) -> Result<()> {
    require!(
        args.strategy_id.iter().any(|byte| *byte != 0),
        TestPerpAdapterError::StrategyIdZero
    );
    require_keys_neq!(
        args.controller,
        Pubkey::default(),
        TestPerpAdapterError::ControllerZero
    );
    require!(
        args.max_base_lots > 0 && args.max_base_lots <= i64::MAX as u64,
        TestPerpAdapterError::InvalidMaxBaseLots
    );
    require_keys_eq!(
        ctx.accounts.position.delegate,
        ctx.accounts.strategy.key(),
        TestPerpAdapterError::InvalidPositionAuthority
    );
    ctx.accounts.strategy.set_inner(TestPerpStrategy {
        owner: ctx.accounts.owner.key(),
        controller: args.controller,
        strategy_id: args.strategy_id,
        market: ctx.accounts.market.key(),
        position: ctx.accounts.position.key(),
        max_base_lots: args.max_base_lots,
        bump: ctx.bumps.strategy,
    });
    Ok(())
}

/// Same field set and meaning as `naryx_rise_adapter::RiseMarketOrderArgs`.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct TestPerpMarketOrderArgs {
    pub base_lots: u64,
    pub limit_price_in_ticks: u64,
    pub last_valid_slot: u64,
    pub min_post_collateral_quote_lots: i64,
    pub client_order_id: u128,
}

#[derive(Accounts)]
pub struct ExecuteTestPerpOrder<'info> {
    #[account(
        seeds = [TEST_PERP_STRATEGY_SEED, strategy.owner.as_ref(), strategy.strategy_id.as_ref()],
        bump = strategy.bump,
        constraint = strategy.controller == controller.key() @ TestPerpAdapterError::UnauthorizedController,
        constraint = strategy.market == market.key() @ TestPerpAdapterError::InvalidMarketIdentity,
        constraint = strategy.position == position.key() @ TestPerpAdapterError::InvalidMarketIdentity
    )]
    pub strategy: Account<'info, TestPerpStrategy>,
    pub controller: Signer<'info>,
    #[account(address = TEST_PERP_PROGRAM_ID)]
    pub test_perp_program: Program<'info, NaryxTestPerp>,
    /// CHECK: Bound to the strategy, owned by the venue, and fully validated by the venue.
    #[account(mut, owner = TEST_PERP_PROGRAM_ID)]
    pub market: UncheckedAccount<'info>,
    /// CHECK: Bound to the strategy and decoded with the venue position layout.
    #[account(mut, owner = TEST_PERP_PROGRAM_ID)]
    pub position: UncheckedAccount<'info>,
    /// CHECK: The venue pins this Pyth account to the market and validates every field.
    pub oracle: UncheckedAccount<'info>,
    /// CHECK: The venue pins this vault to the market.
    #[account(mut)]
    pub collateral_vault: UncheckedAccount<'info>,
    /// CHECK: The venue pins this vault to the market.
    #[account(mut)]
    pub fee_vault: UncheckedAccount<'info>,
    /// CHECK: The venue pins this vault to the market.
    #[account(mut)]
    pub insurance_vault: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

pub fn execute_order(
    ctx: Context<ExecuteTestPerpOrder>,
    args: TestPerpMarketOrderArgs,
    entry: bool,
) -> Result<[u8; 32]> {
    require!(
        ctx.remaining_accounts.is_empty(),
        TestPerpAdapterError::UnexpectedRemainingAccounts
    );
    require!(
        args.base_lots > 0
            && args.base_lots <= ctx.accounts.strategy.max_base_lots
            && args.base_lots <= i64::MAX as u64,
        TestPerpAdapterError::InvalidBaseLots
    );
    require!(
        args.limit_price_in_ticks > 0,
        TestPerpAdapterError::LimitPriceZero
    );
    require!(
        Clock::get()?.slot <= args.last_valid_slot,
        TestPerpAdapterError::OrderExpired
    );
    {
        let data = ctx.accounts.position.try_borrow_data()?;
        let position = TestPerpPosition::try_deserialize(&mut &data[..])?;
        require_keys_eq!(
            position.delegate,
            ctx.accounts.strategy.key(),
            TestPerpAdapterError::InvalidPositionAuthority
        );
    }

    let exact_short = args.base_lots as i64;
    let (pre_position, _) = read_position_and_collateral(&ctx.accounts.position)?;
    if entry {
        require!(
            pre_position == 0,
            TestPerpAdapterError::EntryPositionNotFlat
        );
    } else {
        require!(
            pre_position == -exact_short,
            TestPerpAdapterError::ClosePositionMismatch
        );
    }

    let owner = ctx.accounts.strategy.owner;
    let strategy_id = ctx.accounts.strategy.strategy_id;
    let bump = [ctx.accounts.strategy.bump];
    let seeds: &[&[u8]] = &[
        TEST_PERP_STRATEGY_SEED,
        owner.as_ref(),
        strategy_id.as_ref(),
        bump.as_ref(),
    ];
    let accounts = &ctx.accounts;
    naryx_test_perp::cpi::place_market_order(
        CpiContext::new_with_signer(
            accounts.test_perp_program.key(),
            naryx_test_perp::cpi::accounts::TradePosition {
                authority: accounts.strategy.to_account_info(),
                market: accounts.market.to_account_info(),
                position: accounts.position.to_account_info(),
                oracle: accounts.oracle.to_account_info(),
                collateral_vault: accounts.collateral_vault.to_account_info(),
                fee_vault: accounts.fee_vault.to_account_info(),
                insurance_vault: accounts.insurance_vault.to_account_info(),
                token_program: accounts.token_program.to_account_info(),
            },
            &[seeds],
        ),
        PlaceMarketOrderArgs {
            side: if entry {
                OrderSide::Ask
            } else {
                OrderSide::Bid
            },
            base_lots: args.base_lots,
            limit_price_in_ticks: args.limit_price_in_ticks,
            last_valid_slot: args.last_valid_slot,
            reduce_only: !entry,
            client_order_id: args.client_order_id,
        },
    )?;

    let (post_position, post_collateral) = read_position_and_collateral(&ctx.accounts.position)?;
    let expected_post = if entry { -exact_short } else { 0 };
    require!(
        post_position == expected_post,
        TestPerpAdapterError::PositionPostconditionFailed
    );
    require!(
        post_collateral >= args.min_post_collateral_quote_lots,
        TestPerpAdapterError::CollateralPostconditionFailed
    );
    Ok(hashv(&[
        TYPED_EVIDENCE_DOMAIN,
        ctx.accounts.strategy.key().as_ref(),
        ctx.accounts.position.key().as_ref(),
        &[u8::from(entry)],
        &pre_position.to_le_bytes(),
        &post_position.to_le_bytes(),
        &post_collateral.to_le_bytes(),
        &args.client_order_id.to_le_bytes(),
    ])
    .to_bytes())
}

pub fn execute_typed(ctx: Context<ExecuteTestPerpOrder>, payload: Vec<u8>) -> Result<()> {
    require!(
        payload.len() >= 8,
        TestPerpAdapterError::TypedPayloadInvalid
    );
    let (discriminator, encoded) = payload.split_at(8);
    let entry = if discriminator == ENTER_SHORT_DISCRIMINATOR {
        true
    } else if discriminator == CLOSE_SHORT_DISCRIMINATOR {
        false
    } else {
        return err!(TestPerpAdapterError::TypedPayloadInvalid);
    };
    let mut encoded = encoded;
    let args = TestPerpMarketOrderArgs::deserialize(&mut encoded)
        .map_err(|_| error!(TestPerpAdapterError::TypedPayloadInvalid))?;
    require!(
        encoded.is_empty(),
        TestPerpAdapterError::TypedPayloadInvalid
    );
    let evidence = execute_order(ctx, args, entry)?;
    set_return_data(&evidence);
    Ok(())
}

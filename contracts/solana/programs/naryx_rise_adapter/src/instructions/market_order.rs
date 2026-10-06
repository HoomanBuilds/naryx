use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::{get_return_data, invoke_signed, set_return_data};
use phoenix_rise::ix::{
    market_order::{
        create_place_market_order_delegated_ix, MarketOrderDelegatedParams, MarketOrderParams,
    },
    return_data::{decode_matching_engine_cpi_response, MatchingEngineCPIResponse},
    types::{OrderFlags, SelfTradeBehavior, Side},
};
use phoenix_rise_accounts::{
    global_config::{GlobalConfig, LastRestartSlot},
    multi_arena::MultiArenaHeader,
    trader::{TraderHeader, TraderPositions},
    PhoenixAccount,
};
use solana_sha256_hasher::hashv;

use crate::{
    error::RiseAdapterError, RiseStrategy, ACTIVE_TRADER_BUFFER_SEED, GLOBAL_TRADER_INDEX_SEED,
    RISE_GLOBAL_CONFIG, RISE_LOG_AUTHORITY, RISE_PROGRAM_ID, RISE_STRATEGY_SEED,
};

const ENTER_SHORT_DISCRIMINATOR: [u8; 8] = [0xe7, 0x30, 0xf1, 0xa3, 0xdf, 0x67, 0x8c, 0x6f];
const CLOSE_SHORT_DISCRIMINATOR: [u8; 8] = [0x1f, 0x69, 0x36, 0xc1, 0x7c, 0xd9, 0xcc, 0x39];
const TYPED_EVIDENCE_DOMAIN: &[u8] = b"naryx.rise.typed-leg-evidence.v1";

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct RiseMarketOrderArgs {
    pub base_lots: u64,
    pub limit_price_in_ticks: u64,
    pub last_valid_slot: u64,
    pub min_post_collateral_quote_lots: i64,
    pub client_order_id: u128,
}

#[derive(Accounts)]
pub struct ExecuteRiseOrder<'info> {
    #[account(
        mut,
        seeds = [RISE_STRATEGY_SEED, strategy.owner.as_ref(), strategy.strategy_id.as_ref()],
        bump = strategy.bump,
        constraint = strategy.controller == controller.key() @ RiseAdapterError::UnauthorizedController,
        constraint = strategy.trader_account == trader_account.key() @ RiseAdapterError::InvalidTraderIdentity,
        constraint = strategy.perp_asset_map == perp_asset_map.key() @ RiseAdapterError::InvalidMarketIdentity,
        constraint = strategy.orderbook == orderbook.key() @ RiseAdapterError::InvalidMarketIdentity,
        constraint = strategy.spline_collection == spline_collection.key() @ RiseAdapterError::InvalidSplineCollection
    )]
    pub strategy: Account<'info, RiseStrategy>,
    pub controller: Signer<'info>,
    /// CHECK: Fixed to the audited Rise production program and required to be executable.
    #[account(address = RISE_PROGRAM_ID @ RiseAdapterError::InvalidRiseProgram)]
    pub phoenix_program: UncheckedAccount<'info>,
    /// CHECK: Fixed to the Rise log authority.
    #[account(address = RISE_LOG_AUTHORITY)]
    pub log_authority: UncheckedAccount<'info>,
    /// CHECK: Decoded with the official Rise account layout.
    #[account(mut, address = RISE_GLOBAL_CONFIG, owner = RISE_PROGRAM_ID)]
    pub global_config: UncheckedAccount<'info>,
    /// CHECK: Canonical strategy authority is used as the Rise primary position authority.
    #[account(mut)]
    pub permission_account: UncheckedAccount<'info>,
    /// CHECK: Decoded and checked against the strategy's owner, PDA indices, and position authority.
    #[account(mut, owner = RISE_PROGRAM_ID)]
    pub trader_account: UncheckedAccount<'info>,
    /// CHECK: Bound to the initialized strategy and owned by Rise.
    #[account(mut, owner = RISE_PROGRAM_ID)]
    pub perp_asset_map: UncheckedAccount<'info>,
    /// CHECK: Address comes from the decoded Rise global configuration.
    #[account(mut, owner = RISE_PROGRAM_ID)]
    pub global_trader_index_header: UncheckedAccount<'info>,
    /// CHECK: Address comes from the decoded Rise global configuration.
    #[account(mut, owner = RISE_PROGRAM_ID)]
    pub active_trader_buffer_header: UncheckedAccount<'info>,
    /// CHECK: Bound to the initialized strategy and owned by Rise.
    #[account(mut, owner = RISE_PROGRAM_ID)]
    pub orderbook: UncheckedAccount<'info>,
    /// CHECK: Bound to the initialized strategy and owned by Rise.
    #[account(mut, owner = RISE_PROGRAM_ID)]
    pub spline_collection: UncheckedAccount<'info>,
}

#[derive(Clone, Copy)]
enum OrderAction {
    EnterShort,
    CloseShort,
}

pub fn enter_short<'info>(
    ctx: Context<'info, ExecuteRiseOrder<'info>>,
    args: RiseMarketOrderArgs,
) -> Result<()> {
    execute_order(ctx, args, OrderAction::EnterShort).map(|_| ())
}

pub fn close_short<'info>(
    ctx: Context<'info, ExecuteRiseOrder<'info>>,
    args: RiseMarketOrderArgs,
) -> Result<()> {
    execute_order(ctx, args, OrderAction::CloseShort).map(|_| ())
}

pub fn execute_typed<'info>(
    ctx: Context<'info, ExecuteRiseOrder<'info>>,
    payload: Vec<u8>,
) -> Result<()> {
    require!(payload.len() >= 8, RiseAdapterError::TypedPayloadInvalid);
    let (discriminator, encoded) = payload.split_at(8);
    let action = if discriminator == ENTER_SHORT_DISCRIMINATOR {
        OrderAction::EnterShort
    } else if discriminator == CLOSE_SHORT_DISCRIMINATOR {
        OrderAction::CloseShort
    } else {
        return err!(RiseAdapterError::TypedPayloadInvalid);
    };
    let mut encoded = encoded;
    let args = RiseMarketOrderArgs::deserialize(&mut encoded)
        .map_err(|_| error!(RiseAdapterError::TypedPayloadInvalid))?;
    require!(encoded.is_empty(), RiseAdapterError::TypedPayloadInvalid);
    let evidence = execute_order(ctx, args, action)?;
    set_return_data(&evidence);
    Ok(())
}

fn execute_order<'info>(
    ctx: Context<'info, ExecuteRiseOrder<'info>>,
    args: RiseMarketOrderArgs,
    action: OrderAction,
) -> Result<[u8; 32]> {
    require!(
        ctx.accounts.phoenix_program.executable,
        RiseAdapterError::InvalidRiseProgram
    );
    require_keys_eq!(
        ctx.accounts.permission_account.key(),
        ctx.accounts.strategy.key(),
        RiseAdapterError::InvalidPositionAuthority
    );
    require!(
        args.base_lots > 0
            && args.base_lots <= ctx.accounts.strategy.max_base_lots
            && args.base_lots <= i64::MAX as u64,
        RiseAdapterError::InvalidBaseLots
    );
    require!(
        args.limit_price_in_ticks > 0,
        RiseAdapterError::LimitPriceZero
    );
    require!(
        Clock::get()?.slot <= args.last_valid_slot,
        RiseAdapterError::OrderExpired
    );

    let (global_trader_index, active_trader_buffer, mut cpi_accounts) =
        validate_and_collect_accounts(&ctx)?;
    let (pre_position, _) =
        read_position_and_collateral(&ctx.accounts.trader_account, ctx.accounts.strategy.asset_id)?;
    match action {
        OrderAction::EnterShort => {
            require!(pre_position == 0, RiseAdapterError::EntryPositionNotFlat);
        }
        OrderAction::CloseShort => {
            let expected = i64::try_from(args.base_lots)
                .map_err(|_| error!(RiseAdapterError::InvalidBaseLots))?;
            require!(
                pre_position == -expected,
                RiseAdapterError::ClosePositionMismatch
            );
        }
    }

    let side = match action {
        OrderAction::EnterShort => Side::Ask,
        OrderAction::CloseShort => Side::Bid,
    };
    let order_flags = match action {
        OrderAction::EnterShort => OrderFlags::None,
        OrderAction::CloseShort => OrderFlags::ReduceOnly,
    };
    let market_order = MarketOrderParams::builder()
        .trader(ctx.accounts.strategy.key())
        .trader_account(ctx.accounts.trader_account.key())
        .perp_asset_map(ctx.accounts.perp_asset_map.key())
        .orderbook(ctx.accounts.orderbook.key())
        .spline_collection(ctx.accounts.spline_collection.key())
        .global_trader_index(global_trader_index)
        .active_trader_buffer(active_trader_buffer)
        .side(side)
        .price_in_ticks(args.limit_price_in_ticks)
        .num_base_lots(args.base_lots)
        .min_base_lots_to_fill(args.base_lots)
        .min_quote_lots_to_fill(0)
        .self_trade_behavior(SelfTradeBehavior::CancelProvide)
        .client_order_id(args.client_order_id)
        .last_valid_slot(args.last_valid_slot)
        .order_flags(order_flags)
        .cancel_existing(false)
        .symbol("")
        .subaccount_index(ctx.accounts.strategy.trader_subaccount_index)
        .build()
        .map_err(|_| error!(RiseAdapterError::InstructionBuildFailed))?;
    let delegated = MarketOrderDelegatedParams::builder()
        .market_order(market_order)
        .trader_wallet(ctx.accounts.strategy.key())
        .permission_account(ctx.accounts.strategy.key())
        .build()
        .map_err(|_| error!(RiseAdapterError::InstructionBuildFailed))?;
    let rise_instruction = create_place_market_order_delegated_ix(delegated)
        .map_err(|_| error!(RiseAdapterError::InstructionBuildFailed))?;
    require!(
        rise_instruction.program_id == RISE_PROGRAM_ID,
        RiseAdapterError::InvalidRiseProgram
    );
    let instruction: anchor_lang::solana_program::instruction::Instruction =
        rise_instruction.into();

    cpi_accounts.push(ctx.accounts.orderbook.to_account_info());
    cpi_accounts.push(ctx.accounts.spline_collection.to_account_info());
    let owner = ctx.accounts.strategy.owner;
    let strategy_id = ctx.accounts.strategy.strategy_id;
    let bump = [ctx.accounts.strategy.bump];
    let signer_seeds: &[&[u8]] = &[
        RISE_STRATEGY_SEED,
        owner.as_ref(),
        strategy_id.as_ref(),
        bump.as_ref(),
    ];
    invoke_signed(&instruction, &cpi_accounts, &[signer_seeds])?;

    let (return_program, return_bytes) =
        get_return_data().ok_or_else(|| error!(RiseAdapterError::MissingReturnData))?;
    validate_return_data(return_program, &return_bytes, action, args.base_lots)?;

    let (post_position, post_collateral) =
        read_position_and_collateral(&ctx.accounts.trader_account, ctx.accounts.strategy.asset_id)?;
    let expected_post = match action {
        OrderAction::EnterShort => -(args.base_lots as i64),
        OrderAction::CloseShort => 0,
    };
    require!(
        post_position == expected_post,
        RiseAdapterError::PositionPostconditionFailed
    );
    require!(
        post_collateral >= args.min_post_collateral_quote_lots,
        RiseAdapterError::CollateralPostconditionFailed
    );
    let strategy = ctx.accounts.strategy.key();
    let trader_account = ctx.accounts.trader_account.key();
    let action = [match action {
        OrderAction::EnterShort => 1,
        OrderAction::CloseShort => 0,
    }];
    Ok(hashv(&[
        TYPED_EVIDENCE_DOMAIN,
        strategy.as_ref(),
        trader_account.as_ref(),
        action.as_ref(),
        return_bytes.as_slice(),
        &pre_position.to_le_bytes(),
        &post_position.to_le_bytes(),
        &post_collateral.to_le_bytes(),
        &args.client_order_id.to_le_bytes(),
    ])
    .to_bytes())
}

fn validate_and_collect_accounts<'info>(
    ctx: &Context<'info, ExecuteRiseOrder<'info>>,
) -> Result<(Vec<Pubkey>, Vec<Pubkey>, Vec<AccountInfo<'info>>)> {
    let global_data = ctx.accounts.global_config.try_borrow_data()?;
    let global = GlobalConfig::try_from_account_bytes(&global_data)
        .map_err(|_| error!(RiseAdapterError::InvalidRiseAccountData))?;
    require!(
        global.account_key() == ctx.accounts.global_config.key().to_bytes()
            && global.perp_asset_map_key() == ctx.accounts.perp_asset_map.key().to_bytes(),
        RiseAdapterError::GlobalConfigMismatch
    );
    require!(
        global.is_exchange_active(LastRestartSlot::Unknown),
        RiseAdapterError::ExchangeInactive
    );
    require!(
        global.global_trader_index_header_key()
            == ctx.accounts.global_trader_index_header.key().to_bytes()
            && global.active_trader_buffer_header_key()
                == ctx.accounts.active_trader_buffer_header.key().to_bytes(),
        RiseAdapterError::GlobalConfigMismatch
    );
    drop(global_data);

    validate_trader(ctx)?;

    let gti_count = arena_count(
        &ctx.accounts.global_trader_index_header,
        PhoenixAccount::GlobalTraderIndexHeader,
    )?;
    let atb_count = arena_count(
        &ctx.accounts.active_trader_buffer_header,
        PhoenixAccount::ActiveTraderBufferHeader,
    )?;
    let gti_extra_count = gti_count
        .checked_sub(1)
        .ok_or_else(|| error!(RiseAdapterError::InvalidArenaAccounts))?;
    let atb_extra_count = atb_count
        .checked_sub(1)
        .ok_or_else(|| error!(RiseAdapterError::InvalidArenaAccounts))?;
    require!(
        ctx.remaining_accounts.len() == gti_extra_count + atb_extra_count,
        RiseAdapterError::InvalidArenaAccounts
    );
    let (gti_extra, atb_extra) = ctx.remaining_accounts.split_at(gti_extra_count);
    validate_arena_extras(
        gti_extra,
        GLOBAL_TRADER_INDEX_SEED,
        PhoenixAccount::GlobalTraderIndexArenaHeader,
    )?;
    validate_arena_extras(
        atb_extra,
        ACTIVE_TRADER_BUFFER_SEED,
        PhoenixAccount::ActiveTraderBufferArenaHeader,
    )?;

    let mut global_trader_index = Vec::with_capacity(gti_count);
    global_trader_index.push(ctx.accounts.global_trader_index_header.key());
    global_trader_index.extend(gti_extra.iter().map(AccountInfo::key));
    let mut active_trader_buffer = Vec::with_capacity(atb_count);
    active_trader_buffer.push(ctx.accounts.active_trader_buffer_header.key());
    active_trader_buffer.extend(atb_extra.iter().map(AccountInfo::key));

    let mut account_infos = Vec::with_capacity(9 + gti_count + atb_count);
    account_infos.push(ctx.accounts.phoenix_program.to_account_info());
    account_infos.push(ctx.accounts.log_authority.to_account_info());
    account_infos.push(ctx.accounts.global_config.to_account_info());
    account_infos.push(ctx.accounts.strategy.to_account_info());
    account_infos.push(ctx.accounts.permission_account.to_account_info());
    account_infos.push(ctx.accounts.trader_account.to_account_info());
    account_infos.push(ctx.accounts.perp_asset_map.to_account_info());
    account_infos.push(ctx.accounts.global_trader_index_header.to_account_info());
    account_infos.extend(gti_extra.iter().cloned());
    account_infos.push(ctx.accounts.active_trader_buffer_header.to_account_info());
    account_infos.extend(atb_extra.iter().cloned());
    Ok((global_trader_index, active_trader_buffer, account_infos))
}

fn validate_trader(ctx: &Context<ExecuteRiseOrder>) -> Result<()> {
    let data = ctx.accounts.trader_account.try_borrow_data()?;
    let trader = TraderHeader::try_read_from_account_bytes(&data)
        .map_err(|_| error!(RiseAdapterError::InvalidRiseAccountData))?;
    require!(
        trader.key() == &ctx.accounts.trader_account.key().to_bytes()
            && trader.authority() == &ctx.accounts.strategy.owner.to_bytes()
            && trader.trader_pda_index() == ctx.accounts.strategy.trader_pda_index
            && trader.trader_subaccount_index() == ctx.accounts.strategy.trader_subaccount_index,
        RiseAdapterError::InvalidTraderIdentity
    );
    require!(
        trader.position_authority() == &ctx.accounts.strategy.key().to_bytes(),
        RiseAdapterError::InvalidPositionAuthority
    );
    Ok(())
}

fn arena_count(account: &UncheckedAccount, kind: PhoenixAccount) -> Result<usize> {
    require!(
        account.is_writable,
        RiseAdapterError::RiseAccountNotWritable
    );
    let data = account.try_borrow_data()?;
    let header =
        MultiArenaHeader::try_from_account_bytes(kind.account_name(), &data, kind.discriminant())
            .map_err(|_| error!(RiseAdapterError::InvalidRiseAccountData))?;
    let count = usize::from(
        header
            .superblock()
            .num_arenas()
            .min(header.superblock().num_active_arenas()),
    );
    require!(
        count > 0 && count <= 256,
        RiseAdapterError::InvalidArenaAccounts
    );
    Ok(count)
}

fn validate_arena_extras(
    accounts: &[AccountInfo],
    seed: &[u8],
    kind: PhoenixAccount,
) -> Result<()> {
    for (offset, account) in accounts.iter().enumerate() {
        require!(
            account.is_writable,
            RiseAdapterError::RiseAccountNotWritable
        );
        require_keys_eq!(
            *account.owner,
            RISE_PROGRAM_ID,
            RiseAdapterError::InvalidRiseAccountOwner
        );
        let index =
            u8::try_from(offset + 1).map_err(|_| error!(RiseAdapterError::InvalidArenaAccounts))?;
        let expected = Pubkey::find_program_address(&[seed, &[index]], &RISE_PROGRAM_ID).0;
        require_keys_eq!(*account.key, expected, RiseAdapterError::InvalidArenaPda);
        let data = account.try_borrow_data()?;
        require!(
            data.get(..8) == Some(kind.discriminant().as_slice()),
            RiseAdapterError::InvalidRiseAccountData
        );
    }
    Ok(())
}

pub fn read_position_and_collateral(
    account: &UncheckedAccount,
    asset_id: u32,
) -> Result<(i64, i64)> {
    let data = account.try_borrow_data()?;
    let header = TraderHeader::try_read_from_account_bytes(&data)
        .map_err(|_| error!(RiseAdapterError::InvalidRiseAccountData))?;
    let positions = TraderPositions::try_from_account_bytes(&data)
        .map_err(|_| error!(RiseAdapterError::InvalidRiseAccountData))?;
    let position = positions
        .iter()
        .find(|entry| entry.asset_id == u64::from(asset_id))
        .map(|entry| entry.position.base_lot_position.as_inner())
        .unwrap_or(0);
    Ok((position, header.state().quote_lot_collateral.as_inner()))
}

fn validate_return_data(
    program_id: Pubkey,
    data: &[u8],
    action: OrderAction,
    expected_base_lots: u64,
) -> Result<MatchingEngineCPIResponse> {
    require_keys_eq!(
        program_id,
        RISE_PROGRAM_ID,
        RiseAdapterError::WrongReturnDataProgram
    );
    let response = decode_matching_engine_cpi_response(data)
        .map_err(|_| error!(RiseAdapterError::InvalidReturnData))?;
    let filled_base_lots = match action {
        OrderAction::EnterShort => response.num_base_lots_in,
        OrderAction::CloseShort => response.num_base_lots_out,
    };
    require!(
        filled_base_lots == expected_base_lots,
        RiseAdapterError::IncompleteFill
    );
    require!(
        response.num_base_lots_posted == 0 && response.num_quote_lots_posted == 0,
        RiseAdapterError::UnexpectedPostedLiquidity
    );
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn return_data_rejects_wrong_program_and_schema() {
        let bytes = [0u8; core::mem::size_of::<MatchingEngineCPIResponse>()];
        assert!(
            validate_return_data(Pubkey::new_unique(), &bytes, OrderAction::EnterShort, 1).is_err()
        );
        assert!(
            validate_return_data(RISE_PROGRAM_ID, &bytes[..8], OrderAction::EnterShort, 1).is_err()
        );
    }

    #[test]
    fn return_data_enforces_exact_directional_fill() {
        let mut enter = [0u8; core::mem::size_of::<MatchingEngineCPIResponse>()];
        enter[24..32].copy_from_slice(&7u64.to_le_bytes());
        assert!(validate_return_data(RISE_PROGRAM_ID, &enter, OrderAction::EnterShort, 7).is_ok());
        assert!(validate_return_data(RISE_PROGRAM_ID, &enter, OrderAction::EnterShort, 8).is_err());

        let mut close = [0u8; core::mem::size_of::<MatchingEngineCPIResponse>()];
        close[40..48].copy_from_slice(&7u64.to_le_bytes());
        assert!(validate_return_data(RISE_PROGRAM_ID, &close, OrderAction::CloseShort, 7).is_ok());
    }
}

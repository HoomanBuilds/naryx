pub mod constants;
pub mod engine;
pub mod error;
pub mod events;
pub mod instructions;
pub mod oracle;
pub mod read;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use read::read_position_and_collateral;
pub use state::*;

declare_id!("CpAqHqcpegSm8NCedsDVvwg85jozNa46Qz1TGNyVyLTr");

#[program]
pub mod naryx_test_perp {
    use super::*;

    pub fn initialize_market(
        ctx: Context<InitializeMarket>,
        args: InitializeMarketArgs,
    ) -> Result<()> {
        initialize_market::handler(ctx, args)
    }

    pub fn initialize_position(ctx: Context<InitializePosition>) -> Result<()> {
        position::initialize_position_handler(ctx)
    }

    pub fn set_delegate(ctx: Context<SetDelegate>, delegate: Pubkey) -> Result<()> {
        position::set_delegate_handler(ctx, delegate)
    }

    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        position::deposit_handler(ctx, amount)
    }

    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        position::withdraw_handler(ctx, amount)
    }

    pub fn place_market_order(
        ctx: Context<TradePosition>,
        args: PlaceMarketOrderArgs,
    ) -> Result<()> {
        trade::place_market_order_handler(ctx, args)
    }

    pub fn place_bounded_residual_order(
        ctx: Context<TradeBoundedResidual>,
        args: PlaceBoundedResidualArgs,
    ) -> Result<()> {
        trade::place_bounded_residual_order_handler(ctx, args)
    }

    pub fn liquidate(ctx: Context<TradePosition>) -> Result<()> {
        trade::liquidate_handler(ctx)
    }

    pub fn set_funding_rate(
        ctx: Context<SetFundingRate>,
        funding_rate_per_second: i64,
    ) -> Result<()> {
        admin::set_funding_rate_handler(ctx, funding_rate_per_second)
    }

    pub fn claim_test_collateral(ctx: Context<ClaimTestCollateral>, amount: u64) -> Result<()> {
        faucet::claim_test_collateral_handler(ctx, amount)
    }

    pub fn update_market_controls(
        ctx: Context<UpdateMarketControls>,
        pause_opens: bool,
        funding_keeper: Pubkey,
    ) -> Result<()> {
        admin::update_market_controls_handler(ctx, pause_opens, funding_keeper)
    }

    pub fn update_oracle_risk_controls(
        ctx: Context<UpdateOracleRiskControls>,
        max_price_age_seconds: u32,
        max_confidence_bps: u16,
    ) -> Result<()> {
        admin::update_oracle_risk_controls_handler(ctx, max_price_age_seconds, max_confidence_bps)
    }
}

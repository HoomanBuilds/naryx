use anchor_lang::prelude::*;

#[error_code]
pub enum TestPerpError {
    #[msg("Market parameters are invalid")]
    InvalidMarketParameters,
    #[msg("Oracle account is not owned by the Pyth receiver")]
    OracleOwnerInvalid,
    #[msg("Oracle account is not the market oracle")]
    OracleAccountMismatch,
    #[msg("Oracle account data is invalid")]
    OracleDataInvalid,
    #[msg("Oracle update is not fully verified")]
    OracleNotFullyVerified,
    #[msg("Oracle feed id does not match the market")]
    OracleFeedMismatch,
    #[msg("Oracle price is stale")]
    OracleStale,
    #[msg("Oracle confidence is too wide")]
    OracleConfidenceTooWide,
    #[msg("Oracle price is not positive")]
    OraclePriceInvalid,
    #[msg("Arithmetic overflow")]
    ArithmeticOverflow,
    #[msg("Signer is not authorized for this position")]
    Unauthorized,
    #[msg("Order base lots is invalid")]
    InvalidBaseLots,
    #[msg("Order limit price is zero")]
    LimitPriceZero,
    #[msg("Order deadline has expired")]
    OrderExpired,
    #[msg("Fill price is worse than the limit")]
    LimitPriceExceeded,
    #[msg("Order size exceeds the maximum slippage")]
    SlippageTooLarge,
    #[msg("Reduce-only order would open or increase exposure")]
    ReduceOnlyViolation,
    #[msg("Market is paused for opening exposure")]
    OpensPaused,
    #[msg("Market must be paused before oracle risk controls change")]
    MarketMustBePaused,
    #[msg("Position exceeds the market maximum")]
    PositionLimitExceeded,
    #[msg("Initial margin requirement is not met")]
    InsufficientInitialMargin,
    #[msg("Withdrawal exceeds free collateral")]
    InsufficientFreeCollateral,
    #[msg("Insurance vault cannot cover the trader credit")]
    InsufficientInsurance,
    #[msg("Position is not liquidatable")]
    NotLiquidatable,
    #[msg("Funding rate exceeds the market bound")]
    FundingRateOutOfBounds,
    #[msg("Amount is zero")]
    ZeroAmount,
    #[msg("Position account is invalid")]
    InvalidPositionAccount,
    #[msg("Faucet claim exceeds the per-claim or balance limit")]
    FaucetLimitExceeded,
    #[msg("Mint is not a faucet test collateral mint")]
    InvalidFaucetMint,
    #[msg("Netting residual intent hash is zero")]
    InvalidResidualIntent,
    #[msg("Netting residual fee exceeds the signed maximum")]
    ResidualFeeExceeded,
}

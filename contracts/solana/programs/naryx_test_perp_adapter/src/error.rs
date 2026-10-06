use anchor_lang::prelude::*;

#[error_code]
pub enum TestPerpAdapterError {
    #[msg("Strategy identifier is all zero")]
    StrategyIdZero,
    #[msg("Controller is the default public key")]
    ControllerZero,
    #[msg("Maximum base lots is invalid")]
    InvalidMaxBaseLots,
    #[msg("Order base lots is invalid")]
    InvalidBaseLots,
    #[msg("Limit price in ticks is zero")]
    LimitPriceZero,
    #[msg("Order deadline has expired")]
    OrderExpired,
    #[msg("Strategy controller is unauthorized")]
    UnauthorizedController,
    #[msg("Test perp market or position does not match the strategy")]
    InvalidMarketIdentity,
    #[msg("Test perp position has not delegated trading to this strategy")]
    InvalidPositionAuthority,
    #[msg("Test perp orders take no extra accounts")]
    UnexpectedRemainingAccounts,
    #[msg("Entry requires a flat position")]
    EntryPositionNotFlat,
    #[msg("Close requires the exact current short position")]
    ClosePositionMismatch,
    #[msg("Authoritative test perp position postcondition failed")]
    PositionPostconditionFailed,
    #[msg("Authoritative test perp collateral postcondition failed")]
    CollateralPostconditionFailed,
    #[msg("Typed strategy payload is not a supported test perp adapter instruction")]
    TypedPayloadInvalid,
}

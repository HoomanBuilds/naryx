use anchor_lang::prelude::*;

#[error_code]
pub enum RiseAdapterError {
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
    #[msg("Rise program account is invalid")]
    InvalidRiseProgram,
    #[msg("Rise account owner is invalid")]
    InvalidRiseAccountOwner,
    #[msg("Rise account is not writable")]
    RiseAccountNotWritable,
    #[msg("Rise account data is invalid")]
    InvalidRiseAccountData,
    #[msg("Rise global configuration does not match its account")]
    GlobalConfigMismatch,
    #[msg("Rise exchange is not active")]
    ExchangeInactive,
    #[msg("Rise arena account list is invalid")]
    InvalidArenaAccounts,
    #[msg("Rise arena PDA is invalid")]
    InvalidArenaPda,
    #[msg("Rise trader account PDA is invalid")]
    InvalidTraderPda,
    #[msg("Rise trader identity is invalid")]
    InvalidTraderIdentity,
    #[msg("Rise trader has not delegated position authority to this strategy")]
    InvalidPositionAuthority,
    #[msg("Rise market identity is invalid")]
    InvalidMarketIdentity,
    #[msg("Rise spline collection is invalid")]
    InvalidSplineCollection,
    #[msg("Strategy controller is unauthorized")]
    UnauthorizedController,
    #[msg("Entry requires a flat position")]
    EntryPositionNotFlat,
    #[msg("Close requires the exact current short position")]
    ClosePositionMismatch,
    #[msg("Rise instruction construction failed")]
    InstructionBuildFailed,
    #[msg("Rise returned no CPI result")]
    MissingReturnData,
    #[msg("CPI return data came from the wrong program")]
    WrongReturnDataProgram,
    #[msg("Rise CPI return data has an invalid schema")]
    InvalidReturnData,
    #[msg("Rise did not fill the exact requested base lots")]
    IncompleteFill,
    #[msg("Rise unexpectedly posted liquidity for an immediate-or-cancel order")]
    UnexpectedPostedLiquidity,
    #[msg("Authoritative Rise position postcondition failed")]
    PositionPostconditionFailed,
    #[msg("Authoritative Rise collateral postcondition failed")]
    CollateralPostconditionFailed,
    #[msg("Typed strategy payload is not a supported Rise adapter instruction")]
    TypedPayloadInvalid,
}

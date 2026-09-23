use anchor_lang::prelude::*;

#[error_code]
pub enum ErrorCode {
    #[msg("Price components must be nonzero")]
    InvalidPrice,
    #[msg("Price ratio must be reduced")]
    PriceNotReduced,
    #[msg("Spot fee is above the basis-point denominator")]
    InvalidFeeBps,
    #[msg("Initial margin must be between one and ten thousand basis points")]
    InvalidMarginBps,
    #[msg("Market caps must be nonzero")]
    InvalidCap,
    #[msg("Market is paused")]
    MarketPaused,
    #[msg("Trade amount is zero")]
    TradeAmountZero,
    #[msg("Trade amount exceeds the configured cap")]
    AmountCapExceeded,
    #[msg("Checked arithmetic overflowed")]
    ArithmeticOverflow,
    #[msg("Execution exceeds the caller's limit")]
    SlippageExceeded,
    #[msg("Spot sell would return no quote asset")]
    InsufficientQuoteOutput,
    #[msg("Signer is not the market administrator")]
    UnauthorizedAdmin,
    #[msg("Account belongs to a different market")]
    MarketMismatch,
    #[msg("Vault does not match market configuration")]
    VaultMismatch,
    #[msg("Token mint does not match market configuration")]
    MintMismatch,
    #[msg("Position belongs to a different trader")]
    PositionOwnerMismatch,
    #[msg("Close quantity would increase or reverse the short")]
    ReduceOnlyViolation,
}

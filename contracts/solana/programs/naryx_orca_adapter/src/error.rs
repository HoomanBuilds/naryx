use anchor_lang::prelude::*;

#[error_code]
pub enum ErrorCode {
    #[msg("Swap amount must be nonzero")]
    AmountZero,
    #[msg("Swap threshold must be nonzero")]
    ThresholdZero,
    #[msg("Input and output token mints must differ")]
    TokenMintsEqual,
    #[msg("Observed token balance moved in the wrong direction")]
    BalanceDirectionInvalid,
    #[msg("Exact-output swap did not receive the requested amount")]
    ExactOutputMismatch,
    #[msg("Exact-output swap exceeded its maximum input")]
    MaximumInputExceeded,
    #[msg("Exact-input swap did not spend the requested amount")]
    ExactInputMismatch,
    #[msg("Exact-input swap returned less than its minimum output")]
    MinimumOutputNotMet,
    #[msg("Swap instruction serialization failed")]
    SerializationFailed,
    #[msg("Typed strategy payload is not a supported Orca adapter instruction")]
    TypedPayloadInvalid,
}

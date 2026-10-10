use anchor_lang::prelude::*;

#[error_code]
pub enum ErrorCode {
    #[msg("The package inventory configuration is invalid")]
    InvalidConfiguration,
    #[msg("The typed inventory payload is invalid")]
    InvalidPayload,
    #[msg("The inventory precondition does not match current custody")]
    PreconditionFailed,
    #[msg("The inventory transfer did not produce the exact postcondition")]
    PostconditionFailed,
    #[msg("Inventory arithmetic overflowed")]
    ArithmeticOverflow,
    #[msg("The inventory leg is not bound to the executing package")]
    PackageMismatch,
    #[msg("A risk-increasing inventory action was labelled non-increasing")]
    RiskDirectionMismatch,
}

use anchor_lang::prelude::*;

#[error_code]
pub enum ErrorCode {
    #[msg("Program code identity does not match the pinned identity")]
    CodeIdentityMismatch,
    #[msg("Program account is not a supported upgradeable program")]
    ProgramUnsupported,
    #[msg("Reservation class parameter is invalid")]
    ClassParameterInvalid,
    #[msg("Reservation domain is not the active core domain")]
    DomainInactive,
    #[msg("Core entry is paused")]
    EntryPaused,
    #[msg("Reservation commitment is zero")]
    CommitmentZero,
    #[msg("Reservation nonce is zero")]
    ReservationNonceZero,
    #[msg("Package nonce is zero")]
    PackageNonceZero,
    #[msg("Reservation ID is not canonical")]
    ReservationIdMismatch,
    #[msg("Reservation amount is zero or exceeds its cap")]
    AmountInvalid,
    #[msg("Reservation expiry is invalid")]
    ExpiryInvalid,
    #[msg("Aggregate reserved inventory cap would be exceeded")]
    AggregateCapacityExceeded,
    #[msg("Aggregate reserved inventory accounting underflowed")]
    AggregateCapacityUnderflow,
    #[msg("Reservation is not in the required state")]
    ReservationStateInvalid,
    #[msg("Reservation has expired")]
    ReservationExpired,
    #[msg("Reservation has not expired")]
    ReservationNotExpired,
    #[msg("Reservation account binding does not match")]
    AccountBindingMismatch,
    #[msg("Strategy authority is not controlled by the pinned consumer program")]
    ConsumerAuthorityInvalid,
    #[msg("Legacy SPL token balance delta is not exact")]
    TokenDeltaMismatch,
    #[msg("Checked arithmetic failed")]
    ArithmeticFailure,
}

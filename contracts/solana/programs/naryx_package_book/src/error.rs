use anchor_lang::prelude::*;

#[error_code]
pub enum ErrorCode {
    #[msg("Program code identity does not match the pinned identity")]
    CodeIdentityMismatch,
    #[msg("Program account is not a supported upgradeable program")]
    ProgramUnsupported,
    #[msg("Package book class parameter is invalid")]
    ClassParameterInvalid,
    #[msg("Account binding does not match the pinned package book state")]
    AccountBindingMismatch,
    #[msg("Pinned core domain is not active")]
    DomainInactive,
    #[msg("Solver protocol ID is invalid")]
    SolverIdInvalid,
    #[msg("A required identity hash is zero")]
    IdentityHashZero,
    #[msg("Reference package price is outside its configured bound")]
    ReferencePriceOutOfBounds,
    #[msg("Reference state hash is zero")]
    ReferenceStateHashZero,
    #[msg("Sequence does not match the optimistic state")]
    SequenceMismatch,
    #[msg("Sequence arithmetic overflowed")]
    SequenceOverflow,
    #[msg("Heartbeat expiry is stale or exceeds the class maximum")]
    HeartbeatInvalid,
    #[msg("Quote level update batch is empty or too large")]
    BatchSizeInvalid,
    #[msg("Quote level slot is outside the fixed shard capacity")]
    LevelSlotInvalid,
    #[msg("Quote level slot appears more than once in the batch")]
    DuplicateLevelSlot,
    #[msg("Quote level parameters are invalid")]
    LevelParameterInvalid,
    #[msg("Quote level does not exist in the active epoch")]
    LevelInactive,
    #[msg("Quote level has expired")]
    LevelExpired,
    #[msg("Quote level capacity is insufficient")]
    CapacityInsufficient,
    #[msg("Quote mode is unsupported")]
    QuoteModeUnsupported,
    #[msg("FIRM_ONCHAIN is disabled until the consumer verifies reservations")]
    FirmOnchainDisabled,
    #[msg("Reservation ID does not match the quote mode")]
    ReservationIdInvalid,
    #[msg("Package quote shard is killed")]
    ShardKilled,
    #[msg("Consumer authority is not controlled by the pinned consumer program")]
    ConsumerAuthorityInvalid,
    #[msg("A required execution commitment is zero")]
    CommitmentZero,
    #[msg("Checked arithmetic failed")]
    ArithmeticFailure,
}

use anchor_lang::prelude::*;

#[error_code]
pub enum ErrorCode {
    #[msg("Protocol configuration is invalid")]
    InvalidConfiguration,
    #[msg("Strategy account is invalid")]
    InvalidStrategyAccount,
    #[msg("Strategy execution is malformed")]
    InvalidExecution,
    #[msg("Strategy execution is expired")]
    ExecutionExpired,
    #[msg("Strategy nonce does not match")]
    InvalidNonce,
    #[msg("Strategy owner is invalid")]
    InvalidOwner,
    #[msg("Strategy solver is invalid")]
    InvalidSolver,
    #[msg("Strategy entry is paused")]
    EntryPaused,
    #[msg("Strategy state transition is invalid")]
    InvalidStateTransition,
    #[msg("Strategy call stages are invalid")]
    InvalidStageOrder,
    #[msg("Strategy call account layout is invalid")]
    InvalidCallAccounts,
    #[msg("Strategy adapter record is invalid")]
    InvalidAdapterRecord,
    #[msg("Strategy adapter is unavailable for this action")]
    AdapterUnavailable,
    #[msg("Strategy adapter code identity changed")]
    AdapterCodeIdentityMismatch,
    #[msg("Strategy adapter execution failed")]
    AdapterExecutionFailed,
    #[msg("Strategy adapter evidence is invalid")]
    AdapterEvidenceInvalid,
    #[msg("Strategy arithmetic overflowed")]
    ArithmeticOverflow,
    #[msg("Strategy serialization failed")]
    SerializationFailed,
    #[msg("Strategy fee policy is invalid")]
    InvalidFeePolicy,
    #[msg("Strategy fee token accounts are invalid")]
    InvalidFeeAccounts,
}

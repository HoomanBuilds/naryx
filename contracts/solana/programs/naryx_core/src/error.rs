use anchor_lang::prelude::*;

#[error_code]
pub enum ErrorCode {
    #[msg("Domain identifier is not ASCII")]
    DomainIdNotAscii,
    #[msg("Domain identifier is empty")]
    DomainIdEmpty,
    #[msg("Domain identifier is above the protocol identifier byte limit")]
    DomainIdTooLong,
    #[msg("Domain manifest version is zero")]
    DomainManifestVersionZero,
    #[msg("Domain manifest hash is all zero")]
    DomainManifestHashZero,
    #[msg("Governance role key is the default Pubkey")]
    GovernanceRoleKeyZero,
    #[msg("Governance roles must be four distinct keys")]
    GovernanceRoleDuplicate,
    #[msg("Signer does not hold the required governance role")]
    UnauthorizedRole,
    #[msg("Configuration delay in slots is zero")]
    ConfigDelayZero,
    #[msg("Activation slot overflows the slot counter")]
    ActivationSlotOverflow,
    #[msg("A domain proposal is already pending")]
    DomainProposalExists,
    #[msg("No domain proposal is pending")]
    DomainProposalMissing,
    #[msg("Proposed domain manifest version is not newer than the active version")]
    DomainManifestVersionNotIncreasing,
    #[msg("Domain proposal is before its activation slot")]
    DomainProposalNotReady,
    #[msg("Entry is already paused")]
    EntryAlreadyPaused,
    #[msg("Entry is not paused")]
    EntryNotPaused,
    #[msg("An unpause is already scheduled")]
    UnpauseAlreadyScheduled,
    #[msg("No unpause is scheduled")]
    UnpauseNotScheduled,
    #[msg("Scheduled unpause is before its activation slot")]
    UnpauseNotReady,
    #[msg("Protocol identifier is not ASCII")]
    ProtocolIdNotAscii,
    #[msg("Protocol identifier is empty")]
    ProtocolIdEmpty,
    #[msg("Protocol identifier is above the protocol identifier byte limit")]
    ProtocolIdTooLong,
    #[msg("Wire integer has the wrong byte width")]
    WireIntegerWidth,
    #[msg("Wire manifest hash is all zero")]
    WireManifestHashZero,
    #[msg("Wire commitment hash is all zero")]
    WireCommitmentHashZero,
    #[msg("Wire version is zero")]
    WireVersionZero,
    #[msg("Wire positive value is zero")]
    WirePositiveValueZero,
    #[msg("Wire fraction is not in lowest terms")]
    WireFractionNotReduced,
    #[msg("Wire enum discriminant is unknown")]
    WireEnumUnknown,
    #[msg("Wire collection is empty")]
    WireCollectionEmpty,
    #[msg("Wire collection contains a duplicate key")]
    WireCollectionDuplicate,
    #[msg("Wire collection is not canonically ordered")]
    WireCollectionNotCanonical,
    #[msg("Wire collection length exceeds u32")]
    WireCollectionTooLong,
    #[msg("Wire recovery window is zero")]
    WireRecoveryWindowZero,
}

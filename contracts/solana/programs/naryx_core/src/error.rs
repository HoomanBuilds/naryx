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
    #[msg("Wire version does not match the supported version")]
    WireVersionMismatch,
    #[msg("Wire nonce is zero")]
    WireNonceZero,
    #[msg("Wire asset relationship is invalid")]
    WireAssetMismatch,
    #[msg("Wire fee arrays have different asset-key sets")]
    WireFeeKeyMismatch,
    #[msg("Wire fee arithmetic overflowed")]
    WireFeeArithmeticOverflow,
    #[msg("Wire raw fee does not equal normalized fee plus builder fee")]
    WireFeeConservation,
    #[msg("Wire base-asset fee does not match its raw fee entry")]
    WireBaseFeeMismatch,
    #[msg("Wire signature material has an invalid shape")]
    WireSignatureShape,
    #[msg("Wire secp256k1 scalar is outside its valid range")]
    WireSecpScalarInvalid,
    #[msg("Wire secp256k1 signature is not low-s")]
    WireSecpHighS,
    #[msg("Wire secp256k1 recovery identifier is invalid")]
    WireSecpRecoveryId,
    #[msg("Wire terminal residual structure is invalid")]
    WireResidualShape,
    #[msg("Wire recovery cost cap is negative")]
    WireRecoveryCapNegative,
    #[msg("Wire reservation does not match quote mode")]
    WireReservationRule,
    #[msg("Wire firm quote does not have an atomic entry outcome")]
    WireFirmQuoteShape,
    #[msg("Wire version is unsupported")]
    WireVersionUnsupported,
    #[msg("Wire optional fields have an inconsistent shape")]
    WireOptionalShape,
    #[msg("Wire ordered sequence is invalid")]
    WireSequenceInvalid,
    #[msg("Wire route plan shape is invalid")]
    WireRoutePlanShape,
    #[msg("Wire route clock does not match its execution plan")]
    WireRouteClockMismatch,
    #[msg("Wire route reference is unknown")]
    WireRouteReferenceUnknown,
    #[msg("Wire route binding is unused")]
    WireRouteBindingUnused,
    #[msg("Wire route leg shape is invalid")]
    WireRouteLegShape,
    #[msg("Wire payload range is invalid")]
    WirePayloadRangeInvalid,
    #[msg("Wire payload ranges overlap")]
    WirePayloadRangeOverlap,
    #[msg("Wire recovery shape is invalid")]
    WireRecoveryShape,
    #[msg("Wire recovery timing is invalid")]
    WireRecoveryTimingInvalid,
}

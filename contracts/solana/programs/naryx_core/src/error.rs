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
    #[msg("Conformance execution hash is all zero")]
    ConformanceHashZero,
    #[msg("Conformance execution quantity is zero")]
    ConformanceQuantityZero,
    #[msg("Conformance order is expired")]
    ConformanceOrderExpired,
    #[msg("Conformance entry execution is paused")]
    ConformanceEntryPaused,
    #[msg("Conformance execution arithmetic overflowed")]
    ConformanceArithmeticOverflow,
    #[msg("Conformance execution postcondition failed")]
    ConformancePostconditionFailed,
    #[msg("Conformance nonce is zero")]
    ConformanceNonceZero,
    #[msg("Conformance solver key is invalid")]
    ConformanceSolverInvalid,
    #[msg("Conformance solver proposal already exists")]
    ConformanceSolverProposalExists,
    #[msg("Conformance solver proposal is missing")]
    ConformanceSolverProposalMissing,
    #[msg("Conformance solver proposal is not ready")]
    ConformanceSolverProposalNotReady,
    #[msg("Conformance solver signature instruction is invalid")]
    ConformanceSignatureInstructionInvalid,
    #[msg("Conformance solver signature does not bind this execution")]
    ConformanceSignatureMismatch,
    #[msg("Resource subject identifier is all zero")]
    ResourceSubjectZero,
    #[msg("Resource manifest version is zero")]
    ResourceManifestVersionZero,
    #[msg("Resource manifest hash is all zero")]
    ResourceManifestHashZero,
    #[msg("Resource descriptor version is zero")]
    ResourceDescriptorVersionZero,
    #[msg("Resource descriptor hash is all zero")]
    ResourceDescriptorHashZero,
    #[msg("Resource descriptor is not a supported semantic version")]
    ResourceDescriptorUnsupported,
    #[msg("Resource settlement class is not supported")]
    ResourceSettlementUnsupported,
    #[msg("Resource quote limit is missing")]
    ResourceQuoteLimitMissing,
    #[msg("Resource quote limit is not allowed for this resource kind")]
    ResourceQuoteLimitUnexpected,
    #[msg("Resource quote limit does not bind the exact quote asset and decimals")]
    ResourceQuoteLimitMismatch,
    #[msg("Resource maximum notional is zero")]
    ResourceMaximumNotionalZero,
    #[msg("Resource market unit is zero")]
    ResourceMarketUnitZero,
    #[msg("Resource market multiplier is not in lowest terms")]
    ResourceMarketMultiplierNotReduced,
    #[msg("Resource reference shape is invalid")]
    ResourceReferenceShape,
    #[msg("Resource address is the default Pubkey")]
    ResourceAddressZero,
    #[msg("Resource account identity is invalid")]
    ResourceAccountMismatch,
    #[msg("Resource program is not recognized")]
    ResourceProgramUnsupported,
    #[msg("Resource program or code identity changed")]
    ResourceCodeIdentityMismatch,
    #[msg("Resource decimals do not match the mint")]
    ResourceDecimalsMismatch,
    #[msg("Resource role is invalid for this kind")]
    ResourceRoleMismatch,
    #[msg("Resource manifest domain does not match the active domain")]
    ResourceDomainMismatch,
    #[msg("Resource index does not match the proposed record")]
    ResourceIndexMismatch,
    #[msg("A resource registration proposal is already pending")]
    ResourceRegistrationExists,
    #[msg("No resource registration proposal is pending")]
    ResourceRegistrationMissing,
    #[msg("Resource registration is before its activation slot")]
    ResourceRegistrationNotReady,
    #[msg("Resource manifest version is not newer than the last proposed version")]
    ResourceManifestVersionNotIncreasing,
    #[msg("Resource is already active")]
    ResourceAlreadyActive,
    #[msg("Resource is not the active record for its subject")]
    ResourceNotActive,
    #[msg("A resource control proposal is already pending")]
    ResourceControlProposalExists,
    #[msg("No resource control proposal is pending")]
    ResourceControlProposalMissing,
    #[msg("Resource control proposal is before its activation slot")]
    ResourceControlProposalNotReady,
    #[msg("Deprecated resource control is terminal")]
    ResourceDeprecatedTerminal,
    #[msg("Immediate resource control update would widen permissions or risk")]
    ResourceUnsafeImmediateControl,
    #[msg("Resource does not permit this action")]
    ResourceActionNotAllowed,
    #[msg("Resource package notional exceeds an exact quote-asset limit")]
    ResourceMaximumNotionalExceeded,
    #[msg("Resource leg quantity or limit price is zero")]
    ResourceLegValueZero,
    #[msg("Resource leg quantity is not aligned to the market base lot")]
    ResourceBaseLotMismatch,
    #[msg("Resource leg limit price is not aligned to the market quote tick")]
    ResourceQuoteTickMismatch,
    #[msg("Resource leg quote notional is below the market minimum")]
    ResourceMinimumNotionalNotMet,
    #[msg("Resource leg notional arithmetic overflowed")]
    ResourceNotionalOverflow,
    #[msg("Cash-and-carry legs do not carry equal multiplier-adjusted base quantity")]
    ResourceEconomicQuantityMismatch,
    #[msg("Resource package notional does not equal the larger exact leg notional")]
    ResourcePackageNotionalMismatch,
    #[msg("Cash-and-carry resources are not distinct where required")]
    ResourceInstancesNotDistinct,
    #[msg("Cash-and-carry execution hash is all zero")]
    CashCarryHashZero,
    #[msg("Cash-and-carry execution nonce is zero")]
    CashCarryNonceZero,
    #[msg("Cash-and-carry execution is expired")]
    CashCarryOrderExpired,
    #[msg("Cash-and-carry entry execution is paused")]
    CashCarryEntryPaused,
    #[msg("Cash-and-carry solver is invalid")]
    CashCarrySolverInvalid,
    #[msg("Cash-and-carry solver signature instruction is invalid")]
    CashCarrySignatureInstructionInvalid,
    #[msg("Cash-and-carry solver signature does not bind this execution")]
    CashCarrySignatureMismatch,
    #[msg("Cash-and-carry execution account is not the active resource")]
    CashCarryResourceNotCurrent,
    #[msg("Cash-and-carry execution account does not match the admitted resource")]
    CashCarryResourceAccountMismatch,
    #[msg("Cash-and-carry token account does not match the admitted asset")]
    CashCarryTokenAccountMismatch,
    #[msg("Cash-and-carry route direction is invalid")]
    CashCarryRouteDirectionInvalid,
    #[msg("Cash-and-carry execution arithmetic overflowed")]
    CashCarryArithmeticOverflow,
    #[msg("Cash-and-carry position or token postcondition failed")]
    CashCarryPostconditionFailed,
    #[msg("Cash-and-carry Rise collateral must be prefunded")]
    CashCarryCollateralNotPrefunded,
    #[msg("Cash-and-carry Rise collateral is below the signed floor")]
    CashCarryCollateralBelowFloor,
    #[msg("Cash-and-carry package is already open")]
    CashCarryPackageAlreadyOpen,
    #[msg("Cash-and-carry package is not open")]
    CashCarryPackageNotOpen,
    #[msg("Cash-and-carry exit does not match the open package")]
    CashCarryOpenPackageMismatch,
    #[msg("Cash-and-carry entry receipt is invalid")]
    CashCarryEntryReceiptInvalid,
    #[msg("Cash-and-carry recovery mode is only valid for exit")]
    CashCarryRecoveryInvalid,
    #[msg("Cash-and-carry quoted execution is only valid for a normal entry")]
    CashCarryQuoteActionInvalid,
    #[msg("Cash-and-carry package quote parameters are invalid")]
    CashCarryQuoteParameterInvalid,
    #[msg("Cash-and-carry package-book account binding is invalid")]
    CashCarryQuoteAccountMismatch,
    #[msg("Cash-and-carry package-book code identity changed")]
    CashCarryQuoteCodeIdentityMismatch,
    #[msg("Cash-and-carry package-book return data is invalid")]
    CashCarryQuoteReturnDataInvalid,
}

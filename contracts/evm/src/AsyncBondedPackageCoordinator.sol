// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "openzeppelin-contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "openzeppelin-contracts/utils/cryptography/EIP712.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/utils/ReentrancyGuard.sol";
import {ProtocolConfig} from "./ProtocolConfig.sol";
import {IAsyncVenueAdapter} from "./interfaces/IAsyncVenueAdapter.sol";
import {OwnerSignature} from "./libraries/OwnerSignature.sol";

contract AsyncBondedPackageCoordinator is EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant EXECUTION_CLASS_ID = keccak256("ASYNC_BONDED_SOLVER");
    bytes32 public constant EVIDENCE_SCHEMA_ID = keccak256("NARYX_ASYNC_VENUE_EVIDENCE_V1");
    bytes32 private constant RESERVE_TYPEHASH = keccak256("ReserveAsyncPackage(bytes32 termsHash)");
    bytes32 private constant RECOVERY_POLICY_ID = keccak256("NARYX_ASYNC_CANCEL_OR_RECONCILE_V1");

    enum State {
        NONE,
        RESERVED,
        REQUEST_SUBMITTED,
        VENUE_PENDING,
        EXECUTED,
        CANCELLED,
        FROZEN,
        RECOVERY_PENDING,
        RECOVERED,
        MANUAL_INTERVENTION,
        CLOSED
    }

    enum Outcome {
        EXECUTED,
        CANCELLED,
        FROZEN,
        RECOVERED
    }

    struct DomainRef {
        bytes32 domainIdHash;
        uint32 manifestVersion;
        bytes32 manifestHash;
    }

    struct Admission {
        address handler;
        bytes32 adapterCodeHash;
        bytes32 handlerCodeHash;
        bool active;
        uint64 generation;
    }

    struct PendingAdmission {
        Admission admission;
        uint64 activationTimestamp;
    }

    struct PendingExecutionClass {
        bytes32 manifestHash;
        uint64 activationTimestamp;
    }

    struct Terms {
        DomainRef domain;
        address owner;
        address solver;
        address adapter;
        address handler;
        bytes32 adapterCodeHash;
        bytes32 handlerCodeHash;
        bytes32 orderHash;
        bytes32 quoteHash;
        bytes32 routeHash;
        bytes32 seriesIdentityKey;
        uint32 seriesBindingVersion;
        bytes32 seriesBindingHash;
        bytes32 executionClassIdentityHash;
        bytes32 executionClassManifestHash;
        bytes32 requestPayloadHash;
        bytes32 reservationHash;
        bytes32 bondHash;
        bytes32 recoveryPolicyHash;
        bytes32 evidenceSchemaHash;
        address bondRecipient;
        address recoveryReserveRecipient;
        address slashRecipient;
        address lossAsset;
        address residualAsset;
        uint256 bondAtoms;
        uint256 recoveryReserveAtoms;
        uint256 maxAggregateLossAtoms;
        uint256 maxIntermediateResidualAtoms;
        uint256 maxTerminalResidualAtoms;
        uint256 nonce;
        uint64 submissionDeadline;
        uint64 venueDeadline;
        uint64 recoveryDeadline;
    }

    struct Package {
        Terms terms;
        bytes32 requestKey;
        bytes32 outcomeEvidenceHash;
        bytes32 recoveryEvidenceHash;
        bytes32 venueEvidenceCommitment;
        bytes32 recoveryEvidenceCommitment;
        State state;
        uint64 stateVersion;
        uint64 admissionGeneration;
        uint64 recoveryDutyStartedAt;
        Outcome lastVenueOutcome;
        bool hasVenueOutcome;
        bool recoveryDutyActive;
        bool recoveryActionSubmitted;
        bool recoveryProven;
        bool bondSlashed;
        bool evidenceConflict;
        uint256 settledLossAtoms;
    }

    struct VenueEvidence {
        bytes32 requestKey;
        bytes32 requestPayloadHash;
        bytes32 evidenceSchemaHash;
        bytes32 evidenceHash;
        Outcome outcome;
        address lossAsset;
        address residualAsset;
        uint256 observedLossAtoms;
        uint256 intermediateResidualAtoms;
        uint256 terminalResidualAtoms;
    }

    error InvalidConfiguration();
    error InvalidAdmission();
    error AdmissionExists();
    error AdmissionMissing();
    error AdmissionNotReady();
    error UnauthorizedRole();
    error DeploymentChanged();
    error DomainMismatch();
    error InvalidTerms();
    error InvalidSignature();
    error InvalidNonce();
    error PackageExists();
    error PackageMissing();
    error WrongState();
    error WrongVersion();
    error DeadlineNotReached();
    error DeadlinePassed();
    error UnauthorizedActor();
    error InvalidRequest();
    error InvalidEvidence();
    error FundingMismatch();
    error ReleaseLocked();
    error ExecutionClassManifestHashZero();
    error ExecutionClassManifestHashUsed(bytes32 manifestHash);
    error ExecutionClassProposalExists();
    error ExecutionClassProposalMissing();
    error ExecutionClassProposalNotReady(uint64 activationTimestamp);
    error ActivationTimestampOverflow();

    event AdmissionProposed(address indexed adapter, address indexed handler, uint64 activationTimestamp);
    event AdmissionActivated(address indexed adapter, address indexed handler);
    event AdmissionPaused(address indexed adapter);
    event ExecutionClassProposed(
        address indexed actor, bytes32 previousHash, bytes32 proposedHash, uint64 activationTimestamp
    );
    event ExecutionClassProposalCancelled(
        address indexed actor, bytes32 activeHash, bytes32 cancelledHash, uint64 activationTimestamp
    );
    event ExecutionClassActivated(address indexed actor, bytes32 previousHash, bytes32 newHash);
    event PackageTransition(bytes32 indexed packageId, State state, uint64 stateVersion, bytes32 evidenceHash);
    event RequestRegistered(bytes32 indexed packageId, bytes32 indexed requestKey);
    event RecoveryActionSubmitted(bytes32 indexed packageId, bytes32 indexed requestKey);
    event BondSlashed(bytes32 indexed packageId, uint256 bondAtoms);
    event PackageReleased(
        bytes32 indexed packageId,
        address bondRecipient,
        address reserveRecipient,
        uint256 reserveAtoms,
        address lossRecipient,
        uint256 lossAtoms
    );

    ProtocolConfig public immutable config;
    IERC20 public immutable bondToken;
    uint256 public immutable deploymentChainId;
    bytes32 public immutable deploymentDomainIdHash;
    bytes32 public immutable configCodeHash;
    bytes32 public immutable tokenCodeHash;
    bytes32 public executionClassManifestHash;

    mapping(address adapter => Admission admission) public admissions;
    mapping(address adapter => PendingAdmission pending) private _pendingAdmissions;
    PendingExecutionClass private _pendingExecutionClass;
    mapping(bytes32 manifestHash => bool used) private _usedExecutionClassManifestHashes;
    mapping(address owner => uint256 nonce) public nextNonce;
    mapping(bytes32 packageId => Package packageData) private _packages;
    mapping(bytes32 adapterRequestKey => bytes32 packageId) public requestKeyOwner;

    constructor(ProtocolConfig config_, IERC20 bondToken_, bytes32 executionClassManifestHash_)
        EIP712("Naryx Async Bonded Package", "1")
    {
        if (address(config_).code.length == 0 || address(bondToken_).code.length == 0) {
            revert InvalidConfiguration();
        }
        (string memory domainId, uint32 version, bytes32 manifestHash) = config_.domain();
        if (version == 0 || manifestHash == bytes32(0)) revert InvalidConfiguration();
        config = config_;
        bondToken = bondToken_;
        deploymentChainId = block.chainid;
        deploymentDomainIdHash = keccak256(bytes(domainId));
        configCodeHash = address(config_).codehash;
        tokenCodeHash = address(bondToken_).codehash;
        executionClassManifestHash = executionClassManifestHash_;
        if (executionClassManifestHash_ != bytes32(0)) {
            _usedExecutionClassManifestHashes[executionClassManifestHash_] = true;
        }
    }

    function pendingExecutionClass()
        external
        view
        returns (bool exists, bytes32 manifestHash, uint64 activationTimestamp)
    {
        PendingExecutionClass memory pending = _pendingExecutionClass;
        return (pending.activationTimestamp != 0, pending.manifestHash, pending.activationTimestamp);
    }

    function proposeExecutionClass(bytes32 manifestHash) external {
        _assertDeployment();
        (address proposer,,,) = config.roles();
        if (msg.sender != proposer) revert UnauthorizedRole();
        if (!config.entryPaused()) revert InvalidConfiguration();
        if (_pendingExecutionClass.activationTimestamp != 0) revert ExecutionClassProposalExists();
        if (manifestHash == bytes32(0)) revert ExecutionClassManifestHashZero();
        if (_usedExecutionClassManifestHashes[manifestHash]) {
            revert ExecutionClassManifestHashUsed(manifestHash);
        }
        uint256 activation = block.timestamp + config.configDelaySeconds();
        if (activation > type(uint64).max) revert ActivationTimestampOverflow();
        _pendingExecutionClass =
            PendingExecutionClass({manifestHash: manifestHash, activationTimestamp: uint64(activation)});
        emit ExecutionClassProposed(msg.sender, executionClassManifestHash, manifestHash, uint64(activation));
    }

    function cancelExecutionClassProposal() external {
        _assertDeployment();
        (, address canceller,,) = config.roles();
        if (msg.sender != canceller) revert UnauthorizedRole();
        PendingExecutionClass memory pending = _pendingExecutionClass;
        if (pending.activationTimestamp == 0) revert ExecutionClassProposalMissing();
        delete _pendingExecutionClass;
        emit ExecutionClassProposalCancelled(
            msg.sender, executionClassManifestHash, pending.manifestHash, pending.activationTimestamp
        );
    }

    function activateExecutionClass() external {
        _assertDeployment();
        (,, address executor,) = config.roles();
        if (msg.sender != executor) revert UnauthorizedRole();
        if (!config.entryPaused()) revert InvalidConfiguration();
        PendingExecutionClass memory pending = _pendingExecutionClass;
        if (pending.activationTimestamp == 0) revert ExecutionClassProposalMissing();
        if (block.timestamp < pending.activationTimestamp) {
            revert ExecutionClassProposalNotReady(pending.activationTimestamp);
        }
        bytes32 previousHash = executionClassManifestHash;
        executionClassManifestHash = pending.manifestHash;
        _usedExecutionClassManifestHashes[pending.manifestHash] = true;
        delete _pendingExecutionClass;
        emit ExecutionClassActivated(msg.sender, previousHash, executionClassManifestHash);
    }

    function pendingAdmission(address adapter) external view returns (PendingAdmission memory) {
        return _pendingAdmissions[adapter];
    }

    function packageState(bytes32 id) external view returns (Package memory) {
        return _packages[id];
    }

    function reserveDigest(Terms calldata terms) external view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(RESERVE_TYPEHASH, keccak256(abi.encode(terms)))));
    }

    function packageId(Terms calldata terms) public view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(this), keccak256(abi.encode(terms))));
    }

    function bondCommitment(Terms calldata terms) public view returns (bytes32) {
        return keccak256(
            abi.encode(
                address(bondToken),
                terms.bondAtoms,
                terms.recoveryReserveAtoms,
                terms.bondRecipient,
                terms.recoveryReserveRecipient,
                terms.slashRecipient
            )
        );
    }

    function recoveryPolicyCommitment(Terms calldata terms) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                RECOVERY_POLICY_ID,
                terms.adapter,
                terms.requestPayloadHash,
                IAsyncVenueAdapter.RecoveryAction.CANCEL_OR_RECONCILE,
                terms.recoveryDeadline
            )
        );
    }

    function reservationCommitment(Terms calldata terms) public pure returns (bytes32) {
        return keccak256(abi.encode(terms.owner, terms.solver, terms.orderHash, terms.nonce, terms.bondHash));
    }

    function proposeAdmission(address adapter, address handler, bytes32 adapterCodeHash, bytes32 handlerCodeHash)
        external
    {
        _assertDeployment();
        (address proposer,,,) = config.roles();
        if (msg.sender != proposer) revert UnauthorizedRole();
        if (
            adapter.code.length == 0 || handler.code.length == 0 || adapter.codehash != adapterCodeHash
                || handler.codehash != handlerCodeHash || adapterCodeHash == bytes32(0) || handlerCodeHash == bytes32(0)
                || (adapter == handler && adapterCodeHash != handlerCodeHash)
        ) revert InvalidAdmission();
        if (_pendingAdmissions[adapter].activationTimestamp != 0) revert AdmissionExists();
        uint256 activation = block.timestamp + config.configDelaySeconds();
        if (activation > type(uint64).max) revert InvalidAdmission();
        _pendingAdmissions[adapter] = PendingAdmission({
            admission: Admission({
                handler: handler,
                adapterCodeHash: adapterCodeHash,
                handlerCodeHash: handlerCodeHash,
                active: true,
                generation: admissions[adapter].generation + 1
            }),
            activationTimestamp: uint64(activation)
        });
        emit AdmissionProposed(adapter, handler, uint64(activation));
    }

    function cancelAdmissionProposal(address adapter) external {
        (, address canceller,,) = config.roles();
        if (msg.sender != canceller) revert UnauthorizedRole();
        if (_pendingAdmissions[adapter].activationTimestamp == 0) revert AdmissionMissing();
        delete _pendingAdmissions[adapter];
    }

    function activateAdmission(address adapter) external {
        _assertDeployment();
        (,, address executor,) = config.roles();
        if (msg.sender != executor) revert UnauthorizedRole();
        PendingAdmission memory pending = _pendingAdmissions[adapter];
        if (pending.activationTimestamp == 0) revert AdmissionMissing();
        if (block.timestamp < pending.activationTimestamp) revert AdmissionNotReady();
        if (
            adapter.codehash != pending.admission.adapterCodeHash
                || pending.admission.handler.codehash != pending.admission.handlerCodeHash
        ) revert InvalidAdmission();
        admissions[adapter] = pending.admission;
        delete _pendingAdmissions[adapter];
        emit AdmissionActivated(adapter, pending.admission.handler);
    }

    function pauseAdmission(address adapter) external {
        (,,, address pauser) = config.roles();
        if (msg.sender != pauser) revert UnauthorizedRole();
        if (!admissions[adapter].active) revert AdmissionMissing();
        admissions[adapter].active = false;
        admissions[adapter].generation++;
        emit AdmissionPaused(adapter);
    }

    function reserve(Terms calldata terms, bytes calldata ownerSignature) external nonReentrant returns (bytes32 id) {
        _assertDeployment();
        if (config.entryPaused()) revert WrongState();
        _validateTerms(terms);
        if (msg.sender != terms.solver) revert UnauthorizedActor();
        if (terms.nonce != nextNonce[terms.owner]) revert InvalidNonce();
        Admission memory admission = admissions[terms.adapter];
        if (
            !admission.active || admission.handler != terms.handler
                || admission.adapterCodeHash != terms.adapterCodeHash
                || admission.handlerCodeHash != terms.handlerCodeHash || terms.adapter.codehash != terms.adapterCodeHash
                || terms.handler.codehash != terms.handlerCodeHash
        ) revert InvalidAdmission();
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(RESERVE_TYPEHASH, keccak256(abi.encode(terms)))));
        if (!OwnerSignature.isValidNow(terms.owner, digest, ownerSignature)) revert InvalidSignature();
        id = packageId(terms);
        if (_packages[id].state != State.NONE) revert PackageExists();
        nextNonce[terms.owner]++;
        Package storage p = _packages[id];
        p.terms = terms;
        p.admissionGeneration = admission.generation;
        _transition(p, id, State.RESERVED, bytes32(0));
        uint256 funding = terms.bondAtoms + terms.recoveryReserveAtoms;
        uint256 beforeBalance = bondToken.balanceOf(address(this));
        bondToken.safeTransferFrom(msg.sender, address(this), funding);
        if (bondToken.balanceOf(address(this)) - beforeBalance != funding) revert FundingMismatch();
    }

    function submitRequest(bytes32 id, uint64 expectedVersion, IAsyncVenueAdapter.VenueRequest calldata request)
        external
        nonReentrant
        returns (bytes32 requestKey)
    {
        _assertDeployment();
        Package storage p = _package(id, expectedVersion, State.RESERVED);
        if (msg.sender != p.terms.solver) revert UnauthorizedActor();
        if (block.timestamp >= p.terms.submissionDeadline) revert DeadlinePassed();
        if (keccak256(abi.encode(request)) != p.terms.requestPayloadHash) revert InvalidRequest();
        _assertAdapter(p.terms, true);
        _transition(p, id, State.REQUEST_SUBMITTED, bytes32(0));
        requestKey = IAsyncVenueAdapter(p.terms.adapter).createRequest(id, request);
        if (requestKey == bytes32(0)) revert InvalidRequest();
        bytes32 adapterRequestKey = keccak256(abi.encode(p.terms.adapter, requestKey));
        if (requestKeyOwner[adapterRequestKey] != bytes32(0)) revert InvalidRequest();
        requestKeyOwner[adapterRequestKey] = id;
        p.requestKey = requestKey;
        emit RequestRegistered(id, requestKey);
    }

    function markVenuePending(bytes32 id, uint64 expectedVersion) external {
        _assertDeployment();
        Package storage p = _package(id, expectedVersion, State.REQUEST_SUBMITTED);
        if (p.requestKey == bytes32(0)) revert InvalidRequest();
        _transition(p, id, State.VENUE_PENDING, bytes32(0));
    }

    function cancelReserved(bytes32 id, uint64 expectedVersion) external nonReentrant {
        _assertDeployment();
        Package storage p = _package(id, expectedVersion, State.RESERVED);
        if (msg.sender != p.terms.owner && msg.sender != p.terms.solver) revert UnauthorizedActor();
        _transition(p, id, State.CLOSED, bytes32(0));
        _release(p, id);
    }

    function recordVenueEvidence(bytes32 id, uint64 expectedVersion, VenueEvidence calldata evidence) external {
        _assertDeployment();
        Package storage p = _packages[id];
        if (p.state == State.NONE) revert PackageMissing();
        if (p.stateVersion != expectedVersion) revert WrongVersion();
        if (
            msg.sender != p.terms.handler || msg.sender.codehash != p.terms.handlerCodeHash
                || p.requestKey == bytes32(0) || evidence.requestKey != p.requestKey
                || evidence.requestPayloadHash != p.terms.requestPayloadHash
                || evidence.evidenceSchemaHash != p.terms.evidenceSchemaHash || evidence.evidenceHash == bytes32(0)
                || p.state == State.CLOSED || p.state == State.RESERVED
        ) revert InvalidEvidence();
        if (p.evidenceConflict) revert InvalidEvidence();
        if (p.state == State.RECOVERED && evidence.outcome != Outcome.RECOVERED) {
            p.evidenceConflict = true;
            _transition(p, id, State.MANUAL_INTERVENTION, evidence.evidenceHash);
            return;
        }
        if (
            evidence.lossAsset != p.terms.lossAsset || evidence.residualAsset != p.terms.residualAsset
                || evidence.observedLossAtoms > p.terms.maxAggregateLossAtoms
                || evidence.intermediateResidualAtoms > p.terms.maxIntermediateResidualAtoms
                || ((evidence.outcome == Outcome.EXECUTED || evidence.outcome == Outcome.RECOVERED)
                    && evidence.terminalResidualAtoms > p.terms.maxTerminalResidualAtoms)
        ) {
            p.evidenceConflict = true;
            _transition(p, id, State.MANUAL_INTERVENTION, evidence.evidenceHash);
            return;
        }

        State previous = p.state;
        bytes32 evidenceCommitment = keccak256(abi.encode(evidence));
        if (evidence.outcome == Outcome.RECOVERED) {
            if (p.recoveryEvidenceCommitment == evidenceCommitment && previous == State.RECOVERED) return;
            if (p.recoveryEvidenceHash != bytes32(0)) {
                p.evidenceConflict = true;
                _transition(p, id, State.MANUAL_INTERVENTION, evidence.evidenceHash);
                return;
            }
            if (!p.recoveryActionSubmitted || previous != State.RECOVERY_PENDING) revert InvalidEvidence();
            p.recoveryEvidenceHash = evidence.evidenceHash;
            p.recoveryEvidenceCommitment = evidenceCommitment;
            p.settledLossAtoms = evidence.observedLossAtoms;
            _transition(p, id, State.RECOVERED, evidence.evidenceHash);
            return;
        }
        if (p.hasVenueOutcome) {
            if (p.venueEvidenceCommitment == evidenceCommitment) return;
            bool lateExecution = evidence.outcome == Outcome.EXECUTED
                && (p.lastVenueOutcome == Outcome.CANCELLED || p.lastVenueOutcome == Outcome.FROZEN)
                && (previous == State.RECOVERY_PENDING
                    || previous == State.CANCELLED
                    || previous == State.FROZEN
                    || previous == State.MANUAL_INTERVENTION);
            if (!lateExecution) {
                p.evidenceConflict = true;
                _transition(p, id, State.MANUAL_INTERVENTION, evidence.evidenceHash);
                return;
            }
        }
        p.hasVenueOutcome = true;
        p.lastVenueOutcome = evidence.outcome;
        p.venueEvidenceCommitment = evidenceCommitment;
        if (evidence.outcome == Outcome.EXECUTED) {
            p.settledLossAtoms = evidence.observedLossAtoms;
            _transition(p, id, State.EXECUTED, evidence.evidenceHash);
        } else if (previous == State.RECOVERY_PENDING || previous == State.MANUAL_INTERVENTION) {
            p.recoveryProven = true;
            _transition(p, id, previous, evidence.evidenceHash);
        } else if (evidence.outcome == Outcome.CANCELLED) {
            _transition(p, id, State.CANCELLED, evidence.evidenceHash);
        } else {
            _transition(p, id, State.FROZEN, evidence.evidenceHash);
        }
    }

    function beginRecovery(bytes32 id, uint64 expectedVersion) external {
        _assertDeployment();
        Package storage p = _packages[id];
        if (p.state == State.NONE) revert PackageMissing();
        if (p.stateVersion != expectedVersion) revert WrongVersion();
        if (p.state == State.FROZEN || p.state == State.CANCELLED) {
            p.recoveryProven = true;
        } else if (p.state == State.VENUE_PENDING || p.state == State.REQUEST_SUBMITTED) {
            if (block.timestamp <= p.terms.venueDeadline) revert DeadlineNotReached();
        } else {
            revert WrongState();
        }
        if (block.timestamp >= p.terms.recoveryDeadline) {
            _transition(p, id, State.MANUAL_INTERVENTION, p.outcomeEvidenceHash);
            return;
        }
        if (p.terms.adapter.codehash != p.terms.adapterCodeHash) {
            _transition(p, id, State.MANUAL_INTERVENTION, p.outcomeEvidenceHash);
            return;
        }
        if (p.recoveryProven) {
            p.recoveryDutyStartedAt = uint64(block.timestamp);
            p.recoveryDutyActive = true;
        }
        _transition(p, id, State.RECOVERY_PENDING, p.outcomeEvidenceHash);
    }

    function submitRecovery(bytes32 id, uint64 expectedVersion) external nonReentrant {
        _assertDeployment();
        Package storage p = _package(id, expectedVersion, State.RECOVERY_PENDING);
        if (block.timestamp >= p.terms.recoveryDeadline) revert DeadlinePassed();
        if (p.recoveryActionSubmitted) revert WrongState();
        _requestRecovery(p, id);
    }

    /// @notice Once the recovery deadline has passed without a submitted recovery, the package owner or
    /// solver submits the signed CANCEL_OR_RECONCILE action, so a request the venue still holds, or already
    /// cancelled, reaches an authenticated terminal outcome and the package can close. A missed recovery duty
    /// must be slashed first, and conflicting evidence stays locked.
    function submitOverdueRecovery(bytes32 id, uint64 expectedVersion) external nonReentrant {
        _assertDeployment();
        Package storage p = _packages[id];
        if (p.state == State.NONE) revert PackageMissing();
        if (p.stateVersion != expectedVersion) revert WrongVersion();
        if (msg.sender != p.terms.owner && msg.sender != p.terms.solver) revert UnauthorizedActor();
        if (block.timestamp < p.terms.recoveryDeadline) revert DeadlineNotReached();
        if (
            p.requestKey == bytes32(0) || p.evidenceConflict || p.recoveryActionSubmitted
                || (p.state != State.MANUAL_INTERVENTION && (p.state != State.RECOVERY_PENDING || p.recoveryDutyActive))
        ) revert WrongState();
        _requestRecovery(p, id);
    }

    function _requestRecovery(Package storage p, bytes32 id) private {
        _assertAdapter(p.terms, false);
        p.recoveryActionSubmitted = true;
        bool accepted = IAsyncVenueAdapter(p.terms.adapter)
            .requestRecovery(id, p.requestKey, IAsyncVenueAdapter.RecoveryAction.CANCEL_OR_RECONCILE);
        if (!accepted) revert InvalidRequest();
        _transition(p, id, State.RECOVERY_PENDING, p.outcomeEvidenceHash);
        emit RecoveryActionSubmitted(id, p.requestKey);
    }

    function slashMissedSubmission(bytes32 id, uint64 expectedVersion) external {
        _assertDeployment();
        Package storage p = _package(id, expectedVersion, State.RESERVED);
        if (block.timestamp <= p.terms.submissionDeadline) revert DeadlineNotReached();
        Admission memory admission = admissions[p.terms.adapter];
        if (
            !admission.active || admission.generation != p.admissionGeneration
                || p.terms.adapter.codehash != p.terms.adapterCodeHash
                || p.terms.handler.codehash != p.terms.handlerCodeHash || config.entryPaused()
        ) {
            _transition(p, id, State.MANUAL_INTERVENTION, bytes32(0));
            return;
        }
        p.bondSlashed = true;
        _transition(p, id, State.MANUAL_INTERVENTION, bytes32(0));
        emit BondSlashed(id, p.terms.bondAtoms);
    }

    function slashMissedRecovery(bytes32 id, uint64 expectedVersion) external {
        _assertDeployment();
        Package storage p = _package(id, expectedVersion, State.RECOVERY_PENDING);
        if (block.timestamp <= p.terms.recoveryDeadline) revert DeadlineNotReached();
        if (p.terms.adapter.codehash != p.terms.adapterCodeHash) {
            _transition(p, id, State.MANUAL_INTERVENTION, p.outcomeEvidenceHash);
            return;
        }
        if (!p.recoveryProven || !p.recoveryDutyActive || p.recoveryActionSubmitted) revert WrongState();
        p.bondSlashed = true;
        _transition(p, id, State.MANUAL_INTERVENTION, p.outcomeEvidenceHash);
        emit BondSlashed(id, p.terms.bondAtoms);
    }

    function close(bytes32 id, uint64 expectedVersion) external nonReentrant {
        _assertDeployment();
        Package storage p = _packages[id];
        if (p.state == State.NONE) revert PackageMissing();
        if (p.stateVersion != expectedVersion) revert WrongVersion();
        if (
            (p.state != State.EXECUTED && p.state != State.RECOVERED)
                && !(p.state == State.MANUAL_INTERVENTION && p.requestKey == bytes32(0))
        ) revert ReleaseLocked();
        if (
            p.evidenceConflict
                || (p.requestKey != bytes32(0)
                    && p.outcomeEvidenceHash == bytes32(0)
                    && p.recoveryEvidenceHash == bytes32(0))
        ) {
            revert ReleaseLocked();
        }
        _transition(p, id, State.CLOSED, p.outcomeEvidenceHash);
        _release(p, id);
    }

    function _release(Package storage p, bytes32 id) private {
        Terms storage terms = p.terms;
        uint256 lossAtoms = p.settledLossAtoms;
        bondToken.safeTransfer(p.bondSlashed ? terms.slashRecipient : terms.bondRecipient, terms.bondAtoms);
        if (lossAtoms != 0) bondToken.safeTransfer(terms.owner, lossAtoms);
        bondToken.safeTransfer(terms.recoveryReserveRecipient, terms.recoveryReserveAtoms - lossAtoms);
        emit PackageReleased(
            id,
            p.bondSlashed ? terms.slashRecipient : terms.bondRecipient,
            terms.recoveryReserveRecipient,
            terms.recoveryReserveAtoms - lossAtoms,
            terms.owner,
            lossAtoms
        );
    }

    function _validateTerms(Terms calldata terms) private view {
        (string memory domainId, uint32 version, bytes32 manifestHash) = config.domain();
        if (
            keccak256(bytes(domainId)) != deploymentDomainIdHash || terms.domain.domainIdHash != deploymentDomainIdHash
                || terms.domain.manifestVersion != version || terms.domain.manifestHash != manifestHash
        ) revert DomainMismatch();
        if (
            terms.owner == address(0) || terms.solver == address(0) || terms.adapter == address(0)
                || terms.handler == address(0) || terms.orderHash == bytes32(0) || terms.quoteHash == bytes32(0)
                || terms.routeHash == bytes32(0) || terms.seriesIdentityKey == bytes32(0)
                || terms.seriesBindingVersion == 0 || terms.seriesBindingHash == bytes32(0)
                || terms.executionClassIdentityHash != EXECUTION_CLASS_ID
                || terms.executionClassManifestHash != executionClassManifestHash
                || terms.requestPayloadHash == bytes32(0) || terms.reservationHash != reservationCommitment(terms)
                || terms.bondHash != bondCommitment(terms)
                || terms.recoveryPolicyHash != recoveryPolicyCommitment(terms)
                || terms.evidenceSchemaHash != EVIDENCE_SCHEMA_ID || terms.bondRecipient == address(0)
                || terms.recoveryReserveRecipient == address(0) || terms.slashRecipient == address(0)
                || terms.lossAsset != address(bondToken) || terms.residualAsset == address(0) || terms.bondAtoms == 0
                || terms.recoveryReserveAtoms == 0 || terms.maxAggregateLossAtoms == 0
                || terms.maxAggregateLossAtoms > terms.recoveryReserveAtoms || terms.maxIntermediateResidualAtoms == 0
                || terms.maxTerminalResidualAtoms == 0
                || terms.maxTerminalResidualAtoms > terms.maxIntermediateResidualAtoms
                || block.timestamp >= terms.submissionDeadline || terms.submissionDeadline >= terms.venueDeadline
                || terms.venueDeadline >= terms.recoveryDeadline
        ) revert InvalidTerms();
    }

    function _assertDeployment() private view {
        if (
            block.chainid != deploymentChainId || address(config).codehash != configCodeHash
                || address(bondToken).codehash != tokenCodeHash
        ) revert DeploymentChanged();
        (string memory domainId,,) = config.domain();
        if (keccak256(bytes(domainId)) != deploymentDomainIdHash) revert DomainMismatch();
    }

    function _assertAdapter(Terms storage terms, bool mustBeActive) private view {
        if (terms.adapter.codehash != terms.adapterCodeHash || terms.handler.codehash != terms.handlerCodeHash) {
            revert InvalidAdmission();
        }
        if (mustBeActive) {
            Admission memory admission = admissions[terms.adapter];
            if (
                !admission.active || admission.handler != terms.handler
                    || admission.adapterCodeHash != terms.adapterCodeHash
                    || admission.handlerCodeHash != terms.handlerCodeHash
            ) revert InvalidAdmission();
        }
    }

    function _package(bytes32 id, uint64 expectedVersion, State expectedState)
        private
        view
        returns (Package storage p)
    {
        p = _packages[id];
        if (p.state == State.NONE) revert PackageMissing();
        if (p.stateVersion != expectedVersion) revert WrongVersion();
        if (p.state != expectedState) revert WrongState();
    }

    function _transition(Package storage p, bytes32 id, State next, bytes32 evidenceHash) private {
        p.state = next;
        p.stateVersion++;
        p.outcomeEvidenceHash = evidenceHash;
        emit PackageTransition(id, next, p.stateVersion, evidenceHash);
    }
}

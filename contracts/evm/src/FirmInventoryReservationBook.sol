// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "openzeppelin-contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/utils/ReentrancyGuard.sol";
import {ProtocolConfig} from "./ProtocolConfig.sol";

contract FirmInventoryReservationBook is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint8 public constant ENTRY = 1;
    uint256 private constant MAX_PROTOCOL_ID_BYTES = 128;

    struct DomainRef {
        bytes32 domainIdHash;
        uint32 manifestVersion;
        bytes32 manifestHash;
    }

    enum ReservationState {
        NONE,
        FUNDED,
        LIVE,
        CONSUMED,
        RELEASED
    }

    struct ReservationTerms {
        DomainRef domain;
        string solverId;
        address solver;
        address reclaimOwner;
        address strategyAccount;
        uint256 packageNonce;
        bytes32 orderHash;
        uint256 reservationNonce;
        uint256 baseAtoms;
        uint256 quoteAtoms;
        uint64 expiry;
        address consumer;
        bytes32 consumerCodeHash;
    }

    struct Reservation {
        DomainRef domain;
        string solverId;
        address solver;
        address reclaimOwner;
        address strategyAccount;
        uint256 packageNonce;
        bytes32 orderHash;
        uint256 reservationNonce;
        bytes32 quoteHash;
        bytes32 routeHash;
        uint256 baseAtoms;
        uint256 quoteAtoms;
        uint64 expiry;
        address consumer;
        bytes32 consumerCodeHash;
        ReservationState state;
    }

    error InvalidConfiguration();
    error InvalidReservation();
    error DomainMismatch();
    error ReservationAlreadyExists();
    error ReservationUnavailable();
    error ReservationExpired();
    error ReservationNotExpired();
    error UnauthorizedSolver();
    error UnauthorizedConsumer();
    error CapacityExceeded();
    error PostconditionFailed();

    event InventoryFunded(
        bytes32 indexed reservationId,
        address indexed solver,
        address indexed strategyAccount,
        uint256 packageNonce,
        uint256 baseAtoms,
        uint256 quoteAtoms,
        uint64 expiry
    );
    event ReservationFinalized(bytes32 indexed reservationId, bytes32 indexed quoteHash, bytes32 indexed routeHash);
    event InventoryConsumed(bytes32 indexed reservationId, address indexed strategyAccount, address indexed solver);
    event InventoryReleased(bytes32 indexed reservationId, address indexed reclaimOwner);

    ProtocolConfig public immutable config;
    IERC20 public immutable baseToken;
    IERC20 public immutable quoteToken;
    uint256 public immutable deploymentChainId;
    bytes32 public immutable deploymentDomainIdHash;
    uint32 public immutable deploymentDomainManifestVersion;
    bytes32 public immutable deploymentDomainManifestHash;
    bytes32 public immutable configCodeHash;
    bytes32 public immutable baseTokenCodeHash;
    bytes32 public immutable quoteTokenCodeHash;
    uint64 public immutable maximumTtlSeconds;
    uint256 public immutable maximumBaseAtomsPerReservation;
    uint256 public immutable maximumReservedBaseAtomsPerSolver;

    mapping(bytes32 reservationId => Reservation reservationData) private _reservations;
    mapping(bytes32 solverStrategyKey => bytes32 reservationId) public liveReservation;
    mapping(address solver => uint256 baseAtoms) public reservedBaseAtoms;

    constructor(
        ProtocolConfig config_,
        IERC20 baseToken_,
        IERC20 quoteToken_,
        uint64 maximumTtlSeconds_,
        uint256 maximumBaseAtomsPerReservation_,
        uint256 maximumReservedBaseAtomsPerSolver_
    ) {
        if (
            address(config_).code.length == 0 || address(baseToken_).code.length == 0
                || address(quoteToken_).code.length == 0 || address(baseToken_) == address(quoteToken_)
                || maximumTtlSeconds_ == 0 || maximumBaseAtomsPerReservation_ == 0
                || maximumBaseAtomsPerReservation_ > type(uint128).max
                || maximumReservedBaseAtomsPerSolver_ < maximumBaseAtomsPerReservation_
        ) revert InvalidConfiguration();
        (string memory domainId, uint32 manifestVersion, bytes32 manifestHash) = config_.domain();
        config = config_;
        baseToken = baseToken_;
        quoteToken = quoteToken_;
        deploymentChainId = block.chainid;
        deploymentDomainIdHash = keccak256(bytes(domainId));
        deploymentDomainManifestVersion = manifestVersion;
        deploymentDomainManifestHash = manifestHash;
        configCodeHash = address(config_).codehash;
        baseTokenCodeHash = address(baseToken_).codehash;
        quoteTokenCodeHash = address(quoteToken_).codehash;
        maximumTtlSeconds = maximumTtlSeconds_;
        maximumBaseAtomsPerReservation = maximumBaseAtomsPerReservation_;
        maximumReservedBaseAtomsPerSolver = maximumReservedBaseAtomsPerSolver_;
    }

    function reservation(bytes32 reservationId_) external view returns (Reservation memory) {
        return _reservations[reservationId_];
    }

    function solverStrategyKey(address solver, address strategyAccount) public pure returns (bytes32) {
        return keccak256(abi.encode(solver, strategyAccount));
    }

    function reservationId(
        string memory domainId,
        uint32 domainManifestVersion,
        bytes32 domainManifestHash,
        string memory solverId,
        bytes32 orderHash,
        uint256 reservationNonce
    ) public pure returns (bytes32) {
        bytes memory domainBytes = bytes(domainId);
        bytes memory solverBytes = bytes(solverId);
        return sha256(
            abi.encodePacked(
                bytes("CON/v1/reservation-id"),
                bytes4(uint32(domainBytes.length)),
                domainBytes,
                bytes4(domainManifestVersion),
                domainManifestHash,
                bytes4(uint32(solverBytes.length)),
                solverBytes,
                orderHash,
                bytes32(reservationNonce)
            )
        );
    }

    function reserve(ReservationTerms calldata terms) external nonReentrant returns (bytes32 reservationId_) {
        _assertDeployment();
        if (
            msg.sender != terms.solver || terms.solver == address(0) || terms.reclaimOwner == address(0)
                || terms.strategyAccount.code.length == 0 || terms.strategyAccount == terms.solver
                || terms.orderHash == bytes32(0) || terms.reservationNonce == 0 || terms.baseAtoms == 0
                || terms.baseAtoms > maximumBaseAtomsPerReservation || terms.quoteAtoms == 0
                || terms.quoteAtoms > type(uint128).max || block.timestamp >= terms.expiry
                || uint256(terms.expiry) - block.timestamp > maximumTtlSeconds || terms.consumer.code.length == 0
                || terms.consumerCodeHash == bytes32(0) || terms.consumer.codehash != terms.consumerCodeHash
        ) revert InvalidReservation();
        _validateProtocolId(terms.solverId);
        _validateActiveDomain(terms.domain);

        bytes32 occupancyKey = solverStrategyKey(terms.solver, terms.strategyAccount);
        if (liveReservation[occupancyKey] != bytes32(0)) revert ReservationAlreadyExists();
        uint256 solverReserved = reservedBaseAtoms[terms.solver];
        if (terms.baseAtoms > maximumReservedBaseAtomsPerSolver - solverReserved) revert CapacityExceeded();

        (string memory domainId,,) = config.domain();
        reservationId_ = reservationId(
            domainId,
            terms.domain.manifestVersion,
            terms.domain.manifestHash,
            terms.solverId,
            terms.orderHash,
            terms.reservationNonce
        );
        if (_reservations[reservationId_].state != ReservationState.NONE) revert ReservationAlreadyExists();

        uint256 bookBefore = baseToken.balanceOf(address(this));
        uint256 solverBefore = baseToken.balanceOf(terms.solver);
        baseToken.safeTransferFrom(terms.solver, address(this), terms.baseAtoms);
        if (
            baseToken.balanceOf(address(this)) != bookBefore + terms.baseAtoms
                || baseToken.balanceOf(terms.solver) != solverBefore - terms.baseAtoms
        ) revert PostconditionFailed();

        _reservations[reservationId_] = Reservation({
            domain: terms.domain,
            solverId: terms.solverId,
            solver: terms.solver,
            reclaimOwner: terms.reclaimOwner,
            strategyAccount: terms.strategyAccount,
            packageNonce: terms.packageNonce,
            orderHash: terms.orderHash,
            reservationNonce: terms.reservationNonce,
            quoteHash: bytes32(0),
            routeHash: bytes32(0),
            baseAtoms: terms.baseAtoms,
            quoteAtoms: terms.quoteAtoms,
            expiry: terms.expiry,
            consumer: terms.consumer,
            consumerCodeHash: terms.consumerCodeHash,
            state: ReservationState.FUNDED
        });
        liveReservation[occupancyKey] = reservationId_;
        reservedBaseAtoms[terms.solver] = solverReserved + terms.baseAtoms;
        emit InventoryFunded(
            reservationId_,
            terms.solver,
            terms.strategyAccount,
            terms.packageNonce,
            terms.baseAtoms,
            terms.quoteAtoms,
            terms.expiry
        );
    }

    function finalizeReservation(bytes32 reservationId_, bytes32 quoteHash, bytes32 routeHash) external {
        _assertDeployment();
        Reservation storage stored = _reservations[reservationId_];
        if (stored.state != ReservationState.FUNDED) revert ReservationUnavailable();
        if (msg.sender != stored.solver) revert UnauthorizedSolver();
        if (quoteHash == bytes32(0) || routeHash == bytes32(0)) revert InvalidReservation();
        if (block.timestamp >= stored.expiry) revert ReservationExpired();
        _validateActiveDomain(stored.domain);

        stored.quoteHash = quoteHash;
        stored.routeHash = routeHash;
        stored.state = ReservationState.LIVE;
        emit ReservationFinalized(reservationId_, quoteHash, routeHash);
    }

    function consume(bytes32 reservationId_) external nonReentrant {
        _assertDeployment();
        Reservation storage stored = _reservations[reservationId_];
        if (stored.state != ReservationState.LIVE) revert ReservationUnavailable();
        if (block.timestamp >= stored.expiry) revert ReservationExpired();
        if (msg.sender != stored.consumer || msg.sender.codehash != stored.consumerCodeHash) {
            revert UnauthorizedConsumer();
        }
        _validateActiveDomain(stored.domain);

        stored.state = ReservationState.CONSUMED;
        _clearExposure(reservationId_, stored);
        uint256 bookBaseBefore = baseToken.balanceOf(address(this));
        uint256 strategyBaseBefore = baseToken.balanceOf(stored.strategyAccount);
        uint256 strategyQuoteBefore = quoteToken.balanceOf(stored.strategyAccount);
        uint256 solverQuoteBefore = quoteToken.balanceOf(stored.solver);

        baseToken.safeTransfer(stored.strategyAccount, stored.baseAtoms);
        quoteToken.safeTransferFrom(stored.strategyAccount, stored.solver, stored.quoteAtoms);

        if (
            baseToken.balanceOf(address(this)) != bookBaseBefore - stored.baseAtoms
                || baseToken.balanceOf(stored.strategyAccount) != strategyBaseBefore + stored.baseAtoms
                || quoteToken.balanceOf(stored.strategyAccount) != strategyQuoteBefore - stored.quoteAtoms
                || quoteToken.balanceOf(stored.solver) != solverQuoteBefore + stored.quoteAtoms
        ) revert PostconditionFailed();
        emit InventoryConsumed(reservationId_, stored.strategyAccount, stored.solver);
    }

    function releaseExpired(bytes32 reservationId_) external nonReentrant {
        Reservation storage stored = _reservations[reservationId_];
        if (stored.state != ReservationState.FUNDED && stored.state != ReservationState.LIVE) {
            revert ReservationUnavailable();
        }
        if (block.timestamp < stored.expiry) revert ReservationNotExpired();

        stored.state = ReservationState.RELEASED;
        _clearExposure(reservationId_, stored);
        uint256 bookBefore = baseToken.balanceOf(address(this));
        uint256 ownerBefore = baseToken.balanceOf(stored.reclaimOwner);
        baseToken.safeTransfer(stored.reclaimOwner, stored.baseAtoms);
        if (
            baseToken.balanceOf(address(this)) != bookBefore - stored.baseAtoms
                || baseToken.balanceOf(stored.reclaimOwner) != ownerBefore + stored.baseAtoms
        ) revert PostconditionFailed();
        emit InventoryReleased(reservationId_, stored.reclaimOwner);
    }

    function _clearExposure(bytes32 reservationId_, Reservation storage stored) private {
        bytes32 occupancyKey = solverStrategyKey(stored.solver, stored.strategyAccount);
        if (liveReservation[occupancyKey] != reservationId_ || reservedBaseAtoms[stored.solver] < stored.baseAtoms) {
            revert PostconditionFailed();
        }
        delete liveReservation[occupancyKey];
        reservedBaseAtoms[stored.solver] -= stored.baseAtoms;
    }

    function _assertDeployment() private view {
        if (
            block.chainid != deploymentChainId || address(config).codehash != configCodeHash
                || address(baseToken).codehash != baseTokenCodeHash
                || address(quoteToken).codehash != quoteTokenCodeHash
        ) revert InvalidConfiguration();
        (string memory domainId, uint32 manifestVersion, bytes32 manifestHash) = config.domain();
        if (
            keccak256(bytes(domainId)) != deploymentDomainIdHash || manifestVersion != deploymentDomainManifestVersion
                || manifestHash != deploymentDomainManifestHash
        ) revert DomainMismatch();
    }

    function _validateActiveDomain(DomainRef memory domain) private view {
        if (
            domain.domainIdHash != deploymentDomainIdHash || domain.manifestVersion != deploymentDomainManifestVersion
                || domain.manifestHash != deploymentDomainManifestHash
        ) revert DomainMismatch();
    }

    function _validateProtocolId(string memory value) private pure {
        bytes memory encoded = bytes(value);
        if (encoded.length == 0 || encoded.length > MAX_PROTOCOL_ID_BYTES) revert InvalidReservation();
        for (uint256 i; i < encoded.length; ++i) {
            if (uint8(encoded[i]) > 0x7f) revert InvalidReservation();
        }
    }
}

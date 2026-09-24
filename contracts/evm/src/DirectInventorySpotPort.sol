// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "openzeppelin-contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/utils/ReentrancyGuard.sol";
import {FirmInventoryReservationBook} from "./FirmInventoryReservationBook.sol";
import {ProtocolConfig} from "./ProtocolConfig.sol";
import {IExactSpotPort} from "./interfaces/IExactSpotPort.sol";
import {ISpotFillRecorder} from "./interfaces/ISpotFillRecorder.sol";

interface IPackageVerifierConfig {
    function config() external view returns (ProtocolConfig);
}

contract DirectInventorySpotPort is IExactSpotPort, ReentrancyGuard {
    uint8 public constant ENTRY = 1;

    struct Deployment {
        uint256 chainId;
        ProtocolConfig config;
        address verifier;
        FirmInventoryReservationBook reservationBook;
        IERC20 baseToken;
        IERC20 quoteToken;
        bytes32 domainIdHash;
        uint32 domainManifestVersion;
        bytes32 domainManifestHash;
        bytes32 configCodeHash;
        bytes32 verifierCodeHash;
        bytes32 reservationBookCodeHash;
        bytes32 baseTokenCodeHash;
        bytes32 quoteTokenCodeHash;
    }

    error InvalidConfiguration();
    error InvalidQuantity();
    error UnsupportedAction();
    error DeploymentChanged();
    error ReservationMismatch();
    error PostconditionFailed();

    ProtocolConfig public immutable config;
    address public immutable verifier;
    FirmInventoryReservationBook public immutable reservationBook;
    IERC20 public immutable baseToken;
    IERC20 public immutable quoteToken;
    uint256 public immutable deploymentChainId;
    bytes32 public immutable deploymentDomainIdHash;
    uint32 public immutable deploymentDomainManifestVersion;
    bytes32 public immutable deploymentDomainManifestHash;
    bytes32 public immutable configCodeHash;
    bytes32 public immutable verifierCodeHash;
    bytes32 public immutable reservationBookCodeHash;
    bytes32 public immutable baseTokenCodeHash;
    bytes32 public immutable quoteTokenCodeHash;

    constructor(Deployment memory deployment) {
        if (
            deployment.chainId == 0 || address(deployment.config).code.length == 0
                || deployment.verifier.code.length == 0 || address(deployment.reservationBook).code.length == 0
                || address(deployment.baseToken).code.length == 0 || address(deployment.quoteToken).code.length == 0
                || address(deployment.baseToken) == address(deployment.quoteToken)
                || deployment.domainIdHash == bytes32(0) || deployment.domainManifestVersion == 0
                || deployment.domainManifestHash == bytes32(0) || deployment.configCodeHash == bytes32(0)
                || deployment.verifierCodeHash == bytes32(0) || deployment.reservationBookCodeHash == bytes32(0)
                || deployment.baseTokenCodeHash == bytes32(0) || deployment.quoteTokenCodeHash == bytes32(0)
        ) revert InvalidConfiguration();
        if (
            address(deployment.reservationBook.config()) != address(deployment.config)
                || address(IPackageVerifierConfig(deployment.verifier).config()) != address(deployment.config)
                || address(deployment.reservationBook.baseToken()) != address(deployment.baseToken)
                || address(deployment.reservationBook.quoteToken()) != address(deployment.quoteToken)
        ) revert InvalidConfiguration();

        config = deployment.config;
        verifier = deployment.verifier;
        reservationBook = deployment.reservationBook;
        baseToken = deployment.baseToken;
        quoteToken = deployment.quoteToken;
        deploymentChainId = deployment.chainId;
        deploymentDomainIdHash = deployment.domainIdHash;
        deploymentDomainManifestVersion = deployment.domainManifestVersion;
        deploymentDomainManifestHash = deployment.domainManifestHash;
        configCodeHash = deployment.configCodeHash;
        verifierCodeHash = deployment.verifierCodeHash;
        reservationBookCodeHash = deployment.reservationBookCodeHash;
        baseTokenCodeHash = deployment.baseTokenCodeHash;
        quoteTokenCodeHash = deployment.quoteTokenCodeHash;
        _assertDeployment();
    }

    function buyExactOutput(
        uint256 packageNonce,
        bytes32 spotFillCommitment,
        bytes32 orderHash,
        bytes32 quoteHash,
        bytes32 routeHash,
        uint256 quantity,
        uint256 maxQuote
    ) external nonReentrant returns (uint256 quoteIn) {
        if (
            spotFillCommitment == bytes32(0) || orderHash == bytes32(0) || quoteHash == bytes32(0)
                || routeHash == bytes32(0) || quantity == 0 || maxQuote == 0
        ) revert InvalidQuantity();
        _assertDeployment();
        FirmInventoryReservationBook.Reservation memory reserved = reservationBook.reservation(spotFillCommitment);
        _validateReservation(reserved, packageNonce, orderHash, quoteHash, routeHash, quantity, maxQuote);

        uint256 portBaseBefore = baseToken.balanceOf(address(this));
        uint256 portQuoteBefore = quoteToken.balanceOf(address(this));
        reservationBook.consume(spotFillCommitment);
        if (
            baseToken.balanceOf(address(this)) != portBaseBefore
                || quoteToken.balanceOf(address(this)) != portQuoteBefore
        ) revert PostconditionFailed();

        quoteIn = reserved.quoteAtoms;
        _recordSpotFill(packageNonce, spotFillCommitment, orderHash, quoteHash, routeHash, ENTRY, quantity, quoteIn);
    }

    function sellExactInput(uint256, bytes32, bytes32, bytes32, bytes32, uint256, uint256)
        external
        pure
        returns (uint256)
    {
        revert UnsupportedAction();
    }

    function assertDeployment() external view {
        _assertDeployment();
    }

    function _validateReservation(
        FirmInventoryReservationBook.Reservation memory reserved,
        uint256 packageNonce,
        bytes32 orderHash,
        bytes32 quoteHash,
        bytes32 routeHash,
        uint256 baseAtoms,
        uint256 quoteAtoms
    ) private view {
        if (
            reserved.state != FirmInventoryReservationBook.ReservationState.LIVE
                || reserved.domain.domainIdHash != deploymentDomainIdHash
                || reserved.domain.manifestVersion != deploymentDomainManifestVersion
                || reserved.domain.manifestHash != deploymentDomainManifestHash
                || reserved.strategyAccount != msg.sender || reserved.packageNonce != packageNonce
                || reserved.orderHash != orderHash || reserved.quoteHash != quoteHash || reserved.routeHash != routeHash
                || reserved.baseAtoms != baseAtoms || reserved.quoteAtoms != quoteAtoms
                || block.timestamp >= reserved.expiry || reserved.consumer != address(this)
                || reserved.consumerCodeHash != address(this).codehash
        ) revert ReservationMismatch();
    }

    function _recordSpotFill(
        uint256 packageNonce,
        bytes32 spotFillCommitment,
        bytes32 orderHash,
        bytes32 quoteHash,
        bytes32 routeHash,
        uint8 action,
        uint256 baseAtoms,
        uint256 quoteAtoms
    ) private {
        ISpotFillRecorder(verifier)
            .recordSpotFill(
                msg.sender,
                packageNonce,
                spotFillCommitment,
                orderHash,
                quoteHash,
                routeHash,
                action,
                address(baseToken),
                address(quoteToken),
                baseAtoms,
                quoteAtoms
            );
    }

    function _assertDeployment() private view {
        if (
            block.chainid != deploymentChainId || address(config).codehash != configCodeHash
                || verifier.codehash != verifierCodeHash || address(reservationBook).codehash != reservationBookCodeHash
                || address(baseToken).codehash != baseTokenCodeHash
                || address(quoteToken).codehash != quoteTokenCodeHash
                || address(reservationBook.config()) != address(config)
                || address(IPackageVerifierConfig(verifier).config()) != address(config)
        ) revert DeploymentChanged();
        (string memory domainId, uint32 manifestVersion, bytes32 manifestHash) = config.domain();
        if (
            keccak256(bytes(domainId)) != deploymentDomainIdHash || manifestVersion != deploymentDomainManifestVersion
                || manifestHash != deploymentDomainManifestHash
        ) revert DeploymentChanged();
    }
}

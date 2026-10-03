// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC1271} from "openzeppelin-contracts/interfaces/IERC1271.sol";
import {IERC20} from "openzeppelin-contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/utils/ReentrancyGuard.sol";
import {PackageVerifier} from "./PackageVerifier.sol";
import {ResourceRegistry} from "./ResourceRegistry.sol";
import {IExactSpotPort} from "./interfaces/IExactSpotPort.sol";
import {IPerpMarginGate} from "./interfaces/IPerpMarginGate.sol";
import {ISynFuturesInstrument} from "./interfaces/ISynFuturesInstrument.sol";
import {OwnerSignature} from "./libraries/OwnerSignature.sol";

interface IFirmInventorySpotPort {
    function reservationBook() external view returns (address);
}

contract NaryxStrategyAccount is IERC1271, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint8 private constant ENTRY = 1;
    uint8 private constant EXIT = 2;

    error InvalidConfiguration();
    error InvalidExecution();
    error InvalidRecoveryExit();
    error InvalidWithdrawal();
    error OpenPackageExists();
    error UnauthorizedWithdrawal();
    error WithdrawalPostconditionFailed();
    error UnauthorizedOwner(address caller);
    error InvalidTransfer();
    error TransferExpired();
    error InvalidDelegation();
    error InvalidMarginTransfer();
    error MarginTransferPostconditionFailed();
    error UnregisteredPerpVenue();

    event IdleTokenWithdrawn(address indexed token, address indexed recipient, uint256 amount);
    event OwnerTransferProposed(address indexed owner, address indexed pendingOwner, uint64 expiresAt);
    event OwnerTransferCancelled(address indexed owner, address indexed pendingOwner);
    event OwnerTransferred(address indexed previousOwner, address indexed newOwner);
    event DelegationSet(address indexed delegate, uint8 authorities, uint64 expiresAt, uint256 epoch);
    event DelegationRevoked(address indexed delegate);
    event PerpMarginDeposited(address indexed venue, bytes32 indexed venueSubjectId, uint256 amount);
    event PerpMarginWithdrawn(address indexed venue, bytes32 indexed venueSubjectId, uint256 amount);

    /// A delegate holding this authority may submit an owner-signed recovery exit, nothing else.
    uint8 public constant AUTHORITY_RECOVERY_EXIT = 1;
    uint64 public constant MAX_TRANSFER_WINDOW = 7 days;
    uint64 public constant MAX_DELEGATION_WINDOW = 30 days;

    struct Delegation {
        uint8 authorities;
        uint64 expiresAt;
        uint256 epoch;
    }

    /// The account owner. A transfer moves the whole account, its balances and its venue positions,
    /// to the new owner, whose acceptance is required; the old owner's signatures stop validating.
    address public owner;
    address public pendingOwner;
    uint64 public pendingOwnerExpiresAt;
    /// Every transfer advances the epoch, which voids every delegation granted before it.
    uint256 public delegationEpoch;
    mapping(address delegate => Delegation delegation) private _delegations;
    PackageVerifier public immutable verifier;
    uint256 public immutable deploymentChainId;
    bytes32 public immutable verifierCodeHash;

    constructor(address owner_, PackageVerifier verifier_) {
        if (owner_ == address(0) || owner_ == address(this) || address(verifier_).code.length == 0) {
            revert InvalidConfiguration();
        }
        owner = owner_;
        verifier = verifier_;
        deploymentChainId = block.chainid;
        verifierCodeHash = address(verifier_).codehash;
    }

    /// @notice Novation, step one: the owner names the new owner and a short acceptance window.
    function proposeOwnerTransfer(address newOwner, uint64 expiresAt) external {
        if (msg.sender != owner) revert UnauthorizedOwner(msg.sender);
        if (
            newOwner == address(0) || newOwner == address(this) || newOwner == owner || expiresAt <= block.timestamp
                || expiresAt > block.timestamp + MAX_TRANSFER_WINDOW
        ) revert InvalidTransfer();
        pendingOwner = newOwner;
        pendingOwnerExpiresAt = expiresAt;
        emit OwnerTransferProposed(owner, newOwner, expiresAt);
    }

    function cancelOwnerTransfer() external {
        if (msg.sender != owner) revert UnauthorizedOwner(msg.sender);
        if (pendingOwner == address(0)) revert InvalidTransfer();
        emit OwnerTransferCancelled(owner, pendingOwner);
        pendingOwner = address(0);
        pendingOwnerExpiresAt = 0;
    }

    /// @notice Novation, step two: only the named new owner accepts, inside the window. Every
    /// delegation the previous owner granted ends with the transfer.
    function acceptOwnerTransfer() external nonReentrant {
        if (msg.sender != pendingOwner || pendingOwner == address(0)) revert UnauthorizedOwner(msg.sender);
        if (block.timestamp >= pendingOwnerExpiresAt) revert TransferExpired();
        if (block.chainid != deploymentChainId || address(verifier).codehash != verifierCodeHash) {
            revert InvalidConfiguration();
        }
        address previous = owner;
        owner = msg.sender;
        pendingOwner = address(0);
        pendingOwnerExpiresAt = 0;
        delegationEpoch += 1;
        emit OwnerTransferred(previous, msg.sender);
    }

    /// @notice Grants a bounded, expiring delegation. It can never move ownership, withdraw, or
    /// sign; the only authority is submitting a recovery exit the owner already signed.
    function setDelegation(address delegate, uint8 authorities, uint64 expiresAt) external {
        if (msg.sender != owner) revert UnauthorizedOwner(msg.sender);
        if (
            delegate == address(0) || delegate == owner || authorities == 0
                || authorities & ~AUTHORITY_RECOVERY_EXIT != 0 || expiresAt <= block.timestamp
                || expiresAt > block.timestamp + MAX_DELEGATION_WINDOW
        ) revert InvalidDelegation();
        _delegations[delegate] = Delegation(authorities, expiresAt, delegationEpoch);
        emit DelegationSet(delegate, authorities, expiresAt, delegationEpoch);
    }

    function revokeDelegation(address delegate) external {
        if (msg.sender != owner) revert UnauthorizedOwner(msg.sender);
        delete _delegations[delegate];
        emit DelegationRevoked(delegate);
    }

    function delegationOf(address delegate) external view returns (Delegation memory) {
        return _delegations[delegate];
    }

    function hasAuthority(address actor, uint8 authority) public view returns (bool) {
        if (actor == owner) return true;
        Delegation memory delegation = _delegations[actor];
        return delegation.epoch == delegationEpoch && delegation.authorities & authority != 0
            && block.timestamp < delegation.expiresAt;
    }

    function isValidSignature(bytes32 hash, bytes memory signature) external view returns (bytes4) {
        return
            OwnerSignature.isValidNow(owner, hash, signature) ? IERC1271.isValidSignature.selector : bytes4(0xffffffff);
    }

    function executePackage(
        PackageVerifier.Execution calldata execution,
        ResourceRegistry.CashCarryAdmission calldata admission,
        bytes calldata traderSignature,
        bytes calldata solverSignature,
        bytes32[2] calldata perpArgs
    ) external nonReentrant returns (bytes32 receiptHash) {
        _validateExecution(execution);
        verifier.begin(execution, admission, traderSignature, solverSignature);
        _execute(execution, perpArgs);
        return verifier.finalize(execution, admission, false);
    }

    function executeQuotedPackage(
        PackageVerifier.Execution calldata execution,
        ResourceRegistry.CashCarryAdmission calldata admission,
        PackageVerifier.QuoteIntent calldata quoteIntent,
        bytes calldata traderSignature,
        bytes calldata solverSignature,
        bytes32[2] calldata perpArgs
    ) external nonReentrant returns (bytes32 receiptHash) {
        _validateExecution(execution);
        verifier.beginFromQuoteShard(execution, admission, quoteIntent, traderSignature, solverSignature);
        _execute(execution, perpArgs);
        return verifier.finalize(execution, admission, false);
    }

    function executeRecoveryExit(
        PackageVerifier.Execution calldata execution,
        ResourceRegistry.CashCarryAdmission calldata admission,
        bytes calldata traderSignature,
        bytes32[2] calldata perpArgs
    ) external nonReentrant returns (bytes32 receiptHash) {
        if (
            !hasAuthority(msg.sender, AUTHORITY_RECOVERY_EXIT) || execution.action != EXIT
                || execution.solver != address(0)
        ) {
            revert InvalidRecoveryExit();
        }
        _validateExecution(execution);
        verifier.beginRecoveryExit(execution, admission, traderSignature);
        _exit(execution, perpArgs);
        return verifier.finalize(execution, admission, true);
    }

    /// @notice Closes this account's open package record after the venue liquidated its perpetual leg.
    /// Owner only; the verifier closes it only while the package's perpetual position is fully flat, and
    /// the spot leg stays here for the owner to withdraw or sell.
    function closeLiquidatedPackage() external nonReentrant returns (bytes32 closureHash) {
        if (msg.sender != owner) revert UnauthorizedOwner(msg.sender);
        if (block.chainid != deploymentChainId || address(verifier).codehash != verifierCodeHash) {
            revert InvalidConfiguration();
        }
        return verifier.closeLiquidatedPackage();
    }

    function withdrawIdleToken(IERC20 token, address recipient, uint256 amount) external nonReentrant {
        if (msg.sender != owner) revert UnauthorizedWithdrawal();
        if (address(token) == address(0) || recipient == address(0) || amount == 0) revert InvalidWithdrawal();
        if (block.chainid != deploymentChainId || address(verifier).codehash != verifierCodeHash) {
            revert InvalidConfiguration();
        }
        if (verifier.hasOpenPackage(address(this))) revert OpenPackageExists();

        uint256 senderBalanceBefore = token.balanceOf(address(this));
        uint256 recipientBalanceBefore = token.balanceOf(recipient);
        if (senderBalanceBefore < amount || recipientBalanceBefore > type(uint256).max - amount) {
            revert InvalidWithdrawal();
        }

        token.safeTransfer(recipient, amount);

        if (
            token.balanceOf(address(this)) != senderBalanceBefore - amount
                || token.balanceOf(recipient) != recipientBalanceBefore + amount
        ) revert WithdrawalPostconditionFailed();
        emit IdleTokenWithdrawn(address(token), recipient, amount);
    }

    /// @notice Moves idle collateral into this account's free reserve at a perpetual venue's gate, where
    /// package entries draw perp margin from. The venue is the active registry record for
    /// `venueSubjectId`, at its registered code hash, in a lifecycle that permits entry; the allowance is
    /// exact and reset in the same call.
    function depositPerpMargin(bytes32 venueSubjectId, uint256 amount) external nonReentrant {
        IPerpMarginGate gate = _perpMarginGate(venueSubjectId, ENTRY);
        IERC20 collateral = gate.collateral();
        uint256 accountBefore = collateral.balanceOf(address(this));
        uint256 reserveBefore = gate.reserveOf(address(this));
        if (amount == 0 || accountBefore < amount || reserveBefore > type(uint256).max - amount) {
            revert InvalidMarginTransfer();
        }

        collateral.forceApprove(address(gate), amount);
        gate.deposit(amount);
        collateral.forceApprove(address(gate), 0);

        if (
            collateral.balanceOf(address(this)) != accountBefore - amount
                || gate.reserveOf(address(this)) != reserveBefore + amount
        ) revert MarginTransferPostconditionFailed();
        emit PerpMarginDeposited(address(gate), venueSubjectId, amount);
    }

    /// @notice Returns free reserve from a perpetual venue's gate to this account. Allowed in every
    /// lifecycle that still permits exits.
    function withdrawPerpMargin(bytes32 venueSubjectId, uint256 amount) external nonReentrant {
        IPerpMarginGate gate = _perpMarginGate(venueSubjectId, EXIT);
        IERC20 collateral = gate.collateral();
        uint256 accountBefore = collateral.balanceOf(address(this));
        uint256 reserveBefore = gate.reserveOf(address(this));
        if (amount == 0 || reserveBefore < amount || accountBefore > type(uint256).max - amount) {
            revert InvalidMarginTransfer();
        }

        gate.withdraw(amount);

        if (
            collateral.balanceOf(address(this)) != accountBefore + amount
                || gate.reserveOf(address(this)) != reserveBefore - amount
        ) revert MarginTransferPostconditionFailed();
        emit PerpMarginWithdrawn(address(gate), venueSubjectId, amount);
    }

    function _perpMarginGate(bytes32 venueSubjectId, uint8 action) private view returns (IPerpMarginGate) {
        if (msg.sender != owner) revert UnauthorizedOwner(msg.sender);
        if (block.chainid != deploymentChainId || address(verifier).codehash != verifierCodeHash) {
            revert InvalidConfiguration();
        }
        ResourceRegistry registry = verifier.resourceRegistry();
        if (address(registry).codehash != verifier.resourceRegistryCodeHash()) revert InvalidConfiguration();
        (ResourceRegistry.ResourceBinding memory venue, ResourceRegistry.ResourceControl memory control) =
            registry.activeResource(ResourceRegistry.ResourceKind.VENUE, venueSubjectId);
        ResourceRegistry.Lifecycle state = control.state;
        bool permitted = state == ResourceRegistry.Lifecycle.ACTIVE
            || (action == EXIT
                && (state == ResourceRegistry.Lifecycle.ENTRY_PAUSED || state == ResourceRegistry.Lifecycle.EXIT_ONLY));
        if (
            !permitted || venue.kind != ResourceRegistry.ResourceKind.VENUE || venue.localAddress.code.length == 0
                || venue.localAddress.codehash != venue.expectedCodeHash
        ) revert UnregisteredPerpVenue();
        return IPerpMarginGate(venue.localAddress);
    }

    function _validateExecution(PackageVerifier.Execution calldata execution) private view {
        if (
            block.chainid != deploymentChainId || address(verifier).codehash != verifierCodeHash
                || execution.strategyAccount != address(this) || (execution.action != ENTRY && execution.action != EXIT)
        ) revert InvalidExecution();
    }

    function _execute(PackageVerifier.Execution calldata execution, bytes32[2] calldata perpArgs) private {
        if (execution.action == ENTRY) {
            _entry(execution, perpArgs);
        } else {
            _exit(execution, perpArgs);
        }
    }

    function _entry(PackageVerifier.Execution calldata execution, bytes32[2] calldata perpArgs) private {
        IERC20 quoteToken = IERC20(execution.quoteToken);
        address quoteSpender = execution.spotPort;
        try IFirmInventorySpotPort(execution.spotPort).reservationBook() returns (address reservationBook) {
            if (reservationBook.code.length == 0) revert InvalidExecution();
            quoteSpender = reservationBook;
        } catch {}
        quoteToken.forceApprove(quoteSpender, execution.spotQuoteBoundAtoms);
        IExactSpotPort(execution.spotPort)
            .buyExactOutput(
                execution.nonce,
                execution.spotFillCommitment,
                execution.orderHash,
                execution.quoteHash,
                execution.routeHash,
                execution.baseQuantityAtoms,
                execution.spotQuoteBoundAtoms
            );
        quoteToken.forceApprove(quoteSpender, 0);
        ISynFuturesInstrument(execution.perpInstrument).trade(perpArgs);
    }

    function _exit(PackageVerifier.Execution calldata execution, bytes32[2] calldata perpArgs) private {
        ISynFuturesInstrument(execution.perpInstrument).trade(perpArgs);
        IERC20 baseToken = IERC20(execution.baseToken);
        baseToken.forceApprove(execution.spotPort, execution.baseQuantityAtoms);
        IExactSpotPort(execution.spotPort)
            .sellExactInput(
                execution.nonce,
                execution.spotFillCommitment,
                execution.orderHash,
                execution.quoteHash,
                execution.routeHash,
                execution.baseQuantityAtoms,
                execution.spotQuoteBoundAtoms
            );
        baseToken.forceApprove(execution.spotPort, 0);
    }
}

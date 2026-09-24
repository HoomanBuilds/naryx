// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC1271} from "openzeppelin-contracts/interfaces/IERC1271.sol";
import {IERC20} from "openzeppelin-contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/token/ERC20/utils/SafeERC20.sol";
import {SignatureChecker} from "openzeppelin-contracts/utils/cryptography/SignatureChecker.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/utils/ReentrancyGuard.sol";
import {PackageVerifier} from "./PackageVerifier.sol";
import {ResourceRegistry} from "./ResourceRegistry.sol";
import {IExactSpotPort} from "./interfaces/IExactSpotPort.sol";
import {ISynFuturesInstrument} from "./interfaces/ISynFuturesInstrument.sol";

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

    event IdleTokenWithdrawn(address indexed token, address indexed recipient, uint256 amount);

    address public immutable owner;
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

    function isValidSignature(bytes32 hash, bytes memory signature) external view returns (bytes4) {
        return SignatureChecker.isValidSignatureNow(owner, hash, signature)
            ? IERC1271.isValidSignature.selector
            : bytes4(0xffffffff);
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
        if (msg.sender != owner || execution.action != EXIT || execution.solver != address(0)) {
            revert InvalidRecoveryExit();
        }
        _validateExecution(execution);
        verifier.beginRecoveryExit(execution, admission, traderSignature);
        _exit(execution, perpArgs);
        return verifier.finalize(execution, admission, true);
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

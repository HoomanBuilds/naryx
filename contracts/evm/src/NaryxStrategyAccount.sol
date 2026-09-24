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

contract NaryxStrategyAccount is IERC1271, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint8 private constant ENTRY = 1;
    uint8 private constant EXIT = 2;

    error InvalidConfiguration();
    error InvalidExecution();
    error InvalidRecoveryExit();

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
        quoteToken.forceApprove(execution.spotPort, execution.spotQuoteBoundAtoms);
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
        quoteToken.forceApprove(execution.spotPort, 0);
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

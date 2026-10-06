// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "openzeppelin-contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "openzeppelin-contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "openzeppelin-contracts/utils/cryptography/MessageHashUtils.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/utils/ReentrancyGuard.sol";
import {ProtocolConfig} from "./ProtocolConfig.sol";
import {SolverRegistry} from "./SolverRegistry.sol";
import {StrategyFeePolicyRegistry} from "./StrategyFeePolicyRegistry.sol";
import {TypedStrategyAdapterRegistry} from "./TypedStrategyAdapterRegistry.sol";
import {ITypedStrategyAdapter} from "./interfaces/ITypedStrategyAdapter.sol";
import {OwnerSignature} from "./libraries/OwnerSignature.sol";

contract NaryxMultiStrategyAccount is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint8 public constant ENTER = 1;
    uint8 public constant INCREASE = 2;
    uint8 public constant DECREASE = 3;
    uint8 public constant REBALANCE = 4;
    uint8 public constant ROLL = 5;
    uint8 public constant MIGRATE = 6;
    uint8 public constant EXIT = 7;
    uint8 public constant EMERGENCY_UNWIND = 8;
    uint256 public constant MAX_CALLS = 16;
    uint256 private constant POST_CALL_GAS_RESERVE = 100_000;

    bytes32 private constant OWNER_EXECUTION_TYPEHASH =
        keccak256("OwnerExecution(bytes32 executionHash,bytes32 callsHash)");
    bytes32 private constant SOLVER_EXECUTION_TYPEHASH =
        keccak256("SolverExecution(bytes32 executionHash,bytes32 callsHash)");
    bytes32 private constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant EIP712_NAME_HASH = keccak256("Naryx Multi Strategy Account");
    bytes32 private constant EIP712_VERSION_HASH = keccak256("1");

    struct Execution {
        bytes32 domainIdHash;
        uint32 domainManifestVersion;
        bytes32 domainManifestHash;
        bytes32 packageId;
        bytes32 orderHash;
        bytes32 graphHash;
        bytes32 quoteHash;
        bytes32 routeHash;
        TypedStrategyAdapterRegistry.TemplateRef template;
        TypedStrategyAdapterRegistry.SettlementClassRef settlementClass;
        uint8 operation;
        bytes32 previousStateHash;
        bytes32 nextStateHash;
        uint256 totalGrossNotionalAtoms;
        FeeTerms fees;
        address solver;
        uint256 nonce;
        uint256 deadline;
    }

    struct FeeTerms {
        uint32 policyVersion;
        bytes32 policyManifestHash;
        address token;
        uint256 protocolFeeAtoms;
        uint256 solverFeeAtoms;
    }

    struct AdapterCall {
        TypedStrategyAdapterRegistry.ManifestRef adapter;
        uint8 stage;
        bool riskIncreasing;
        address approvalToken;
        uint256 approvalAtoms;
        uint256 grossNotionalAtoms;
        uint256 gasLimit;
        bytes payload;
    }

    struct PackageState {
        TypedStrategyAdapterRegistry.TemplateRef template;
        bytes32 stateHash;
        bytes32 lastReceiptHash;
        bool active;
    }

    struct Receipt {
        bytes32 packageId;
        bytes32 orderHash;
        bytes32 graphHash;
        bytes32 quoteHash;
        bytes32 routeHash;
        uint8 operation;
        bytes32 previousStateHash;
        bytes32 nextStateHash;
        bytes32 callsHash;
        bytes32 evidenceRoot;
        FeeTerms fees;
        uint256 nonce;
        address solver;
    }

    error InvalidConfiguration();
    error InvalidExecution();
    error DomainMismatch();
    error EntryPaused();
    error Expired();
    error InvalidNonce();
    error InvalidOwnerSignature();
    error InvalidSolverSignature();
    error InvalidPackageState();
    error InvalidStageOrder();
    error AdapterExecutionFailed(uint256 callIndex, bytes returnData);
    error AdapterEvidenceInvalid(uint256 callIndex);
    error InsufficientGas(uint256 callIndex);

    event StrategyExecuted(
        bytes32 indexed receiptHash,
        bytes32 indexed packageId,
        uint8 indexed operation,
        address solver,
        bytes32 evidenceRoot,
        bytes32 nextStateHash
    );
    event AdapterLegExecuted(
        bytes32 indexed receiptHash,
        bytes32 indexed packageId,
        uint256 indexed callIndex,
        bytes32 adapterSubjectId,
        uint8 stage,
        bytes32 evidenceHash
    );
    event StrategyFeesCollected(
        bytes32 indexed receiptHash,
        address indexed token,
        address indexed protocolRecipient,
        address solverRecipient,
        uint256 protocolFeeAtoms,
        uint256 solverFeeAtoms
    );

    address public owner;
    address public immutable accountFactory;
    ProtocolConfig public immutable config;
    SolverRegistry public immutable solverRegistry;
    TypedStrategyAdapterRegistry public immutable adapterRegistry;
    StrategyFeePolicyRegistry public immutable feePolicyRegistry;
    bytes32 public immutable feePolicySubjectId;
    uint256 public immutable deploymentChainId;
    bytes32 public immutable deploymentDomainIdHash;
    bytes32 public immutable configCodeHash;
    bytes32 public immutable solverRegistryCodeHash;
    bytes32 public immutable adapterRegistryCodeHash;
    bytes32 public immutable feePolicyRegistryCodeHash;

    uint256 public nextNonce;
    mapping(bytes32 packageId => PackageState state) private _packages;
    mapping(bytes32 receiptHash => Receipt receipt) private _receipts;

    constructor(
        address owner_,
        ProtocolConfig config_,
        SolverRegistry solverRegistry_,
        TypedStrategyAdapterRegistry adapterRegistry_,
        StrategyFeePolicyRegistry feePolicyRegistry_,
        bytes32 feePolicySubjectId_
    ) {
        if (
            owner_ == address(0) || owner_ == address(this) || address(config_).code.length == 0
                || address(solverRegistry_).code.length == 0 || address(adapterRegistry_).code.length == 0
                || address(feePolicyRegistry_).code.length == 0 || feePolicySubjectId_ == bytes32(0)
                || address(solverRegistry_.config()) != address(config_)
                || address(adapterRegistry_.config()) != address(config_)
                || address(feePolicyRegistry_.config()) != address(config_)
        ) revert InvalidConfiguration();
        (string memory domainId,,) = config_.domain();
        owner = owner_;
        accountFactory = msg.sender;
        config = config_;
        solverRegistry = solverRegistry_;
        adapterRegistry = adapterRegistry_;
        feePolicyRegistry = feePolicyRegistry_;
        feePolicySubjectId = feePolicySubjectId_;
        deploymentChainId = block.chainid;
        deploymentDomainIdHash = keccak256(bytes(domainId));
        configCodeHash = address(config_).codehash;
        solverRegistryCodeHash = address(solverRegistry_).codehash;
        adapterRegistryCodeHash = address(adapterRegistry_).codehash;
        feePolicyRegistryCodeHash = address(feePolicyRegistry_).codehash;
    }

    function packageState(bytes32 packageId) external view returns (PackageState memory) {
        return _packages[packageId];
    }

    function receipt(bytes32 receiptHash) external view returns (Receipt memory) {
        return _receipts[receiptHash];
    }

    function callsHash(AdapterCall[] calldata calls) public pure returns (bytes32) {
        return keccak256(abi.encode(calls));
    }

    function ownerDigest(Execution calldata execution, AdapterCall[] calldata calls) external view returns (bytes32) {
        return
            _hashTypedDataV4(
                keccak256(abi.encode(OWNER_EXECUTION_TYPEHASH, _executionHash(execution), callsHash(calls)))
            );
    }

    function solverDigest(Execution calldata execution, AdapterCall[] calldata calls) external view returns (bytes32) {
        return
            _hashTypedDataV4(
                keccak256(abi.encode(SOLVER_EXECUTION_TYPEHASH, _executionHash(execution), callsHash(calls)))
            );
    }

    function execute(
        Execution calldata execution,
        AdapterCall[] calldata calls,
        bytes calldata ownerSignature,
        bytes calldata solverSignature
    ) external nonReentrant returns (bytes32 receiptHash) {
        bytes32 callCommitment = callsHash(calls);
        _validate(execution, calls, callCommitment, ownerSignature, true);
        bytes32 solverHash = _hashTypedDataV4(
            keccak256(abi.encode(SOLVER_EXECUTION_TYPEHASH, _executionHash(execution), callCommitment))
        );
        if (ECDSA.recover(solverHash, solverSignature) != execution.solver) revert InvalidSolverSignature();
        return _settle(execution, calls, callCommitment);
    }

    function executeRecovery(Execution calldata execution, AdapterCall[] calldata calls, bytes calldata ownerSignature)
        external
        nonReentrant
        returns (bytes32 receiptHash)
    {
        bytes32 callCommitment = callsHash(calls);
        _validate(execution, calls, callCommitment, ownerSignature, false);
        return _settle(execution, calls, callCommitment);
    }

    function _settle(Execution calldata execution, AdapterCall[] calldata calls, bytes32 callCommitment)
        private
        returns (bytes32 receiptHash)
    {
        _validateState(_packages[execution.packageId], execution);
        nextNonce = execution.nonce + 1;
        bytes32[] memory evidence = _executeCalls(execution, calls);
        address protocolRecipient = _collectFees(execution);
        return _finalize(execution, calls, evidence, callCommitment, protocolRecipient);
    }

    function _finalize(
        Execution calldata execution,
        AdapterCall[] calldata calls,
        bytes32[] memory evidence,
        bytes32 callCommitment,
        address protocolRecipient
    ) private returns (bytes32 receiptHash) {
        bytes32 evidenceRoot = keccak256(abi.encode(evidence));
        receiptHash = _receiptHash(execution, callCommitment, evidenceRoot);
        _receipts[receiptHash] = Receipt({
            packageId: execution.packageId,
            orderHash: execution.orderHash,
            graphHash: execution.graphHash,
            quoteHash: execution.quoteHash,
            routeHash: execution.routeHash,
            operation: execution.operation,
            previousStateHash: execution.previousStateHash,
            nextStateHash: execution.nextStateHash,
            callsHash: callCommitment,
            evidenceRoot: evidenceRoot,
            fees: execution.fees,
            nonce: execution.nonce,
            solver: execution.solver
        });

        if (execution.operation == EXIT || execution.operation == EMERGENCY_UNWIND) {
            delete _packages[execution.packageId];
        } else {
            PackageState storage state = _packages[execution.packageId];
            state.template = execution.template;
            state.stateHash = execution.nextStateHash;
            state.lastReceiptHash = receiptHash;
            state.active = true;
        }
        emit StrategyExecuted(
            receiptHash,
            execution.packageId,
            execution.operation,
            execution.solver,
            evidenceRoot,
            execution.nextStateHash
        );
        if (execution.fees.protocolFeeAtoms != 0 || execution.fees.solverFeeAtoms != 0) {
            emit StrategyFeesCollected(
                receiptHash,
                execution.fees.token,
                protocolRecipient,
                execution.solver,
                execution.fees.protocolFeeAtoms,
                execution.fees.solverFeeAtoms
            );
        }
        for (uint256 index = 0; index < calls.length; ++index) {
            emit AdapterLegExecuted(
                receiptHash,
                execution.packageId,
                index,
                calls[index].adapter.subjectId,
                calls[index].stage,
                evidence[index]
            );
        }
    }

    function _executeCalls(Execution calldata execution, AdapterCall[] calldata calls)
        private
        returns (bytes32[] memory evidence)
    {
        evidence = new bytes32[](calls.length);
        for (uint256 index = 0; index < calls.length; ++index) {
            evidence[index] = _executeAdapterCall(execution, calls[index], index);
        }
    }

    function _collectFees(Execution calldata execution) private returns (address protocolRecipient) {
        FeeTerms calldata fees = execution.fees;
        if (execution.solver == address(0)) {
            if (
                fees.policyVersion != 0 || fees.policyManifestHash != bytes32(0) || fees.token != address(0)
                    || fees.protocolFeeAtoms != 0 || fees.solverFeeAtoms != 0
            ) revert InvalidExecution();
            return address(0);
        }
        if (fees.policyVersion == 0 || fees.policyManifestHash == bytes32(0) || fees.token == address(0)) {
            revert InvalidExecution();
        }
        protocolRecipient = feePolicyRegistry.validateFees(
            feePolicySubjectId,
            fees.policyVersion,
            fees.policyManifestHash,
            fees.token,
            fees.protocolFeeAtoms,
            fees.solverFeeAtoms,
            execution.totalGrossNotionalAtoms
        );
        if (fees.protocolFeeAtoms != 0) {
            IERC20(fees.token).safeTransfer(protocolRecipient, fees.protocolFeeAtoms);
        }
        if (fees.solverFeeAtoms != 0) IERC20(fees.token).safeTransfer(execution.solver, fees.solverFeeAtoms);
    }

    function _receiptHash(Execution calldata execution, bytes32 callCommitment, bytes32 evidenceRoot)
        private
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(_executionHash(execution), callCommitment, evidenceRoot));
    }

    function _executeAdapterCall(Execution calldata execution, AdapterCall calldata item, uint256 callIndex)
        private
        returns (bytes32 evidenceHash)
    {
        address adapter = adapterRegistry.validateCall(
            item.adapter,
            execution.template,
            execution.settlementClass,
            item.riskIncreasing,
            item.approvalToken,
            item.approvalAtoms,
            item.grossNotionalAtoms,
            item.gasLimit
        );
        if (gasleft() <= item.gasLimit + POST_CALL_GAS_RESERVE) revert InsufficientGas(callIndex);
        if (item.approvalAtoms != 0) IERC20(item.approvalToken).forceApprove(adapter, item.approvalAtoms);
        (bool success, bytes memory result) =
            adapter.call{gas: item.gasLimit}(abi.encodeCall(ITypedStrategyAdapter.executeLeg, (item.payload)));
        if (!success) revert AdapterExecutionFailed(callIndex, result);
        if (item.approvalAtoms != 0) IERC20(item.approvalToken).forceApprove(adapter, 0);
        if (result.length != 32) revert AdapterEvidenceInvalid(callIndex);
        evidenceHash = abi.decode(result, (bytes32));
        if (evidenceHash == bytes32(0)) revert AdapterEvidenceInvalid(callIndex);
    }

    function _validate(
        Execution calldata execution,
        AdapterCall[] calldata calls,
        bytes32 callCommitment,
        bytes calldata ownerSignature,
        bool requiresSolver
    ) private view {
        if (
            block.chainid != deploymentChainId || address(config).codehash != configCodeHash
                || address(solverRegistry).codehash != solverRegistryCodeHash
                || address(adapterRegistry).codehash != adapterRegistryCodeHash
                || address(feePolicyRegistry).codehash != feePolicyRegistryCodeHash
        ) revert InvalidConfiguration();
        if (
            execution.packageId == bytes32(0) || execution.orderHash == bytes32(0) || execution.graphHash == bytes32(0)
                || execution.quoteHash == bytes32(0) || execution.routeHash == bytes32(0)
                || execution.template.templateId == bytes32(0) || execution.template.templateVersion == 0
                || execution.template.templateManifestHash == bytes32(0)
                || execution.settlementClass.classId != adapterRegistry.ATOMIC_POSTCONDITION_ID()
                || execution.settlementClass.classVersion != adapterRegistry.ATOMIC_POSTCONDITION_VERSION()
                || execution.operation < ENTER || execution.operation > EMERGENCY_UNWIND
                || execution.totalGrossNotionalAtoms == 0 || execution.nonce != nextNonce || calls.length == 0
                || calls.length > MAX_CALLS
        ) revert InvalidExecution();
        if (block.timestamp >= execution.deadline) revert Expired();
        (string memory domainId, uint32 version, bytes32 manifestHash) = config.domain();
        if (
            execution.domainIdHash != deploymentDomainIdHash || execution.domainIdHash != keccak256(bytes(domainId))
                || execution.domainManifestVersion != version || execution.domainManifestHash != manifestHash
        ) revert DomainMismatch();
        if (requiresSolver) {
            if (execution.solver == address(0) || !solverRegistry.isActiveSolver(execution.solver)) {
                revert InvalidSolverSignature();
            }
        } else if (
            execution.solver != address(0)
                || (execution.operation != DECREASE
                    && execution.operation != EXIT
                    && execution.operation != EMERGENCY_UNWIND)
        ) {
            revert InvalidExecution();
        }
        uint8 previousStage = calls[0].stage;
        if (previousStage != 0) revert InvalidStageOrder();
        bool hasRiskIncreasingCall;
        uint256 grossNotionalAtoms;
        for (uint256 index = 1; index < calls.length; ++index) {
            uint8 currentStage = calls[index].stage;
            if (currentStage < previousStage || currentStage > previousStage + 1) revert InvalidStageOrder();
            previousStage = currentStage;
        }
        for (uint256 index = 0; index < calls.length; ++index) {
            bool callIncreasesRisk = calls[index].riskIncreasing;
            if ((execution.operation == ENTER || execution.operation == INCREASE) && !callIncreasesRisk) {
                revert InvalidExecution();
            }
            if (
                (execution.operation == DECREASE
                        || execution.operation == EXIT
                        || execution.operation == EMERGENCY_UNWIND) && callIncreasesRisk
            ) revert InvalidExecution();
            hasRiskIncreasingCall = hasRiskIncreasingCall || callIncreasesRisk;
            grossNotionalAtoms += calls[index].grossNotionalAtoms;
        }
        if (grossNotionalAtoms != execution.totalGrossNotionalAtoms) revert InvalidExecution();
        if (hasRiskIncreasingCall && config.entryPaused()) revert EntryPaused();
        bytes32 executionHash = _executionHash(execution);
        bytes32 ownerHash =
            _hashTypedDataV4(keccak256(abi.encode(OWNER_EXECUTION_TYPEHASH, executionHash, callCommitment)));
        if (!OwnerSignature.isValidNow(owner, ownerHash, ownerSignature)) revert InvalidOwnerSignature();
    }

    function _validateState(PackageState storage state, Execution calldata execution) private view {
        if (execution.operation == ENTER) {
            if (state.active || execution.previousStateHash != bytes32(0) || execution.nextStateHash == bytes32(0)) {
                revert InvalidPackageState();
            }
            return;
        }
        if (
            !state.active || state.stateHash != execution.previousStateHash
                || state.template.templateId != execution.template.templateId
                || state.template.templateVersion != execution.template.templateVersion
                || state.template.templateManifestHash != execution.template.templateManifestHash
        ) revert InvalidPackageState();
        if ((execution.operation == EXIT || execution.operation == EMERGENCY_UNWIND)
                ? execution.nextStateHash != bytes32(0)
                : execution.nextStateHash == bytes32(0)) revert InvalidPackageState();
    }

    function _executionHash(Execution calldata execution) private pure returns (bytes32) {
        return keccak256(abi.encode(execution));
    }

    function _hashTypedDataV4(bytes32 structHash) private view returns (bytes32) {
        bytes32 domainSeparator = keccak256(
            abi.encode(EIP712_DOMAIN_TYPEHASH, EIP712_NAME_HASH, EIP712_VERSION_HASH, block.chainid, address(this))
        );
        return MessageHashUtils.toTypedDataHash(domainSeparator, structHash);
    }
}

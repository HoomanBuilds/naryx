// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Script} from "forge-std/Script.sol";
import {Strings} from "openzeppelin-contracts/utils/Strings.sol";
import {ProtocolConfig} from "../src/ProtocolConfig.sol";
import {StrategyFeePolicyRegistry} from "../src/StrategyFeePolicyRegistry.sol";
import {TypedStrategyAdapterRegistry} from "../src/TypedStrategyAdapterRegistry.sol";

contract ConfigureEvmMultiStrategyCore is Script {
    using Strings for uint256;

    uint8 private constant PROPOSER = 0;
    uint8 private constant CANCELLER = 1;
    uint8 private constant EXECUTOR = 2;
    uint8 private constant PAUSER = 3;

    error InvalidChain();
    error InvalidConfiguration();
    error InvalidOperator();

    function runProposeFeePolicy(
        StrategyFeePolicyRegistry registry,
        bytes32 subjectId,
        StrategyFeePolicyRegistry.Policy calldata policy,
        address operatorAddress
    ) external {
        ProtocolConfig config = registry.config();
        _requireConfiguration(config, address(registry));
        _requireOperator(config, operatorAddress, PROPOSER);
        vm.startBroadcast(operatorAddress);
        registry.proposePolicy(subjectId, policy);
        vm.stopBroadcast();
    }

    function runActivateFeePolicy(StrategyFeePolicyRegistry registry, bytes32 subjectId, address operatorAddress)
        external
    {
        ProtocolConfig config = registry.config();
        _requireConfiguration(config, address(registry));
        _requireOperator(config, operatorAddress, EXECUTOR);
        vm.startBroadcast(operatorAddress);
        registry.activate(subjectId);
        vm.stopBroadcast();
    }

    function runPauseFeePolicy(StrategyFeePolicyRegistry registry, bytes32 subjectId, address operatorAddress)
        external
    {
        ProtocolConfig config = registry.config();
        _requireConfiguration(config, address(registry));
        _requireOperator(config, operatorAddress, PAUSER);
        vm.startBroadcast(operatorAddress);
        registry.pause(subjectId);
        vm.stopBroadcast();
    }

    function runProposeFeePolicyResume(StrategyFeePolicyRegistry registry, bytes32 subjectId, address operatorAddress)
        external
    {
        ProtocolConfig config = registry.config();
        _requireConfiguration(config, address(registry));
        _requireOperator(config, operatorAddress, PROPOSER);
        vm.startBroadcast(operatorAddress);
        registry.proposeResume(subjectId);
        vm.stopBroadcast();
    }

    function runCancelFeePolicy(StrategyFeePolicyRegistry registry, bytes32 subjectId, address operatorAddress)
        external
    {
        ProtocolConfig config = registry.config();
        _requireConfiguration(config, address(registry));
        _requireOperator(config, operatorAddress, CANCELLER);
        vm.startBroadcast(operatorAddress);
        registry.cancel(subjectId);
        vm.stopBroadcast();
    }

    function runProposeAdapter(
        TypedStrategyAdapterRegistry registry,
        TypedStrategyAdapterRegistry.AdapterBinding calldata binding,
        TypedStrategyAdapterRegistry.AdapterControl calldata control,
        address operatorAddress
    ) external {
        ProtocolConfig config = registry.config();
        _requireConfiguration(config, address(registry));
        _requireOperator(config, operatorAddress, PROPOSER);
        vm.startBroadcast(operatorAddress);
        registry.proposeRegistration(binding, control);
        vm.stopBroadcast();
    }

    function runActivateAdapter(TypedStrategyAdapterRegistry registry, bytes32 subjectId, address operatorAddress)
        external
    {
        ProtocolConfig config = registry.config();
        _requireConfiguration(config, address(registry));
        _requireOperator(config, operatorAddress, EXECUTOR);
        vm.startBroadcast(operatorAddress);
        registry.activateRegistration(subjectId);
        vm.stopBroadcast();
    }

    function runCancelAdapter(TypedStrategyAdapterRegistry registry, bytes32 subjectId, address operatorAddress)
        external
    {
        ProtocolConfig config = registry.config();
        _requireConfiguration(config, address(registry));
        _requireOperator(config, operatorAddress, CANCELLER);
        vm.startBroadcast(operatorAddress);
        registry.cancelRegistration(subjectId);
        vm.stopBroadcast();
    }

    function runTightenAdapter(
        TypedStrategyAdapterRegistry registry,
        TypedStrategyAdapterRegistry.ManifestRef calldata identity,
        TypedStrategyAdapterRegistry.Lifecycle state,
        uint256 maximumApprovalAtoms,
        uint256 maximumGrossNotionalAtoms,
        address operatorAddress
    ) external {
        ProtocolConfig config = registry.config();
        _requireConfiguration(config, address(registry));
        _requireOperator(config, operatorAddress, PAUSER);
        vm.startBroadcast(operatorAddress);
        registry.tightenControl(identity, state, maximumApprovalAtoms, maximumGrossNotionalAtoms);
        vm.stopBroadcast();
    }

    function _requireConfiguration(ProtocolConfig config, address registry) private view {
        if (registry.code.length == 0 || address(config).code.length == 0) revert InvalidConfiguration();
        (string memory domainId,,) = config.domain();
        string memory expectedDomainId = string.concat("eip155:", block.chainid.toString());
        if (keccak256(bytes(domainId)) != keccak256(bytes(expectedDomainId))) revert InvalidChain();
    }

    function _requireOperator(ProtocolConfig config, address operatorAddress, uint8 role) private view {
        (address proposer, address canceller, address executor, address pauser) = config.roles();
        address required =
            role == PROPOSER ? proposer : role == CANCELLER ? canceller : role == EXECUTOR ? executor : pauser;
        if (operatorAddress == address(0) || operatorAddress != required) revert InvalidOperator();
    }
}

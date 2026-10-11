// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Script} from "forge-std/Script.sol";
import {ProtocolConfig} from "../src/ProtocolConfig.sol";
import {TypedStrategyAdapterRegistry} from "../src/TypedStrategyAdapterRegistry.sol";
import {ITypedStrategyAdapterFactory} from "../src/interfaces/ITypedStrategyAdapterFactory.sol";
import {TestnetChains} from "./TestnetChains.sol";

contract ConfigureEvmExtendedStrategyAdapters is Script {
    bytes32 private constant ATOMIC_POSTCONDITION_ID = keccak256("ATOMIC_POSTCONDITION");

    struct AdapterInput {
        string adapterId;
        bytes32 adapterManifestHash;
        address factory;
        string templateId;
        bytes32 templateManifestHash;
    }

    struct Parameters {
        uint256 expectedChainId;
        ProtocolConfig config;
        TypedStrategyAdapterRegistry registry;
        AdapterInput[] adapters;
    }

    error InvalidChain();
    error InvalidConfiguration();
    error InvalidOperator();

    function runPropose(Parameters calldata parameters, address operatorAddress) external {
        _validate(parameters);
        _requireOperator(parameters.config, operatorAddress, true);
        vm.startBroadcast(operatorAddress);
        for (uint256 index; index < parameters.adapters.length; ++index) {
            parameters.registry.proposeRegistration(
                _binding(parameters, parameters.adapters[index]),
                TypedStrategyAdapterRegistry.AdapterControl({
                    state: TypedStrategyAdapterRegistry.Lifecycle.ACTIVE,
                    maximumApprovalAtoms: 1_000_000 ether,
                    maximumGrossNotionalAtoms: 10_000_000_000_000
                })
            );
        }
        vm.stopBroadcast();
    }

    function runActivate(Parameters calldata parameters, address operatorAddress) external {
        _validate(parameters);
        _requireOperator(parameters.config, operatorAddress, false);
        vm.startBroadcast(operatorAddress);
        for (uint256 index; index < parameters.adapters.length; ++index) {
            parameters.registry.activateRegistration(keccak256(bytes(parameters.adapters[index].adapterId)));
        }
        vm.stopBroadcast();
    }

    function _binding(Parameters calldata parameters, AdapterInput calldata input)
        private
        view
        returns (TypedStrategyAdapterRegistry.AdapterBinding memory binding)
    {
        (bytes32 classId, uint32 classVersion, address baseAsset, address quoteAsset) =
            ITypedStrategyAdapterFactory(input.factory).factoryMetadata();
        (string memory domainId, uint32 domainVersion, bytes32 domainHash) = parameters.config.domain();
        binding.domain = TypedStrategyAdapterRegistry.DomainRef({
            domainIdHash: keccak256(bytes(domainId)), manifestVersion: domainVersion, manifestHash: domainHash
        });
        binding.identity = TypedStrategyAdapterRegistry.ManifestRef({
            subjectId: keccak256(bytes(input.adapterId)),
            manifestVersion: 1,
            manifestHash: input.adapterManifestHash
        });
        binding.mode = TypedStrategyAdapterRegistry.AdapterMode.FACTORY;
        binding.adapter = input.factory;
        binding.expectedCodeHash = input.factory.codehash;
        binding.adapterClassId = classId;
        binding.adapterClassVersion = classVersion;
        binding.template = TypedStrategyAdapterRegistry.TemplateRef({
            templateId: keccak256(bytes(input.templateId)),
            templateVersion: 1,
            templateManifestHash: input.templateManifestHash
        });
        binding.settlementClass =
            TypedStrategyAdapterRegistry.SettlementClassRef({classId: ATOMIC_POSTCONDITION_ID, classVersion: 1});
        binding.baseAsset = _asset(baseAsset);
        binding.quoteAsset = _asset(quoteAsset);
        binding.maximumGasLimit = 2_000_000;
    }

    function _asset(address token) private view returns (TypedStrategyAdapterRegistry.AssetBinding memory) {
        return TypedStrategyAdapterRegistry.AssetBinding({token: token, expectedCodeHash: token.codehash});
    }

    function _validate(Parameters calldata parameters) private view {
        if (
            block.chainid != parameters.expectedChainId || !TestnetChains.isAllowed(block.chainid)
                || address(parameters.config).code.length == 0 || address(parameters.registry).code.length == 0
                || parameters.adapters.length == 0 || parameters.adapters.length > 32
                || address(parameters.registry.config()) != address(parameters.config)
        ) revert InvalidChain();
        for (uint256 index; index < parameters.adapters.length; ++index) {
            AdapterInput calldata input = parameters.adapters[index];
            if (
                bytes(input.adapterId).length == 0 || input.adapterManifestHash == bytes32(0)
                    || input.factory.code.length == 0 || bytes(input.templateId).length == 0
                    || input.templateManifestHash == bytes32(0)
            ) revert InvalidConfiguration();
        }
    }

    function _requireOperator(ProtocolConfig config, address operatorAddress, bool proposer) private view {
        (address expectedProposer,, address expectedExecutor,) = config.roles();
        address expected = proposer ? expectedProposer : expectedExecutor;
        if (operatorAddress == address(0) || operatorAddress != expected) revert InvalidOperator();
    }
}

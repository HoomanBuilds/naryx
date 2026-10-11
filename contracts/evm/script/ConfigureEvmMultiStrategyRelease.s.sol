// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Script} from "forge-std/Script.sol";
import {IERC20} from "openzeppelin-contracts/token/ERC20/IERC20.sol";
import {ProtocolConfig} from "../src/ProtocolConfig.sol";
import {RiskDomainRegistry} from "../src/RiskDomainRegistry.sol";
import {StrategyFeePolicyRegistry} from "../src/StrategyFeePolicyRegistry.sol";
import {TypedStrategyAdapterRegistry} from "../src/TypedStrategyAdapterRegistry.sol";
import {ITypedStrategyAdapterFactory} from "../src/interfaces/ITypedStrategyAdapterFactory.sol";
import {TestnetChains} from "./TestnetChains.sol";

contract ConfigureEvmMultiStrategyRelease is Script {
    bytes32 public constant FEE_POLICY_SUBJECT_ID = keccak256("multi-strategy-fees");
    bytes32 private constant ATOMIC_POSTCONDITION_ID = keccak256("ATOMIC_POSTCONDITION");

    struct Parameters {
        ProtocolConfig config;
        TypedStrategyAdapterRegistry adapterRegistry;
        StrategyFeePolicyRegistry feePolicyRegistry;
        RiskDomainRegistry riskDomainRegistry;
        IERC20 baseAsset;
        IERC20 quoteAsset;
        address protocolRecipient;
        address lowerStrikeOptionFactory;
        address upperStrikeOptionFactory;
        address lendingFactory;
        address vaultFactory;
        address inventoryFactory;
        address perpetualFactory;
        address nearFutureFactory;
        address farFutureFactory;
    }

    struct ReleaseIds {
        bytes32 feePolicyManifestHash;
        bytes32 riskDomainId;
        bytes32 riskPolicyManifestHash;
    }

    error InvalidConfiguration();
    error InvalidOperator();

    function runPropose(Parameters calldata parameters, address operatorAddress)
        external
        returns (ReleaseIds memory ids)
    {
        _requireConfiguration(parameters);
        _requireOperator(parameters.config, operatorAddress, true);
        bytes32[] memory templates = _templates();
        RiskDomainRegistry.SeriesRef[] memory series = _series(templates);
        ids = _releaseIds(parameters, series);

        vm.startBroadcast(operatorAddress);
        parameters.feePolicyRegistry
            .proposePolicy(
                FEE_POLICY_SUBJECT_ID,
                StrategyFeePolicyRegistry.Policy({
                    version: 1,
                    manifestHash: ids.feePolicyManifestHash,
                    token: address(parameters.quoteAsset),
                    expectedTokenCodeHash: address(parameters.quoteAsset).codehash,
                    protocolRecipient: parameters.protocolRecipient,
                    maximumProtocolFeeBps: 50,
                    maximumSolverFeeBps: 100,
                    paused: false
                })
            );

        address[8] memory factories = _factories(parameters);
        bytes32[8] memory factoryTemplates = _factoryTemplates();
        for (uint256 index; index < factories.length; ++index) {
            parameters.adapterRegistry
                .proposeRegistration(
                    _adapterBinding(parameters, factories[index], factoryTemplates[index]),
                    TypedStrategyAdapterRegistry.AdapterControl({
                        state: TypedStrategyAdapterRegistry.Lifecycle.ACTIVE,
                        maximumApprovalAtoms: 1_000_000 ether,
                        maximumGrossNotionalAtoms: 10_000_000_000_000
                    })
                );
        }

        RiskDomainRegistry.DependencyLimit[] memory dependencies = new RiskDomainRegistry.DependencyLimit[](1);
        dependencies[0] = RiskDomainRegistry.DependencyLimit({
            dependencyId: _dependencyId(), maximumGrossQuoteAtoms: 5_000_000_000_000
        });
        (, uint32 domainVersion, bytes32 domainHash) = parameters.config.domain();
        parameters.riskDomainRegistry
            .proposePolicy(
                ids.riskDomainId,
                RiskDomainRegistry.PolicyConfig({
                    manifestVersion: 1,
                    manifestHash: ids.riskPolicyManifestHash,
                    domainManifestVersion: domainVersion,
                    domainManifestHash: domainHash,
                    accountingToken: address(parameters.quoteAsset),
                    expectedTokenCodeHash: address(parameters.quoteAsset).codehash,
                    grossCapQuoteAtoms: 5_000_000_000_000,
                    netCapQuoteAtoms: 5_000_000_000_000,
                    minimumMarginFloorQuoteAtoms: 1_000_000,
                    maximumLeverageBps: 100_000,
                    maximumStalenessMs: 300_000,
                    maximumTimeToUnwindMs: 3_600_000,
                    requiredRecoveryReserveQuoteAtoms: 1_000_000,
                    aggregateHaircutBps: 100
                }),
                series,
                dependencies
            );
        parameters.config.scheduleUnpause();
        vm.stopBroadcast();
    }

    function runActivate(Parameters calldata parameters, address operatorAddress)
        external
        returns (ReleaseIds memory ids)
    {
        _requireConfiguration(parameters);
        _requireOperator(parameters.config, operatorAddress, false);
        ids = _releaseIds(parameters, _series(_templates()));

        vm.startBroadcast(operatorAddress);
        parameters.feePolicyRegistry.activate(FEE_POLICY_SUBJECT_ID);
        address[8] memory factories = _factories(parameters);
        bytes32[8] memory factoryTemplates = _factoryTemplates();
        for (uint256 index; index < factories.length; ++index) {
            parameters.adapterRegistry
                .activateRegistration(_adapterSubjectId(factories[index], factoryTemplates[index]));
        }
        parameters.riskDomainRegistry.activate(ids.riskDomainId);
        parameters.config.activateUnpause();
        vm.stopBroadcast();
    }

    function _adapterBinding(Parameters calldata parameters, address factory, bytes32 templateId)
        private
        view
        returns (TypedStrategyAdapterRegistry.AdapterBinding memory binding)
    {
        (bytes32 adapterClassId, uint32 adapterClassVersion, address baseAsset, address quoteAsset) =
            ITypedStrategyAdapterFactory(factory).factoryMetadata();
        if (baseAsset != address(parameters.baseAsset) || quoteAsset.code.length == 0) {
            revert InvalidConfiguration();
        }
        (string memory domainId, uint32 domainVersion, bytes32 domainHash) = parameters.config.domain();
        bytes32 subjectId = _adapterSubjectId(factory, templateId);
        bytes32 templateManifestHash = _templateManifestHash(templateId);
        bytes32 adapterManifestHash = _adapterManifestHash(factory, subjectId, templateManifestHash);
        binding.domain = TypedStrategyAdapterRegistry.DomainRef({
            domainIdHash: keccak256(bytes(domainId)), manifestVersion: domainVersion, manifestHash: domainHash
        });
        binding.identity = TypedStrategyAdapterRegistry.ManifestRef({
            subjectId: subjectId, manifestVersion: 1, manifestHash: adapterManifestHash
        });
        binding.mode = TypedStrategyAdapterRegistry.AdapterMode.FACTORY;
        binding.adapter = factory;
        binding.expectedCodeHash = factory.codehash;
        binding.adapterClassId = adapterClassId;
        binding.adapterClassVersion = adapterClassVersion;
        binding.template = TypedStrategyAdapterRegistry.TemplateRef({
            templateId: templateId, templateVersion: 1, templateManifestHash: templateManifestHash
        });
        binding.settlementClass =
            TypedStrategyAdapterRegistry.SettlementClassRef({classId: ATOMIC_POSTCONDITION_ID, classVersion: 1});
        binding.baseAsset = _assetBinding(baseAsset);
        binding.quoteAsset = _assetBinding(quoteAsset);
        binding.maximumGasLimit = 2_000_000;
    }

    function _releaseIds(Parameters calldata parameters, RiskDomainRegistry.SeriesRef[] memory series)
        private
        view
        returns (ReleaseIds memory ids)
    {
        ids.feePolicyManifestHash = keccak256(
            abi.encode(
                "naryx-testnet-fee-policy-v1",
                block.chainid,
                address(parameters.quoteAsset),
                address(parameters.quoteAsset).codehash,
                parameters.protocolRecipient,
                uint16(50),
                uint16(100)
            )
        );
        ids.riskDomainId = keccak256(abi.encode("naryx-testnet-risk-domain-v1", block.chainid));
        ids.riskPolicyManifestHash = keccak256(
            abi.encode(
                "naryx-testnet-risk-policy-v1",
                ids.riskDomainId,
                address(parameters.quoteAsset),
                address(parameters.quoteAsset).codehash,
                series,
                _dependencyId()
            )
        );
    }

    function _series(bytes32[] memory templates) private view returns (RiskDomainRegistry.SeriesRef[] memory series) {
        series = new RiskDomainRegistry.SeriesRef[](templates.length);
        for (uint256 index; index < templates.length; ++index) {
            bytes32 templateId = templates[index];
            series[index] = RiskDomainRegistry.SeriesRef({
                seriesId: templateId,
                manifestVersion: 1,
                manifestHash: keccak256(abi.encode("naryx-testnet-series-v1", block.chainid, templateId))
            });
        }
        for (uint256 outer = 1; outer < series.length; ++outer) {
            RiskDomainRegistry.SeriesRef memory item = series[outer];
            bytes32 itemKey = _seriesKey(item);
            uint256 inner = outer;
            while (inner != 0 && _seriesKey(series[inner - 1]) > itemKey) {
                series[inner] = series[inner - 1];
                --inner;
            }
            series[inner] = item;
        }
    }

    function _templates() private pure returns (bytes32[] memory templates) {
        templates = new bytes32[](12);
        templates[0] = keccak256("cash-and-carry-v1");
        templates[1] = keccak256("reverse-cash-and-carry-v1");
        templates[2] = keccak256("perpetual-funding-spread-v1");
        templates[3] = keccak256("hedge-migration-v1");
        templates[4] = keccak256("delta-neutral-rebalance-v1");
        templates[5] = keccak256("treasury-inventory-hedge-v1");
        templates[6] = keccak256("calendar-spread-v1");
        templates[7] = keccak256("option-spread-v1");
        templates[8] = keccak256("collateral-conversion-hedge-v1");
        templates[9] = keccak256("fixed-rate-refinance-v1");
        templates[10] = keccak256("sol-structured-hedge-v1");
        templates[11] = keccak256("session-aware-tokenized-asset-v1");
    }

    function _factoryTemplates() private pure returns (bytes32[8] memory templates) {
        templates[0] = keccak256("option-spread-v1");
        templates[1] = keccak256("option-spread-v1");
        templates[2] = keccak256("fixed-rate-refinance-v1");
        templates[3] = keccak256("delta-neutral-rebalance-v1");
        templates[4] = keccak256("treasury-inventory-hedge-v1");
        templates[5] = keccak256("cash-and-carry-v1");
        templates[6] = keccak256("calendar-spread-v1");
        templates[7] = keccak256("calendar-spread-v1");
    }

    function _factories(Parameters calldata parameters) private pure returns (address[8] memory factories) {
        factories[0] = parameters.lowerStrikeOptionFactory;
        factories[1] = parameters.upperStrikeOptionFactory;
        factories[2] = parameters.lendingFactory;
        factories[3] = parameters.vaultFactory;
        factories[4] = parameters.inventoryFactory;
        factories[5] = parameters.perpetualFactory;
        factories[6] = parameters.nearFutureFactory;
        factories[7] = parameters.farFutureFactory;
    }

    function _adapterSubjectId(address factory, bytes32 templateId) private view returns (bytes32) {
        return keccak256(abi.encode("naryx-testnet-adapter-v1", block.chainid, factory, templateId));
    }

    function _templateManifestHash(bytes32 templateId) private view returns (bytes32) {
        return keccak256(abi.encode("naryx-testnet-template-v1", block.chainid, templateId));
    }

    function _adapterManifestHash(address factory, bytes32 subjectId, bytes32 templateManifestHash)
        private
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode("naryx-testnet-adapter-manifest-v1", subjectId, factory.codehash, templateManifestHash)
        );
    }

    function _assetBinding(address token)
        private
        view
        returns (TypedStrategyAdapterRegistry.AssetBinding memory binding)
    {
        binding.token = token;
        binding.expectedCodeHash = token.codehash;
    }

    function _dependencyId() private view returns (bytes32) {
        return keccak256(abi.encode("naryx-testnet-conformance-liquidity-v1", block.chainid));
    }

    function _seriesKey(RiskDomainRegistry.SeriesRef memory item) private pure returns (bytes32) {
        return keccak256(abi.encode(item.seriesId, item.manifestVersion, item.manifestHash));
    }

    function _requireConfiguration(Parameters calldata parameters) private view {
        if (
            !TestnetChains.isAllowed(block.chainid) || address(parameters.config).code.length == 0
                || address(parameters.adapterRegistry).code.length == 0
                || address(parameters.feePolicyRegistry).code.length == 0
                || address(parameters.riskDomainRegistry).code.length == 0
                || address(parameters.baseAsset).code.length == 0 || address(parameters.quoteAsset).code.length == 0
                || parameters.protocolRecipient == address(0)
                || address(parameters.adapterRegistry.config()) != address(parameters.config)
                || address(parameters.feePolicyRegistry.config()) != address(parameters.config)
                || address(parameters.riskDomainRegistry.config()) != address(parameters.config)
        ) revert InvalidConfiguration();
        address[8] memory factories = _factories(parameters);
        for (uint256 index; index < factories.length; ++index) {
            if (factories[index].code.length == 0) revert InvalidConfiguration();
        }
    }

    function _requireOperator(ProtocolConfig config, address operatorAddress, bool proposer) private view {
        (address proposerRole,, address executorRole,) = config.roles();
        if (operatorAddress == address(0) || operatorAddress != (proposer ? proposerRole : executorRole)) {
            revert InvalidOperator();
        }
    }
}

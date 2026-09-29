// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Script} from "forge-std/Script.sol";
import {CashCarrySeriesRegistry} from "../src/CashCarrySeriesRegistry.sol";
import {NaryxStrategyAccount} from "../src/NaryxStrategyAccount.sol";
import {PackageQuoteShard} from "../src/PackageQuoteShard.sol";
import {PackageQuoteShardRegistry} from "../src/PackageQuoteShardRegistry.sol";
import {PackageVerifier} from "../src/PackageVerifier.sol";
import {ProtocolConfig} from "../src/ProtocolConfig.sol";
import {ResourceRegistry} from "../src/ResourceRegistry.sol";
import {SolverRegistry} from "../src/SolverRegistry.sol";
import {UniswapV3SpotPort} from "../src/UniswapV3SpotPort.sol";
import {NaryxBaseSepoliaPerpTestSupport} from "../src/conformance/NaryxBaseSepoliaPerpTestSupport.sol";

contract ConfigureBaseSepoliaAtomicPackage is Script {
    uint256 public constant BASE_SEPOLIA_CHAIN_ID = 84532;
    bytes32 public constant DOMAIN_ID_HASH = keccak256("eip155:84532");

    struct Route {
        ProtocolConfig config;
        SolverRegistry solverRegistry;
        ResourceRegistry resources;
        CashCarrySeriesRegistry seriesRegistry;
        PackageQuoteShardRegistry quoteRegistry;
        PackageVerifier verifier;
        NaryxStrategyAccount strategyAccount;
        UniswapV3SpotPort spotPort;
        NaryxBaseSepoliaPerpTestSupport perpetualPort;
        PackageQuoteShard quoteShard;
        address solver;
        ResourceRegistry.ManifestRef baseAsset;
        ResourceRegistry.ManifestRef quoteAsset;
        ResourceRegistry.ManifestRef spotVenue;
        ResourceRegistry.ManifestRef perpetualVenue;
        ResourceRegistry.ManifestRef spotMarket;
        ResourceRegistry.ManifestRef perpetualMarket;
        ResourceRegistry.ManifestRef spotAdapter;
        ResourceRegistry.ManifestRef perpetualAdapter;
        bytes32 seriesManifestHash;
        bytes32 executionClassManifestHash;
        uint32 seriesBindingVersion;
        uint128 spotBaseAtomsPerPackageUnit;
        uint128 perpetualQuantityWadPerPackageUnit;
        uint32 quoteShardManifestVersion;
        bytes32 quoteShardManifestHash;
        uint256 maximumPackageNotionalQuoteAtoms;
        ResourceRegistry.MarketParameters spotMarketParameters;
        ResourceRegistry.MarketParameters perpetualMarketParameters;
    }

    error InvalidChain();
    error InvalidOperator();
    error InvalidRoute();

    function runProposeQuoteAsset(Route calldata route, address operatorAddress) external {
        _requireOperator(route.config, operatorAddress, true);
        _start(operatorAddress);
        _verifyDependencies(route);
        route.resources
            .proposeRegistration(
                _assetBinding(route, route.quoteAsset, address(route.spotPort.quoteToken()), 6), _control(route)
            );
        vm.stopBroadcast();
    }

    function runActivateQuoteAsset(Route calldata route, address operatorAddress) external {
        _requireOperator(route.config, operatorAddress, false);
        _start(operatorAddress);
        _verifyDependencies(route);
        route.resources.activateRegistration(ResourceRegistry.ResourceKind.ASSET, route.quoteAsset.subjectId);
        vm.stopBroadcast();
    }

    function runProposeFoundation(Route calldata route, address operatorAddress) external {
        _requireOperator(route.config, operatorAddress, true);
        _start(operatorAddress);
        _verifyDependencies(route);
        if (route.solverRegistry.activeSolver() != route.solver) route.solverRegistry.proposeSolver(route.solver);
        route.resources
            .proposeRegistration(
                _assetBinding(route, route.baseAsset, address(route.spotPort.baseToken()), 18), _control(route)
            );
        route.resources
            .proposeRegistration(_venueBinding(route, route.spotVenue, route.spotPort.factory()), _control(route));
        route.resources
            .proposeRegistration(
                _venueBinding(route, route.perpetualVenue, address(route.perpetualPort)), _control(route)
            );
        PackageQuoteShardRegistry.ShardIdentity memory identity = _shardIdentity(route);
        route.quoteRegistry
            .proposeRegistration(
                identity,
                route.quoteShardManifestVersion,
                route.quoteShardManifestHash,
                address(route.quoteShard),
                address(route.quoteShard).codehash,
                address(route.verifier),
                address(route.verifier).codehash
            );
        vm.stopBroadcast();
    }

    function runActivateFoundation(Route calldata route, address operatorAddress) external {
        _requireOperator(route.config, operatorAddress, false);
        _start(operatorAddress);
        _verifyDependencies(route);
        if (route.solverRegistry.activeSolver() != route.solver) route.solverRegistry.activateSolver();
        route.resources.activateRegistration(ResourceRegistry.ResourceKind.ASSET, route.baseAsset.subjectId);
        route.resources.activateRegistration(ResourceRegistry.ResourceKind.VENUE, route.spotVenue.subjectId);
        route.resources.activateRegistration(ResourceRegistry.ResourceKind.VENUE, route.perpetualVenue.subjectId);
        route.quoteRegistry.activateRegistration(route.quoteRegistry.identityKey(_shardIdentity(route)));
        vm.stopBroadcast();
    }

    function runProposeMarketsAndSeries(Route calldata route, address operatorAddress) external {
        _requireOperator(route.config, operatorAddress, true);
        _start(operatorAddress);
        _verifyDependencies(route);
        route.resources
            .proposeRegistration(
                _marketBinding(
                    route,
                    route.spotMarket,
                    route.spotPort.pool(),
                    ResourceRegistry.LegRole.SPOT,
                    route.spotVenue,
                    route.spotMarketParameters
                ),
                _control(route)
            );
        route.resources
            .proposeRegistration(
                _marketBinding(
                    route,
                    route.perpetualMarket,
                    address(route.perpetualPort),
                    ResourceRegistry.LegRole.PERPETUAL,
                    route.perpetualVenue,
                    route.perpetualMarketParameters
                ),
                _control(route)
            );
        CashCarrySeriesRegistry.CashCarrySeriesBindingV1 memory binding = _seriesBinding(route);
        route.seriesRegistry.proposeRegistration(binding, route.seriesRegistry.bindingHash(binding));
        vm.stopBroadcast();
    }

    function runActivateMarketsAndSeries(Route calldata route, address operatorAddress) external {
        _requireOperator(route.config, operatorAddress, false);
        _start(operatorAddress);
        _verifyDependencies(route);
        route.resources.activateRegistration(ResourceRegistry.ResourceKind.MARKET, route.spotMarket.subjectId);
        route.resources.activateRegistration(ResourceRegistry.ResourceKind.MARKET, route.perpetualMarket.subjectId);
        CashCarrySeriesRegistry.CashCarrySeriesBindingV1 memory binding = _seriesBinding(route);
        route.seriesRegistry.activateRegistration(route.seriesRegistry.identityKey(binding));
        vm.stopBroadcast();
    }

    function runProposeAdapters(Route calldata route, address operatorAddress) external {
        _requireOperator(route.config, operatorAddress, true);
        _start(operatorAddress);
        _verifyDependencies(route);
        route.resources
            .proposeRegistration(
                _adapterBinding(
                    route,
                    route.spotAdapter,
                    address(route.spotPort),
                    ResourceRegistry.LegRole.SPOT,
                    route.resources.BASE_SPOT_ADAPTER_CLASS(),
                    route.spotVenue,
                    route.spotMarket
                ),
                _control(route)
            );
        route.resources
            .proposeRegistration(
                _adapterBinding(
                    route,
                    route.perpetualAdapter,
                    address(route.perpetualPort),
                    ResourceRegistry.LegRole.PERPETUAL,
                    route.resources.BASE_PERP_PORT_CLASS(),
                    route.perpetualVenue,
                    route.perpetualMarket
                ),
                _control(route)
            );
        vm.stopBroadcast();
    }

    function runActivateAdapters(Route calldata route, address operatorAddress) external {
        _requireOperator(route.config, operatorAddress, false);
        _start(operatorAddress);
        _verifyDependencies(route);
        route.resources.activateRegistration(ResourceRegistry.ResourceKind.ADAPTER, route.spotAdapter.subjectId);
        route.resources.activateRegistration(ResourceRegistry.ResourceKind.ADAPTER, route.perpetualAdapter.subjectId);
        _verifyActiveRoute(route);
        vm.stopBroadcast();
    }

    function runScheduleUnpause(Route calldata route, address operatorAddress) external {
        _requireOperator(route.config, operatorAddress, true);
        _start(operatorAddress);
        _verifyDependencies(route);
        _verifyActiveRoute(route);
        route.config.scheduleUnpause();
        vm.stopBroadcast();
    }

    function runActivateEntry(Route calldata route, address operatorAddress) external {
        _requireOperator(route.config, operatorAddress, false);
        _start(operatorAddress);
        _verifyDependencies(route);
        _verifyActiveRoute(route);
        route.config.activateUnpause();
        vm.stopBroadcast();
    }

    function admission(Route calldata route, uint256 quoteAtoms)
        external
        view
        returns (ResourceRegistry.CashCarryAdmission memory)
    {
        return _admission(route, quoteAtoms);
    }

    function seriesReference(Route calldata route)
        external
        view
        returns (CashCarrySeriesRegistry.BindingReference memory exactReference)
    {
        CashCarrySeriesRegistry.CashCarrySeriesBindingV1 memory binding = _seriesBinding(route);
        exactReference = CashCarrySeriesRegistry.BindingReference({
            identityKey: route.seriesRegistry.identityKey(binding),
            bindingVersion: binding.bindingVersion,
            bindingHash: route.seriesRegistry.bindingHash(binding)
        });
    }

    function shardReference(Route calldata route)
        external
        view
        returns (PackageQuoteShardRegistry.ShardReference memory exactReference)
    {
        exactReference = PackageQuoteShardRegistry.ShardReference({
            identityKey: route.quoteRegistry.identityKey(_shardIdentity(route)),
            manifestVersion: route.quoteShardManifestVersion,
            manifestHash: route.quoteShardManifestHash,
            shard: address(route.quoteShard),
            shardCodeHash: address(route.quoteShard).codehash,
            consumer: address(route.verifier),
            consumerCodeHash: address(route.verifier).codehash
        });
    }

    function _start(address operatorAddress) private {
        vm.startBroadcast(operatorAddress);
    }

    function _requireOperator(ProtocolConfig config, address operatorAddress, bool proposerRole) private view {
        (address proposer,, address executor,) = config.roles();
        if (operatorAddress != (proposerRole ? proposer : executor)) revert InvalidOperator();
    }

    function _verifyDependencies(Route calldata route) private view {
        if (block.chainid != BASE_SEPOLIA_CHAIN_ID) revert InvalidChain();
        (string memory domainId,,) = route.config.domain();
        if (keccak256(bytes(domainId)) != DOMAIN_ID_HASH || !route.config.entryPaused()) revert InvalidRoute();
        if (
            address(route.solverRegistry.config()) != address(route.config)
                || address(route.resources.config()) != address(route.config)
                || address(route.seriesRegistry.config()) != address(route.config)
                || address(route.seriesRegistry.resources()) != address(route.resources)
                || address(route.quoteRegistry.config()) != address(route.config)
                || address(route.verifier.config()) != address(route.config)
                || address(route.verifier.solverRegistry()) != address(route.solverRegistry)
                || address(route.verifier.resourceRegistry()) != address(route.resources)
                || address(route.verifier.cashCarrySeriesRegistry()) != address(route.seriesRegistry)
                || address(route.verifier.packageQuoteShardRegistry()) != address(route.quoteRegistry)
                || address(route.strategyAccount.verifier()) != address(route.verifier)
                || route.spotPort.verifier() != address(route.verifier)
                || route.perpetualPort.strategyAccount() != address(route.strategyAccount)
                || route.quoteShard.config() != address(route.config) || route.quoteShard.solver() != route.solver
                || route.quoteShard.consumer() != address(route.verifier)
                || route.quoteShard.seriesManifestHash() != route.seriesManifestHash
                || route.quoteShard.executionClassManifestHash() != route.executionClassManifestHash
                || route.quoteShard.consumerCodeHash() != address(route.verifier).codehash
                || route.resources.cashCarryTemplateManifestHash()
                    != route.seriesRegistry.cashCarryTemplateManifestHash()
        ) revert InvalidRoute();
        route.spotPort.assertDeployment();
        route.quoteShard.assertDeployment();
        route.perpetualPort
            .getPosition(address(route.perpetualPort), route.perpetualPort.expiry(), address(route.strategyAccount));
    }

    function _verifyActiveRoute(Route calldata route) private view {
        if (route.solverRegistry.activeSolver() != route.solver) revert InvalidRoute();
        ResourceRegistry.CashCarryAdmission memory routeAdmission =
            _admission(route, route.maximumPackageNotionalQuoteAtoms);
        route.resources.validateCashCarry(routeAdmission);
        CashCarrySeriesRegistry.CashCarrySeriesBindingV1 memory binding = _seriesBinding(route);
        route.seriesRegistry
            .validateEntry(
                CashCarrySeriesRegistry.BindingReference({
                    identityKey: route.seriesRegistry.identityKey(binding),
                    bindingVersion: binding.bindingVersion,
                    bindingHash: route.seriesRegistry.bindingHash(binding)
                })
            );
        route.quoteRegistry
            .validateEntry(
                PackageQuoteShardRegistry.ShardReference({
                    identityKey: route.quoteRegistry.identityKey(_shardIdentity(route)),
                    manifestVersion: route.quoteShardManifestVersion,
                    manifestHash: route.quoteShardManifestHash,
                    shard: address(route.quoteShard),
                    shardCodeHash: address(route.quoteShard).codehash,
                    consumer: address(route.verifier),
                    consumerCodeHash: address(route.verifier).codehash
                })
            );
    }

    function _domain(Route calldata route) private view returns (ResourceRegistry.DomainRef memory domain) {
        (, uint32 version, bytes32 manifestHash) = route.config.domain();
        domain = ResourceRegistry.DomainRef({
            domainIdHash: DOMAIN_ID_HASH, manifestVersion: version, manifestHash: manifestHash
        });
    }

    function _control(Route calldata route) private pure returns (ResourceRegistry.ResourceControl memory control) {
        control = ResourceRegistry.ResourceControl({
            state: ResourceRegistry.Lifecycle.ACTIVE,
            quoteAsset: route.quoteAsset,
            quoteDecimals: 6,
            maximumPackageNotionalQuoteAtoms: route.maximumPackageNotionalQuoteAtoms
        });
    }

    function _assetBinding(
        Route calldata route,
        ResourceRegistry.ManifestRef memory identity,
        address asset,
        uint8 decimals
    ) private view returns (ResourceRegistry.ResourceBinding memory binding) {
        binding.kind = ResourceRegistry.ResourceKind.ASSET;
        binding.domain = _domain(route);
        binding.identity = identity;
        binding.localAddress = asset;
        binding.expectedCodeHash = asset.codehash;
        binding.decimals = decimals;
    }

    function _venueBinding(Route calldata route, ResourceRegistry.ManifestRef memory identity, address venue)
        private
        view
        returns (ResourceRegistry.ResourceBinding memory binding)
    {
        binding.kind = ResourceRegistry.ResourceKind.VENUE;
        binding.domain = _domain(route);
        binding.identity = identity;
        binding.localAddress = venue;
        binding.expectedCodeHash = venue.codehash;
    }

    function _marketBinding(
        Route calldata route,
        ResourceRegistry.ManifestRef memory identity,
        address market,
        ResourceRegistry.LegRole role,
        ResourceRegistry.ManifestRef memory venue,
        ResourceRegistry.MarketParameters memory parameters
    ) private view returns (ResourceRegistry.ResourceBinding memory binding) {
        binding.kind = ResourceRegistry.ResourceKind.MARKET;
        binding.domain = _domain(route);
        binding.identity = identity;
        binding.localAddress = market;
        binding.expectedCodeHash = market.codehash;
        binding.legRole = role;
        binding.venue = venue;
        binding.baseAsset = route.baseAsset;
        binding.quoteAsset = route.quoteAsset;
        binding.marketParameters = parameters;
    }

    function _adapterBinding(
        Route calldata route,
        ResourceRegistry.ManifestRef memory identity,
        address adapter,
        ResourceRegistry.LegRole role,
        bytes32 classId,
        ResourceRegistry.ManifestRef memory venue,
        ResourceRegistry.ManifestRef memory market
    ) private view returns (ResourceRegistry.ResourceBinding memory binding) {
        binding.kind = ResourceRegistry.ResourceKind.ADAPTER;
        binding.domain = _domain(route);
        binding.identity = identity;
        binding.localAddress = adapter;
        binding.expectedCodeHash = adapter.codehash;
        binding.legRole = role;
        binding.adapterClassId = classId;
        binding.adapterClassVersion = route.resources.ADAPTER_CLASS_VERSION();
        binding.venue = venue;
        binding.market = market;
        binding.baseAsset = route.baseAsset;
        binding.quoteAsset = route.quoteAsset;
        binding.allowedTemplate = ResourceRegistry.TemplateRef({
            templateId: route.resources.CASH_AND_CARRY_TEMPLATE_ID(),
            templateVersion: route.resources.CASH_AND_CARRY_TEMPLATE_VERSION(),
            templateManifestHash: route.resources.cashCarryTemplateManifestHash()
        });
        binding.settlementClass = ResourceRegistry.SettlementClassRef({
            classId: route.resources.ATOMIC_POSTCONDITION_ID(),
            classVersion: route.resources.ATOMIC_POSTCONDITION_VERSION()
        });
    }

    function _seriesBinding(Route calldata route)
        private
        view
        returns (CashCarrySeriesRegistry.CashCarrySeriesBindingV1 memory binding)
    {
        binding = CashCarrySeriesRegistry.CashCarrySeriesBindingV1({
            schemaVersion: route.seriesRegistry.SCHEMA_VERSION(),
            bindingVersion: route.seriesBindingVersion,
            domainRefIdentityHash: route.seriesRegistry.currentDomainRefIdentityHash(),
            seriesManifestHash: route.seriesManifestHash,
            executionClassManifestHash: route.executionClassManifestHash,
            templateIdentityHash: route.seriesRegistry.cashCarryTemplateIdentityHash(),
            templateVersion: route.seriesRegistry.TEMPLATE_VERSION(),
            templateManifestHash: route.resources.cashCarryTemplateManifestHash(),
            settlementClassIdentityHash: route.seriesRegistry.atomicPostconditionIdentityHash(),
            baseAsset: _seriesAsset(route.baseAsset),
            quoteAsset: _seriesAsset(route.quoteAsset),
            quoteConventionIdentityHash: route.seriesRegistry.annualizedNetYieldIdentityHash(),
            entrySide: route.seriesRegistry.ENTRY_SIDE_ASK(),
            spotBaseAtomsPerPackageUnit: route.spotBaseAtomsPerPackageUnit,
            perpQuantityAtomsPerPackageUnit: route.perpetualQuantityWadPerPackageUnit
        });
    }

    function _seriesAsset(ResourceRegistry.ManifestRef memory resource)
        private
        pure
        returns (CashCarrySeriesRegistry.SeriesManifestRef memory)
    {
        return CashCarrySeriesRegistry.SeriesManifestRef({
            subjectIdentity: resource.subjectId,
            manifestVersion: resource.manifestVersion,
            manifestHash: resource.manifestHash
        });
    }

    function _shardIdentity(Route calldata route)
        private
        pure
        returns (PackageQuoteShardRegistry.ShardIdentity memory)
    {
        return PackageQuoteShardRegistry.ShardIdentity({
            seriesManifestHash: route.seriesManifestHash,
            executionClassManifestHash: route.executionClassManifestHash,
            solver: route.solver
        });
    }

    function _admission(Route calldata route, uint256 quoteAtoms)
        private
        view
        returns (ResourceRegistry.CashCarryAdmission memory configured)
    {
        configured.domain = _domain(route);
        configured.template = ResourceRegistry.TemplateRef({
            templateId: route.resources.CASH_AND_CARRY_TEMPLATE_ID(),
            templateVersion: route.resources.CASH_AND_CARRY_TEMPLATE_VERSION(),
            templateManifestHash: route.resources.cashCarryTemplateManifestHash()
        });
        configured.settlementClass = ResourceRegistry.SettlementClassRef({
            classId: route.resources.ATOMIC_POSTCONDITION_ID(),
            classVersion: route.resources.ATOMIC_POSTCONDITION_VERSION()
        });
        configured.spot = ResourceRegistry.LegAdmission({
            adapter: _resourceRef(route.spotAdapter, address(route.spotPort)),
            adapterClassId: route.resources.BASE_SPOT_ADAPTER_CLASS(),
            adapterClassVersion: route.resources.ADAPTER_CLASS_VERSION(),
            market: _resourceRef(route.spotMarket, route.spotPort.pool()),
            venue: _resourceRef(route.spotVenue, route.spotPort.factory()),
            quantityAtoms: route.spotBaseAtomsPerPackageUnit,
            limitQuoteAtomsPerBaseLot: quoteAtoms
        });
        configured.perpetual = ResourceRegistry.LegAdmission({
            adapter: _resourceRef(route.perpetualAdapter, address(route.perpetualPort)),
            adapterClassId: route.resources.BASE_PERP_PORT_CLASS(),
            adapterClassVersion: route.resources.ADAPTER_CLASS_VERSION(),
            market: _resourceRef(route.perpetualMarket, address(route.perpetualPort)),
            venue: _resourceRef(route.perpetualVenue, address(route.perpetualPort)),
            quantityAtoms: route.perpetualQuantityWadPerPackageUnit,
            limitQuoteAtomsPerBaseLot: quoteAtoms
        });
        configured.baseAsset = _assetRef(route.baseAsset, address(route.spotPort.baseToken()), 18);
        configured.quoteAsset = _assetRef(route.quoteAsset, address(route.spotPort.quoteToken()), 6);
        configured.action = route.resources.ENTRY();
        configured.packageNotionalQuoteAtoms = quoteAtoms;
    }

    function _resourceRef(ResourceRegistry.ManifestRef memory manifest, address localAddress)
        private
        view
        returns (ResourceRegistry.ResourceRef memory)
    {
        return ResourceRegistry.ResourceRef({
            manifest: manifest, localAddress: localAddress, expectedCodeHash: localAddress.codehash
        });
    }

    function _assetRef(ResourceRegistry.ManifestRef memory manifest, address localAddress, uint8 decimals)
        private
        view
        returns (ResourceRegistry.AssetRef memory)
    {
        return ResourceRegistry.AssetRef({
            manifest: manifest, localAddress: localAddress, expectedCodeHash: localAddress.codehash, decimals: decimals
        });
    }
}

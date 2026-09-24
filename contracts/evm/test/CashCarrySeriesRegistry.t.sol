// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "openzeppelin-contracts/token/ERC20/ERC20.sol";
import {CashCarrySeriesRegistry} from "../src/CashCarrySeriesRegistry.sol";
import {ProtocolConfig} from "../src/ProtocolConfig.sol";
import {ResourceRegistry} from "../src/ResourceRegistry.sol";

contract SeriesRegistryAsset is ERC20 {
    uint8 private immutable _TOKEN_DECIMALS;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _TOKEN_DECIMALS = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _TOKEN_DECIMALS;
    }
}

contract CashCarrySeriesRegistryTest is Test {
    uint64 private constant DELAY = 10;
    uint256 private constant ASSET_LIMIT = 1_000_000_000_000;

    bytes32 private constant DOMAIN_MANIFEST_HASH = 0x1111111111111111111111111111111111111111111111111111111111111111;
    bytes32 private constant SERIES_MANIFEST_HASH = 0x2222222222222222222222222222222222222222222222222222222222222222;
    bytes32 private constant EXECUTION_CLASS_MANIFEST_HASH =
        0x3333333333333333333333333333333333333333333333333333333333333333;
    bytes32 private constant TEMPLATE_MANIFEST_HASH =
        0x4444444444444444444444444444444444444444444444444444444444444444;
    bytes32 private constant BASE_SUBJECT_ID = 0x5555555555555555555555555555555555555555555555555555555555555555;
    bytes32 private constant BASE_MANIFEST_HASH = 0x6666666666666666666666666666666666666666666666666666666666666666;
    bytes32 private constant QUOTE_SUBJECT_ID = 0x7777777777777777777777777777777777777777777777777777777777777777;
    bytes32 private constant QUOTE_MANIFEST_HASH = 0x8888888888888888888888888888888888888888888888888888888888888888;

    bytes32 private constant EXPECTED_DOMAIN_IDENTITY =
        0x5c3367ef36475ec11ad5b392fc85a349b37d2fdad631c8da833aa0796897c14c;
    bytes32 private constant EXPECTED_TEMPLATE_IDENTITY =
        0xf124d7a5a2309c590f307ea911f59dc36c0dfc4203d081ac2fc05d0ee0a8206e;
    bytes32 private constant EXPECTED_QUOTE_CONVENTION_IDENTITY =
        0x94f75da5f71975ba08a0bf694c183715be548bdce998210ac5924669c9c701a5;
    bytes32 private constant EXPECTED_SETTLEMENT_IDENTITY =
        0xd859a5e58ad327a34dc770b146a6120cda0a194dd25734f9fec462a18e11e596;
    bytes32 private constant EXPECTED_IDENTITY_KEY = 0xf3d7bc7a8c6cb3ac5a0b3ca45dfdd333143cb8af576749057e34cb6383840a5d;
    bytes32 private constant EXPECTED_BINDING_HASH = 0xe13ea9e6a47163a913f5caacd460b6ab8bc63e9c91ee46610efd30838870711b;

    address private constant PROPOSER = address(0x101);
    address private constant CANCELLER = address(0x102);
    address private constant GOVERNANCE_EXECUTOR = address(0x103);
    address private constant PAUSER = address(0x104);

    ProtocolConfig private config;
    ResourceRegistry private resources;
    CashCarrySeriesRegistry private registry;
    SeriesRegistryAsset private baseToken;
    SeriesRegistryAsset private quoteToken;

    ResourceRegistry.DomainRef private resourceDomain;
    ResourceRegistry.ManifestRef private baseResourceRef;
    ResourceRegistry.ManifestRef private quoteResourceRef;

    function setUp() public {
        vm.warp(100);
        config = new ProtocolConfig(
            "eip155:8453", 7, DOMAIN_MANIFEST_HASH, DELAY, PROPOSER, CANCELLER, GOVERNANCE_EXECUTOR, PAUSER
        );
        resources = new ResourceRegistry(config, TEMPLATE_MANIFEST_HASH);
        baseToken = new SeriesRegistryAsset("Base", "BASE", 9);
        quoteToken = new SeriesRegistryAsset("Quote", "QUOTE", 6);

        resourceDomain = ResourceRegistry.DomainRef({
            domainIdHash: keccak256(bytes("eip155:8453")), manifestVersion: 7, manifestHash: DOMAIN_MANIFEST_HASH
        });
        baseResourceRef = ResourceRegistry.ManifestRef({
            subjectId: BASE_SUBJECT_ID, manifestVersion: 3, manifestHash: BASE_MANIFEST_HASH
        });
        quoteResourceRef = ResourceRegistry.ManifestRef({
            subjectId: QUOTE_SUBJECT_ID, manifestVersion: 4, manifestHash: QUOTE_MANIFEST_HASH
        });

        _registerAsset(quoteResourceRef, address(quoteToken), 6);
        _registerAsset(baseResourceRef, address(baseToken), 9);
        registry = new CashCarrySeriesRegistry(config, resources);
    }

    function testGoldenHashDelayedActivationAndAssetVersionRotation() public {
        CashCarrySeriesRegistry.CashCarrySeriesBindingV1 memory binding = _binding();
        assertEq(registry.currentDomainRefIdentityHash(), EXPECTED_DOMAIN_IDENTITY);
        assertEq(registry.cashCarryTemplateIdentityHash(), EXPECTED_TEMPLATE_IDENTITY);
        assertEq(registry.annualizedNetYieldIdentityHash(), EXPECTED_QUOTE_CONVENTION_IDENTITY);
        assertEq(registry.atomicPostconditionIdentityHash(), EXPECTED_SETTLEMENT_IDENTITY);
        assertEq(registry.identityKey(binding), EXPECTED_IDENTITY_KEY);
        assertEq(registry.bindingHash(binding), EXPECTED_BINDING_HASH);

        uint64 readyAt = _propose(binding);
        vm.prank(GOVERNANCE_EXECUTOR);
        vm.expectRevert(abi.encodeWithSelector(CashCarrySeriesRegistry.RegistrationProposalNotReady.selector, readyAt));
        registry.activateRegistration(EXPECTED_IDENTITY_KEY);

        vm.warp(readyAt);
        vm.prank(GOVERNANCE_EXECUTOR);
        registry.activateRegistration(EXPECTED_IDENTITY_KEY);
        CashCarrySeriesRegistry.BindingReference memory exactRef = CashCarrySeriesRegistry.BindingReference({
            identityKey: EXPECTED_IDENTITY_KEY, bindingVersion: 9, bindingHash: EXPECTED_BINDING_HASH
        });
        assertEq(registry.validateEntry(exactRef).bindingVersion, 9);

        ResourceRegistry.ManifestRef memory nextBaseRef = ResourceRegistry.ManifestRef({
            subjectId: BASE_SUBJECT_ID, manifestVersion: 4, manifestHash: keccak256("base-manifest-4")
        });
        _registerAsset(nextBaseRef, address(baseToken), 9);
        binding.bindingVersion = 10;
        binding.baseAsset.manifestVersion = nextBaseRef.manifestVersion;
        binding.baseAsset.manifestHash = nextBaseRef.manifestHash;
        bytes32 nextHash = registry.bindingHash(binding);
        readyAt = _propose(binding);
        vm.warp(readyAt);
        vm.prank(GOVERNANCE_EXECUTOR);
        registry.activateRegistration(EXPECTED_IDENTITY_KEY);

        vm.expectRevert(
            abi.encodeWithSelector(CashCarrySeriesRegistry.BindingReferenceMismatch.selector, EXPECTED_IDENTITY_KEY)
        );
        registry.validateEntry(exactRef);
        exactRef.bindingVersion = 10;
        exactRef.bindingHash = nextHash;
        assertEq(registry.validateEntry(exactRef).baseAsset.manifestVersion, 4);
        (,,, bool firstCurrent) = registry.bindingRecord(EXPECTED_IDENTITY_KEY, 9);
        (,,, bool secondCurrent) = registry.bindingRecord(EXPECTED_IDENTITY_KEY, 10);
        assertFalse(firstCurrent);
        assertTrue(secondCurrent);
    }

    function testDomainManifestRotationLeavesRegistryOperableAndRejectsOldEntry() public {
        CashCarrySeriesRegistry.CashCarrySeriesBindingV1 memory binding = _binding();
        uint64 readyAt = _propose(binding);
        vm.warp(readyAt);
        vm.prank(GOVERNANCE_EXECUTOR);
        registry.activateRegistration(EXPECTED_IDENTITY_KEY);

        bytes32 nextDomainHash = keccak256("domain-manifest-8");
        vm.prank(PROPOSER);
        config.proposeDomain(8, nextDomainHash);
        vm.warp(block.timestamp + DELAY);
        vm.prank(GOVERNANCE_EXECUTOR);
        config.activateDomain();

        (CashCarrySeriesRegistry.CashCarrySeriesBindingV1 memory historical,,) =
            registry.activeBinding(EXPECTED_IDENTITY_KEY);
        assertEq(historical.bindingVersion, 9);
        CashCarrySeriesRegistry.BindingReference memory exactRef = CashCarrySeriesRegistry.BindingReference({
            identityKey: EXPECTED_IDENTITY_KEY, bindingVersion: 9, bindingHash: EXPECTED_BINDING_HASH
        });
        vm.expectRevert(CashCarrySeriesRegistry.InvalidBinding.selector);
        registry.validateEntry(exactRef);
        assertTrue(registry.currentDomainRefIdentityHash() != EXPECTED_DOMAIN_IDENTITY);
    }

    function testWrongHashEarlyActivationAndCancellationFailClosed() public {
        CashCarrySeriesRegistry.CashCarrySeriesBindingV1 memory binding = _binding();
        vm.prank(PROPOSER);
        vm.expectRevert(
            abi.encodeWithSelector(
                CashCarrySeriesRegistry.BindingHashMismatch.selector, bytes32(uint256(1)), EXPECTED_BINDING_HASH
            )
        );
        registry.proposeRegistration(binding, bytes32(uint256(1)));

        uint64 readyAt = _propose(binding);
        vm.warp(readyAt - 1);
        vm.prank(GOVERNANCE_EXECUTOR);
        vm.expectRevert(abi.encodeWithSelector(CashCarrySeriesRegistry.RegistrationProposalNotReady.selector, readyAt));
        registry.activateRegistration(EXPECTED_IDENTITY_KEY);

        vm.prank(CANCELLER);
        registry.cancelRegistration(EXPECTED_IDENTITY_KEY);
        assertFalse(registry.pendingRegistration(EXPECTED_IDENTITY_KEY).exists);
    }

    function testEconomicMutationUnderSameSeriesAndExecutionIdentityFails() public {
        CashCarrySeriesRegistry.CashCarrySeriesBindingV1 memory binding = _binding();
        uint64 readyAt = _propose(binding);
        vm.warp(readyAt);
        vm.prank(GOVERNANCE_EXECUTOR);
        registry.activateRegistration(EXPECTED_IDENTITY_KEY);

        binding.bindingVersion = 10;
        binding.spotBaseAtomsPerPackageUnit += 1;
        bytes32 mutatedHash = registry.bindingHash(binding);
        vm.prank(PROPOSER);
        vm.expectRevert(
            abi.encodeWithSelector(CashCarrySeriesRegistry.EconomicSemanticsChanged.selector, EXPECTED_IDENTITY_KEY)
        );
        registry.proposeRegistration(binding, mutatedHash);
    }

    function testPauseDelayedReactivationAndTerminalDeprecation() public {
        CashCarrySeriesRegistry.CashCarrySeriesBindingV1 memory binding = _binding();
        uint64 readyAt = _propose(binding);
        vm.warp(readyAt);
        vm.prank(GOVERNANCE_EXECUTOR);
        registry.activateRegistration(EXPECTED_IDENTITY_KEY);
        CashCarrySeriesRegistry.BindingReference memory exactRef = CashCarrySeriesRegistry.BindingReference({
            identityKey: EXPECTED_IDENTITY_KEY, bindingVersion: 9, bindingHash: EXPECTED_BINDING_HASH
        });

        vm.prank(PAUSER);
        registry.tightenLifecycle(EXPECTED_IDENTITY_KEY, CashCarrySeriesRegistry.Lifecycle.ENTRY_PAUSED);
        vm.expectRevert(
            abi.encodeWithSelector(
                CashCarrySeriesRegistry.EntryNotAllowed.selector,
                EXPECTED_IDENTITY_KEY,
                CashCarrySeriesRegistry.Lifecycle.ENTRY_PAUSED
            )
        );
        registry.validateEntry(exactRef);

        vm.prank(PROPOSER);
        registry.proposeReactivation(EXPECTED_IDENTITY_KEY);
        readyAt = uint64(block.timestamp) + DELAY;
        vm.prank(PAUSER);
        vm.expectRevert(CashCarrySeriesRegistry.UnsafeImmediateLifecycleChange.selector);
        registry.tightenLifecycle(EXPECTED_IDENTITY_KEY, CashCarrySeriesRegistry.Lifecycle.ENTRY_PAUSED);
        assertTrue(registry.pendingReactivation(EXPECTED_IDENTITY_KEY).exists);
        vm.warp(readyAt - 1);
        vm.prank(GOVERNANCE_EXECUTOR);
        vm.expectRevert(abi.encodeWithSelector(CashCarrySeriesRegistry.ReactivationProposalNotReady.selector, readyAt));
        registry.activateReactivation(EXPECTED_IDENTITY_KEY);

        vm.prank(PAUSER);
        registry.tightenLifecycle(EXPECTED_IDENTITY_KEY, CashCarrySeriesRegistry.Lifecycle.ALL_PAUSED);
        assertFalse(registry.pendingReactivation(EXPECTED_IDENTITY_KEY).exists);
        vm.prank(PROPOSER);
        registry.proposeReactivation(EXPECTED_IDENTITY_KEY);
        readyAt = uint64(block.timestamp) + DELAY;
        vm.warp(readyAt);
        vm.prank(GOVERNANCE_EXECUTOR);
        registry.activateReactivation(EXPECTED_IDENTITY_KEY);
        assertEq(registry.validateEntry(exactRef).bindingVersion, 9);

        vm.prank(PAUSER);
        registry.tightenLifecycle(EXPECTED_IDENTITY_KEY, CashCarrySeriesRegistry.Lifecycle.DEPRECATED);
        vm.prank(PROPOSER);
        vm.expectRevert(CashCarrySeriesRegistry.InvalidReactivation.selector);
        registry.proposeReactivation(EXPECTED_IDENTITY_KEY);

        binding.bindingVersion = 10;
        bytes32 nextHash = registry.bindingHash(binding);
        vm.prank(PROPOSER);
        vm.expectRevert(
            abi.encodeWithSelector(CashCarrySeriesRegistry.SeriesDeprecated.selector, EXPECTED_IDENTITY_KEY)
        );
        registry.proposeRegistration(binding, nextHash);
    }

    function testZeroUnitAndInactiveAssetFailClosed() public {
        CashCarrySeriesRegistry.CashCarrySeriesBindingV1 memory binding = _binding();
        binding.spotBaseAtomsPerPackageUnit = 0;
        bytes32 zeroUnitHash = registry.bindingHash(binding);
        vm.prank(PROPOSER);
        vm.expectRevert(CashCarrySeriesRegistry.InvalidBinding.selector);
        registry.proposeRegistration(binding, zeroUnitHash);

        binding = _binding();
        vm.prank(PAUSER);
        resources.tightenControl(
            ResourceRegistry.ResourceKind.ASSET, BASE_SUBJECT_ID, ResourceRegistry.Lifecycle.ENTRY_PAUSED, ASSET_LIMIT
        );
        vm.prank(PROPOSER);
        vm.expectRevert(
            abi.encodeWithSelector(
                CashCarrySeriesRegistry.AssetNotActive.selector,
                BASE_SUBJECT_ID,
                ResourceRegistry.Lifecycle.ENTRY_PAUSED
            )
        );
        registry.proposeRegistration(binding, EXPECTED_BINDING_HASH);
    }

    function _binding() private view returns (CashCarrySeriesRegistry.CashCarrySeriesBindingV1 memory) {
        return CashCarrySeriesRegistry.CashCarrySeriesBindingV1({
            schemaVersion: 1,
            bindingVersion: 9,
            domainRefIdentityHash: registry.currentDomainRefIdentityHash(),
            seriesManifestHash: SERIES_MANIFEST_HASH,
            executionClassManifestHash: EXECUTION_CLASS_MANIFEST_HASH,
            templateIdentityHash: registry.cashCarryTemplateIdentityHash(),
            templateVersion: 1,
            templateManifestHash: TEMPLATE_MANIFEST_HASH,
            settlementClassIdentityHash: registry.atomicPostconditionIdentityHash(),
            baseAsset: CashCarrySeriesRegistry.SeriesManifestRef({
                subjectIdentity: BASE_SUBJECT_ID,
                manifestVersion: baseResourceRef.manifestVersion,
                manifestHash: baseResourceRef.manifestHash
            }),
            quoteAsset: CashCarrySeriesRegistry.SeriesManifestRef({
                subjectIdentity: QUOTE_SUBJECT_ID,
                manifestVersion: quoteResourceRef.manifestVersion,
                manifestHash: quoteResourceRef.manifestHash
            }),
            quoteConventionIdentityHash: registry.annualizedNetYieldIdentityHash(),
            entrySide: 1,
            spotBaseAtomsPerPackageUnit: 1_000_000_000,
            perpQuantityAtomsPerPackageUnit: 1_000_000
        });
    }

    function _propose(CashCarrySeriesRegistry.CashCarrySeriesBindingV1 memory binding)
        private
        returns (uint64 readyAt)
    {
        bytes32 expectedHash = registry.bindingHash(binding);
        vm.prank(PROPOSER);
        registry.proposeRegistration(binding, expectedHash);
        return uint64(block.timestamp) + DELAY;
    }

    function _registerAsset(ResourceRegistry.ManifestRef memory identity, address token, uint8 decimals_) private {
        ResourceRegistry.ResourceBinding memory binding;
        binding.kind = ResourceRegistry.ResourceKind.ASSET;
        binding.domain = resourceDomain;
        binding.identity = identity;
        binding.localAddress = token;
        binding.expectedCodeHash = token.codehash;
        binding.decimals = decimals_;
        binding.legRole = ResourceRegistry.LegRole.NONE;

        ResourceRegistry.ResourceControl memory control = ResourceRegistry.ResourceControl({
            state: ResourceRegistry.Lifecycle.ACTIVE,
            quoteAsset: identity.subjectId == QUOTE_SUBJECT_ID ? identity : quoteResourceRef,
            quoteDecimals: 6,
            maximumPackageNotionalQuoteAtoms: ASSET_LIMIT
        });
        vm.prank(PROPOSER);
        resources.proposeRegistration(binding, control);
        vm.warp(block.timestamp + DELAY);
        vm.prank(GOVERNANCE_EXECUTOR);
        resources.activateRegistration(ResourceRegistry.ResourceKind.ASSET, identity.subjectId);

        if (identity.subjectId == BASE_SUBJECT_ID) baseResourceRef = identity;
        if (identity.subjectId == QUOTE_SUBJECT_ID) quoteResourceRef = identity;
    }
}

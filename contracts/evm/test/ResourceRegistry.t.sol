// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "openzeppelin-contracts/token/ERC20/ERC20.sol";
import {ProtocolConfig} from "../src/ProtocolConfig.sol";
import {ResourceRegistry} from "../src/ResourceRegistry.sol";

contract RegistryTarget {}

contract RegistryAsset is ERC20 {
    uint8 private immutable _TOKEN_DECIMALS;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _TOKEN_DECIMALS = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _TOKEN_DECIMALS;
    }
}

contract ResourceRegistryTest is Test {
    uint64 private constant DELAY = 10;
    uint256 private constant DEFAULT_LIMIT = 1_000_000_000;
    uint256 private constant PERP_ADAPTER_LIMIT = 600_000_000;

    bytes32 private constant DOMAIN_MANIFEST_HASH = keccak256("domain-manifest-1");
    bytes32 private constant TEMPLATE_MANIFEST_HASH = keccak256("cash-carry-template-manifest-1");
    bytes32 private constant QUOTE_ID = keccak256("usdc");
    bytes32 private constant BASE_ID = keccak256("wrapped-base");
    bytes32 private constant SPOT_VENUE_ID = keccak256("spot-venue");
    bytes32 private constant PERP_VENUE_ID = keccak256("perp-venue");
    bytes32 private constant SPOT_MARKET_ID = keccak256("spot-market");
    bytes32 private constant PERP_MARKET_ID = keccak256("perp-market");
    bytes32 private constant SPOT_ADAPTER_ID = keccak256("spot-adapter");
    bytes32 private constant PERP_ADAPTER_ID = keccak256("perp-port");

    address private constant PROPOSER = address(0x101);
    address private constant CANCELLER = address(0x102);
    address private constant GOVERNANCE_EXECUTOR = address(0x103);
    address private constant PAUSER = address(0x104);
    address private constant OUTSIDER = address(0x105);

    ProtocolConfig private config;
    ResourceRegistry private registry;
    RegistryAsset private baseAsset;
    RegistryAsset private quoteAsset;
    RegistryTarget private spotVenue;
    RegistryTarget private perpVenue;
    RegistryTarget private spotMarket;
    RegistryTarget private perpMarket;
    RegistryTarget private spotAdapter;
    RegistryTarget private perpPort;

    ResourceRegistry.DomainRef private domain;
    ResourceRegistry.TemplateRef private template;
    ResourceRegistry.SettlementClassRef private settlementClass;
    ResourceRegistry.ManifestRef private quoteRef;
    ResourceRegistry.ManifestRef private baseRef;
    ResourceRegistry.ManifestRef private spotVenueRef;
    ResourceRegistry.ManifestRef private perpVenueRef;
    ResourceRegistry.ManifestRef private spotMarketRef;
    ResourceRegistry.ManifestRef private perpMarketRef;
    ResourceRegistry.ManifestRef private spotAdapterRef;
    ResourceRegistry.ManifestRef private perpAdapterRef;

    function setUp() public {
        vm.warp(100);
        config = new ProtocolConfig(
            "eip155:84532", 1, DOMAIN_MANIFEST_HASH, DELAY, PROPOSER, CANCELLER, GOVERNANCE_EXECUTOR, PAUSER
        );
        registry = new ResourceRegistry(config);
        _activateTemplate(TEMPLATE_MANIFEST_HASH);

        baseAsset = new RegistryAsset("Base", "BASE", 18);
        quoteAsset = new RegistryAsset("Quote", "QUOTE", 6);
        spotVenue = new RegistryTarget();
        perpVenue = new RegistryTarget();
        spotMarket = new RegistryTarget();
        perpMarket = new RegistryTarget();
        spotAdapter = new RegistryTarget();
        perpPort = new RegistryTarget();

        domain = ResourceRegistry.DomainRef({
            domainIdHash: keccak256("eip155:84532"), manifestVersion: 1, manifestHash: DOMAIN_MANIFEST_HASH
        });
        template = ResourceRegistry.TemplateRef({
            templateId: registry.CASH_AND_CARRY_TEMPLATE_ID(),
            templateVersion: registry.CASH_AND_CARRY_TEMPLATE_VERSION(),
            templateManifestHash: TEMPLATE_MANIFEST_HASH
        });
        settlementClass = ResourceRegistry.SettlementClassRef({
            classId: registry.ATOMIC_POSTCONDITION_ID(), classVersion: registry.ATOMIC_POSTCONDITION_VERSION()
        });

        quoteRef = _manifestRef(QUOTE_ID, 1, keccak256("quote-manifest-1"));
        baseRef = _manifestRef(BASE_ID, 1, keccak256("base-manifest-1"));
        spotVenueRef = _manifestRef(SPOT_VENUE_ID, 1, keccak256("spot-venue-manifest-1"));
        perpVenueRef = _manifestRef(PERP_VENUE_ID, 1, keccak256("perp-venue-manifest-1"));
        spotMarketRef = _manifestRef(SPOT_MARKET_ID, 1, keccak256("spot-market-manifest-1"));
        perpMarketRef = _manifestRef(PERP_MARKET_ID, 1, keccak256("perp-market-manifest-1"));
        spotAdapterRef = _manifestRef(SPOT_ADAPTER_ID, 1, keccak256("spot-adapter-manifest-1"));
        perpAdapterRef = _manifestRef(PERP_ADAPTER_ID, 1, keccak256("perp-adapter-manifest-1"));

        _register(_assetManifest(quoteRef, address(quoteAsset), 6), _control(quoteRef, DEFAULT_LIMIT));
        _register(_assetManifest(baseRef, address(baseAsset), 18), _control(quoteRef, DEFAULT_LIMIT));
        _register(_venueManifest(spotVenueRef, address(spotVenue)), _control(quoteRef, DEFAULT_LIMIT));
        _register(_venueManifest(perpVenueRef, address(perpVenue)), _control(quoteRef, DEFAULT_LIMIT));
        _register(
            _marketManifest(
                spotMarketRef, address(spotMarket), ResourceRegistry.LegRole.SPOT, spotVenueRef, baseRef, quoteRef
            ),
            _control(quoteRef, DEFAULT_LIMIT)
        );
        _register(
            _marketManifest(
                perpMarketRef, address(perpMarket), ResourceRegistry.LegRole.PERPETUAL, perpVenueRef, baseRef, quoteRef
            ),
            _control(quoteRef, DEFAULT_LIMIT)
        );
        _register(
            _adapterManifest(
                spotAdapterRef,
                address(spotAdapter),
                ResourceRegistry.LegRole.SPOT,
                registry.BASE_SPOT_ADAPTER_CLASS(),
                spotVenueRef,
                spotMarketRef
            ),
            _control(quoteRef, DEFAULT_LIMIT)
        );
        _register(
            _adapterManifest(
                perpAdapterRef,
                address(perpPort),
                ResourceRegistry.LegRole.PERPETUAL,
                registry.BASE_PERP_PORT_CLASS(),
                perpVenueRef,
                perpMarketRef
            ),
            _control(quoteRef, PERP_ADAPTER_LIMIT)
        );
    }

    function testRegistrationIsRoleGatedDelayedVersionedAndImmutable() public {
        ResourceRegistry.ManifestRef memory nextRef =
            _manifestRef(SPOT_ADAPTER_ID, 2, keccak256("spot-adapter-manifest-2"));
        ResourceRegistry.ResourceBinding memory next = _adapterManifest(
            nextRef,
            address(spotAdapter),
            ResourceRegistry.LegRole.SPOT,
            registry.BASE_SPOT_ADAPTER_CLASS(),
            spotVenueRef,
            spotMarketRef
        );

        vm.prank(OUTSIDER);
        vm.expectRevert(abi.encodeWithSelector(ResourceRegistry.UnauthorizedRole.selector, OUTSIDER, PROPOSER));
        registry.proposeRegistration(next, _control(quoteRef, DEFAULT_LIMIT));

        uint64 readyAt = uint64(block.timestamp) + DELAY;
        vm.prank(PROPOSER);
        registry.proposeRegistration(next, _control(quoteRef, DEFAULT_LIMIT));
        vm.warp(readyAt - 1);
        vm.prank(GOVERNANCE_EXECUTOR);
        vm.expectRevert(abi.encodeWithSelector(ResourceRegistry.RegistrationProposalNotReady.selector, readyAt));
        registry.activateRegistration(ResourceRegistry.ResourceKind.ADAPTER, SPOT_ADAPTER_ID);

        vm.warp(readyAt);
        vm.prank(GOVERNANCE_EXECUTOR);
        registry.activateRegistration(ResourceRegistry.ResourceKind.ADAPTER, SPOT_ADAPTER_ID);

        (ResourceRegistry.ResourceBinding memory active,) =
            registry.activeResource(ResourceRegistry.ResourceKind.ADAPTER, SPOT_ADAPTER_ID);
        assertEq(active.identity.manifestVersion, 2);
        assertEq(registry.bindingHash(active), keccak256(abi.encode(active)));
        (ResourceRegistry.ResourceBinding memory original,) =
            registry.resource(ResourceRegistry.ResourceKind.ADAPTER, spotAdapterRef);
        assertEq(original.identity.manifestHash, spotAdapterRef.manifestHash);

        vm.prank(PROPOSER);
        vm.expectRevert(
            abi.encodeWithSelector(ResourceRegistry.ManifestVersionNotIncreasing.selector, uint32(2), uint32(2))
        );
        registry.proposeRegistration(next, _control(quoteRef, DEFAULT_LIMIT));

        next.identity = _manifestRef(SPOT_ADAPTER_ID, 3, keccak256("spot-adapter-manifest-3"));
        vm.warp(type(uint64).max);
        vm.prank(PROPOSER);
        vm.expectRevert(ResourceRegistry.ActivationTimestampOverflow.selector);
        registry.proposeRegistration(next, _control(quoteRef, DEFAULT_LIMIT));
    }

    function testAdmissionValidatesBothTypedLegsAndQuoteAtomCap() public {
        ResourceRegistry.CashCarryAdmission memory admission = _admission(600_000_000, registry.ENTRY());
        assertEq(registry.validateCashCarry(admission), PERP_ADAPTER_LIMIT);

        admission.packageNotionalQuoteAtoms = PERP_ADAPTER_LIMIT + 1;
        admission.spot.limitQuoteAtomsPerBaseLot = PERP_ADAPTER_LIMIT + 1;
        admission.perpetual.limitQuoteAtomsPerBaseLot = PERP_ADAPTER_LIMIT + 1;
        vm.expectRevert(
            abi.encodeWithSelector(
                ResourceRegistry.PackageNotionalExceeded.selector, PERP_ADAPTER_LIMIT, PERP_ADAPTER_LIMIT + 1
            )
        );
        registry.validateCashCarry(admission);

        admission = _admission(1, registry.ENTRY());
        admission.perpetual.adapterClassId = registry.BASE_SPOT_ADAPTER_CLASS();
        vm.expectRevert(ResourceRegistry.InvalidAdmission.selector);
        registry.validateCashCarry(admission);

        admission = _admission(1, registry.ENTRY());
        admission.template.templateManifestHash = keccak256("different-template");
        vm.expectRevert(ResourceRegistry.InvalidAdmission.selector);
        registry.validateCashCarry(admission);

        admission = _admission(1, registry.ENTRY());
        admission.perpetual.adapter = admission.spot.adapter;
        vm.expectRevert(ResourceRegistry.InvalidAdmission.selector);
        registry.validateCashCarry(admission);
    }

    function testAddressCodeDecimalsDomainAndUnknownReferencesFailClosed() public {
        ResourceRegistry.CashCarryAdmission memory admission = _admission(1, registry.ENTRY());
        admission.domain.manifestHash = keccak256("wrong-domain");
        vm.expectRevert(ResourceRegistry.DomainMismatch.selector);
        registry.validateCashCarry(admission);

        admission = _admission(1, registry.ENTRY());
        admission.baseAsset.decimals = 17;
        vm.expectRevert(
            abi.encodeWithSelector(
                ResourceRegistry.ResourceMismatch.selector, ResourceRegistry.ResourceKind.ASSET, BASE_ID
            )
        );
        registry.validateCashCarry(admission);

        admission = _admission(1, registry.ENTRY());
        admission.spot.market.manifest.subjectId = keccak256("unknown-market");
        vm.expectRevert(
            abi.encodeWithSelector(
                ResourceRegistry.ResourceUnknown.selector,
                ResourceRegistry.ResourceKind.MARKET,
                admission.spot.market.manifest.subjectId
            )
        );
        registry.validateCashCarry(admission);

        admission = _admission(1, registry.ENTRY());
        admission.spot.venue.localAddress = address(perpVenue);
        vm.expectRevert(
            abi.encodeWithSelector(
                ResourceRegistry.ResourceMismatch.selector, ResourceRegistry.ResourceKind.VENUE, SPOT_VENUE_ID
            )
        );
        registry.validateCashCarry(admission);

        admission = _admission(1, registry.ENTRY());
        vm.etch(address(spotVenue), hex"00");
        vm.expectRevert(
            abi.encodeWithSelector(
                ResourceRegistry.ResourceCodeMismatch.selector, ResourceRegistry.ResourceKind.VENUE, SPOT_VENUE_ID
            )
        );
        registry.validateCashCarry(admission);
    }

    function testImmediateTighteningCancelsPendingChangesAndPreservesExit() public {
        vm.prank(PROPOSER);
        registry.proposeControl(
            ResourceRegistry.ResourceKind.ASSET, BASE_ID, ResourceRegistry.Lifecycle.ACTIVE, 2 * DEFAULT_LIMIT
        );
        vm.prank(PAUSER);
        registry.tightenControl(
            ResourceRegistry.ResourceKind.ASSET, BASE_ID, ResourceRegistry.Lifecycle.ENTRY_PAUSED, 500_000_000
        );
        assertFalse(registry.pendingControl(ResourceRegistry.ResourceKind.ASSET, BASE_ID).exists);

        ResourceRegistry.ManifestRef memory nextVenueRef =
            _manifestRef(SPOT_VENUE_ID, 2, keccak256("spot-venue-manifest-2"));
        vm.prank(PROPOSER);
        registry.proposeRegistration(
            _venueManifest(nextVenueRef, address(spotVenue)), _control(quoteRef, DEFAULT_LIMIT)
        );
        vm.prank(PAUSER);
        registry.tightenControl(
            ResourceRegistry.ResourceKind.VENUE, SPOT_VENUE_ID, ResourceRegistry.Lifecycle.EXIT_ONLY, DEFAULT_LIMIT
        );
        assertFalse(registry.pendingRegistration(ResourceRegistry.ResourceKind.VENUE, SPOT_VENUE_ID).exists);

        ResourceRegistry.CashCarryAdmission memory admission = _admission(1, registry.ENTRY());
        vm.expectRevert(
            abi.encodeWithSelector(
                ResourceRegistry.ActionNotAllowed.selector,
                ResourceRegistry.ResourceKind.ASSET,
                BASE_ID,
                ResourceRegistry.Lifecycle.ENTRY_PAUSED
            )
        );
        registry.validateCashCarry(admission);

        admission = _admission(type(uint128).max, registry.EXIT());
        assertEq(registry.validateCashCarry(admission), 500_000_000);

        vm.prank(PAUSER);
        vm.expectRevert(ResourceRegistry.UnsafeImmediateControlChange.selector);
        registry.tightenControl(
            ResourceRegistry.ResourceKind.ASSET, BASE_ID, ResourceRegistry.Lifecycle.ACTIVE, DEFAULT_LIMIT
        );
    }

    function testPermissiveControlChangeRequiresFullDelay() public {
        vm.prank(PAUSER);
        registry.tightenControl(
            ResourceRegistry.ResourceKind.ADAPTER, PERP_ADAPTER_ID, ResourceRegistry.Lifecycle.EXIT_ONLY, 100_000_000
        );

        uint64 readyAt = uint64(block.timestamp) + DELAY;
        vm.prank(PROPOSER);
        registry.proposeControl(
            ResourceRegistry.ResourceKind.ADAPTER,
            PERP_ADAPTER_ID,
            ResourceRegistry.Lifecycle.ACTIVE,
            PERP_ADAPTER_LIMIT
        );
        vm.warp(readyAt - 1);
        vm.prank(GOVERNANCE_EXECUTOR);
        vm.expectRevert(abi.encodeWithSelector(ResourceRegistry.ControlProposalNotReady.selector, readyAt));
        registry.activateControl(ResourceRegistry.ResourceKind.ADAPTER, PERP_ADAPTER_ID);

        vm.warp(readyAt);
        vm.prank(GOVERNANCE_EXECUTOR);
        registry.activateControl(ResourceRegistry.ResourceKind.ADAPTER, PERP_ADAPTER_ID);
        assertEq(registry.validateCashCarry(_admission(500_000_000, registry.ENTRY())), PERP_ADAPTER_LIMIT);
    }

    function testDependencyReplacementDoesNotReinterpretExistingRecords() public {
        ResourceRegistry.ManifestRef memory nextBaseRef = _manifestRef(BASE_ID, 2, keccak256("base-manifest-2"));
        _register(_assetManifest(nextBaseRef, address(baseAsset), 18), _control(quoteRef, DEFAULT_LIMIT));

        ResourceRegistry.CashCarryAdmission memory admission = _admission(1, registry.ENTRY());
        vm.expectRevert(
            abi.encodeWithSelector(
                ResourceRegistry.ResourceMismatch.selector, ResourceRegistry.ResourceKind.ASSET, BASE_ID
            )
        );
        registry.validateCashCarry(admission);

        admission.baseAsset.manifest = nextBaseRef;
        vm.expectRevert(ResourceRegistry.InvalidAdmission.selector);
        registry.validateCashCarry(admission);

        (ResourceRegistry.ResourceBinding memory original,) =
            registry.resource(ResourceRegistry.ResourceKind.ASSET, baseRef);
        assertEq(original.identity.manifestHash, baseRef.manifestHash);
    }

    function testMalformedClassAndMixedDenominationFailClosed() public {
        ResourceRegistry.ManifestRef memory nextAdapterRef =
            _manifestRef(SPOT_ADAPTER_ID, 2, keccak256("bad-adapter-manifest"));
        ResourceRegistry.ResourceBinding memory malformed = _adapterManifest(
            nextAdapterRef,
            address(spotAdapter),
            ResourceRegistry.LegRole.SPOT,
            keccak256("generic-call-adapter"),
            spotVenueRef,
            spotMarketRef
        );
        vm.prank(PROPOSER);
        vm.expectRevert(ResourceRegistry.InvalidBinding.selector);
        registry.proposeRegistration(malformed, _control(quoteRef, DEFAULT_LIMIT));

        ResourceRegistry.ManifestRef memory nextVenueRef =
            _manifestRef(SPOT_VENUE_ID, 2, keccak256("mixed-denomination"));
        ResourceRegistry.ResourceControl memory wrongControl = _control(baseRef, DEFAULT_LIMIT);
        wrongControl.quoteDecimals = 18;
        vm.prank(PROPOSER);
        registry.proposeRegistration(_venueManifest(nextVenueRef, address(spotVenue)), wrongControl);
        vm.warp(block.timestamp + DELAY);
        vm.prank(GOVERNANCE_EXECUTOR);
        registry.activateRegistration(ResourceRegistry.ResourceKind.VENUE, SPOT_VENUE_ID);

        ResourceRegistry.CashCarryAdmission memory admission = _admission(1, registry.ENTRY());
        admission.spot.venue.manifest = nextVenueRef;
        vm.expectRevert(ResourceRegistry.InvalidAdmission.selector);
        registry.validateCashCarry(admission);
    }

    function testMarketLotsMultipliersAndEconomicQuantitiesAreEnforced() public {
        ResourceRegistry.CashCarryAdmission memory admission = _admission(1, registry.ENTRY());
        admission.spot.quantityAtoms = 1 ether - 1;
        vm.expectRevert(ResourceRegistry.InvalidAdmission.selector);
        registry.validateCashCarry(admission);

        admission = _admission(1, registry.ENTRY());
        admission.packageNotionalQuoteAtoms = 2;
        vm.expectRevert(
            abi.encodeWithSelector(ResourceRegistry.PackageNotionalMismatch.selector, uint256(1), uint256(2))
        );
        registry.validateCashCarry(admission);

        admission = _admission(1, registry.ENTRY());
        admission.perpetual.quantityAtoms = 2 ether;
        vm.expectRevert(ResourceRegistry.InvalidAdmission.selector);
        registry.validateCashCarry(admission);

        admission = _admission(1, registry.ENTRY());
        admission.spot.limitQuoteAtomsPerBaseLot = 0;
        vm.expectRevert(ResourceRegistry.InvalidAdmission.selector);
        registry.validateCashCarry(admission);

        ResourceRegistry.ManifestRef memory nextMarketRef =
            _manifestRef(SPOT_MARKET_ID, 2, keccak256("non-reduced-multiplier"));
        ResourceRegistry.ResourceBinding memory market = _marketManifest(
            nextMarketRef, address(spotMarket), ResourceRegistry.LegRole.SPOT, spotVenueRef, baseRef, quoteRef
        );
        market.marketParameters.contractMultiplierNumerator = 2;
        market.marketParameters.contractMultiplierDenominator = 2;
        vm.prank(PROPOSER);
        vm.expectRevert(ResourceRegistry.InvalidBinding.selector);
        registry.proposeRegistration(market, _control(quoteRef, DEFAULT_LIMIT));
    }

    function testDomainActivationInvalidatesEveryOldBinding() public {
        bytes32 nextDomainHash = keccak256("domain-manifest-2");
        vm.prank(PROPOSER);
        config.proposeDomain(2, nextDomainHash);
        vm.warp(block.timestamp + DELAY);
        vm.prank(GOVERNANCE_EXECUTOR);
        config.activateDomain();

        ResourceRegistry.CashCarryAdmission memory admission = _admission(1, registry.ENTRY());
        admission.domain.manifestVersion = 2;
        admission.domain.manifestHash = nextDomainHash;
        vm.expectRevert(ResourceRegistry.DomainMismatch.selector);
        registry.validateCashCarry(admission);
    }

    function testStaleTemplateBlocksRegistrationAndAdmission() public {
        ResourceRegistry.ManifestRef memory nextRef =
            _manifestRef(SPOT_ADAPTER_ID, 2, keccak256("spot-adapter-manifest-2"));
        ResourceRegistry.ResourceBinding memory next = _adapterManifest(
            nextRef,
            address(spotAdapter),
            ResourceRegistry.LegRole.SPOT,
            registry.BASE_SPOT_ADAPTER_CLASS(),
            spotVenueRef,
            spotMarketRef
        );
        vm.prank(PROPOSER);
        registry.proposeRegistration(next, _control(quoteRef, DEFAULT_LIMIT));

        bytes32 nextTemplateHash = keccak256("cash-carry-template-manifest-2");
        _activateTemplate(nextTemplateHash);
        assertEq(registry.cashCarryTemplateManifestHash(), nextTemplateHash);

        // The pending adapter was proposed under the retired template, so its activation fails closed.
        vm.prank(GOVERNANCE_EXECUTOR);
        vm.expectRevert(ResourceRegistry.InvalidBinding.selector);
        registry.activateRegistration(ResourceRegistry.ResourceKind.ADAPTER, SPOT_ADAPTER_ID);

        // Active adapters bound to the retired template no longer admit, under either template reference.
        ResourceRegistry.CashCarryAdmission memory admission = _admission(1, registry.ENTRY());
        vm.expectRevert(ResourceRegistry.InvalidAdmission.selector);
        registry.validateCashCarry(admission);
        admission.template.templateManifestHash = nextTemplateHash;
        vm.expectRevert();
        registry.validateCashCarry(admission);
    }

    function _activateTemplate(bytes32 templateManifestHash) private {
        vm.prank(PROPOSER);
        config.proposeCashCarryTemplate(templateManifestHash);
        vm.warp(block.timestamp + DELAY);
        vm.prank(GOVERNANCE_EXECUTOR);
        config.activateCashCarryTemplate();
    }

    function _register(
        ResourceRegistry.ResourceBinding memory manifest,
        ResourceRegistry.ResourceControl memory control
    ) private {
        vm.prank(PROPOSER);
        registry.proposeRegistration(manifest, control);
        vm.warp(block.timestamp + DELAY);
        vm.prank(GOVERNANCE_EXECUTOR);
        registry.activateRegistration(manifest.kind, manifest.identity.subjectId);
    }

    function _assetManifest(ResourceRegistry.ManifestRef memory identity, address asset, uint8 decimals)
        private
        view
        returns (ResourceRegistry.ResourceBinding memory)
    {
        return ResourceRegistry.ResourceBinding({
            kind: ResourceRegistry.ResourceKind.ASSET,
            domain: domain,
            identity: identity,
            localAddress: asset,
            expectedCodeHash: asset.codehash,
            decimals: decimals,
            legRole: ResourceRegistry.LegRole.NONE,
            adapterClassId: bytes32(0),
            adapterClassVersion: 0,
            venue: _emptyRef(),
            market: _emptyRef(),
            baseAsset: _emptyRef(),
            quoteAsset: _emptyRef(),
            marketParameters: _emptyMarketParameters(),
            allowedTemplate: _emptyTemplate(),
            settlementClass: _emptySettlement()
        });
    }

    function _venueManifest(ResourceRegistry.ManifestRef memory identity, address venue)
        private
        view
        returns (ResourceRegistry.ResourceBinding memory)
    {
        return ResourceRegistry.ResourceBinding({
            kind: ResourceRegistry.ResourceKind.VENUE,
            domain: domain,
            identity: identity,
            localAddress: venue,
            expectedCodeHash: venue.codehash,
            decimals: 0,
            legRole: ResourceRegistry.LegRole.NONE,
            adapterClassId: bytes32(0),
            adapterClassVersion: 0,
            venue: _emptyRef(),
            market: _emptyRef(),
            baseAsset: _emptyRef(),
            quoteAsset: _emptyRef(),
            marketParameters: _emptyMarketParameters(),
            allowedTemplate: _emptyTemplate(),
            settlementClass: _emptySettlement()
        });
    }

    function _marketManifest(
        ResourceRegistry.ManifestRef memory identity,
        address market,
        ResourceRegistry.LegRole role,
        ResourceRegistry.ManifestRef memory venue,
        ResourceRegistry.ManifestRef memory base,
        ResourceRegistry.ManifestRef memory quote
    ) private view returns (ResourceRegistry.ResourceBinding memory) {
        return ResourceRegistry.ResourceBinding({
            kind: ResourceRegistry.ResourceKind.MARKET,
            domain: domain,
            identity: identity,
            localAddress: market,
            expectedCodeHash: market.codehash,
            decimals: 0,
            legRole: role,
            adapterClassId: bytes32(0),
            adapterClassVersion: 0,
            venue: venue,
            market: _emptyRef(),
            baseAsset: base,
            quoteAsset: quote,
            marketParameters: _marketParameters(),
            allowedTemplate: _emptyTemplate(),
            settlementClass: _emptySettlement()
        });
    }

    function _adapterManifest(
        ResourceRegistry.ManifestRef memory identity,
        address adapter,
        ResourceRegistry.LegRole role,
        bytes32 classId,
        ResourceRegistry.ManifestRef memory venue,
        ResourceRegistry.ManifestRef memory market
    ) private view returns (ResourceRegistry.ResourceBinding memory) {
        return ResourceRegistry.ResourceBinding({
            kind: ResourceRegistry.ResourceKind.ADAPTER,
            domain: domain,
            identity: identity,
            localAddress: adapter,
            expectedCodeHash: adapter.codehash,
            decimals: 0,
            legRole: role,
            adapterClassId: classId,
            adapterClassVersion: registry.ADAPTER_CLASS_VERSION(),
            venue: venue,
            market: market,
            baseAsset: baseRef,
            quoteAsset: quoteRef,
            marketParameters: _emptyMarketParameters(),
            allowedTemplate: template,
            settlementClass: settlementClass
        });
    }

    function _control(ResourceRegistry.ManifestRef memory denomination, uint256 maximumQuoteAtoms)
        private
        pure
        returns (ResourceRegistry.ResourceControl memory)
    {
        uint8 decimals = denomination.subjectId == QUOTE_ID ? 6 : 18;
        return ResourceRegistry.ResourceControl({
            state: ResourceRegistry.Lifecycle.ACTIVE,
            quoteAsset: denomination,
            quoteDecimals: decimals,
            maximumPackageNotionalQuoteAtoms: maximumQuoteAtoms
        });
    }

    function _admission(uint256 packageNotionalQuoteAtoms, uint8 action)
        private
        view
        returns (ResourceRegistry.CashCarryAdmission memory)
    {
        return ResourceRegistry.CashCarryAdmission({
            domain: domain,
            template: template,
            settlementClass: settlementClass,
            spot: ResourceRegistry.LegAdmission({
                adapter: _resourceRef(spotAdapterRef, address(spotAdapter)),
                adapterClassId: registry.BASE_SPOT_ADAPTER_CLASS(),
                adapterClassVersion: registry.ADAPTER_CLASS_VERSION(),
                market: _resourceRef(spotMarketRef, address(spotMarket)),
                venue: _resourceRef(spotVenueRef, address(spotVenue)),
                quantityAtoms: 1 ether,
                limitQuoteAtomsPerBaseLot: packageNotionalQuoteAtoms
            }),
            perpetual: ResourceRegistry.LegAdmission({
                adapter: _resourceRef(perpAdapterRef, address(perpPort)),
                adapterClassId: registry.BASE_PERP_PORT_CLASS(),
                adapterClassVersion: registry.ADAPTER_CLASS_VERSION(),
                market: _resourceRef(perpMarketRef, address(perpMarket)),
                venue: _resourceRef(perpVenueRef, address(perpVenue)),
                quantityAtoms: 1 ether,
                limitQuoteAtomsPerBaseLot: packageNotionalQuoteAtoms
            }),
            baseAsset: _assetRef(baseRef, address(baseAsset), 18),
            quoteAsset: _assetRef(quoteRef, address(quoteAsset), 6),
            action: action,
            packageNotionalQuoteAtoms: packageNotionalQuoteAtoms
        });
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

    function _manifestRef(bytes32 subjectId, uint32 version, bytes32 manifestHash)
        private
        pure
        returns (ResourceRegistry.ManifestRef memory)
    {
        return
            ResourceRegistry.ManifestRef({subjectId: subjectId, manifestVersion: version, manifestHash: manifestHash});
    }

    function _emptyRef() private pure returns (ResourceRegistry.ManifestRef memory) {
        return ResourceRegistry.ManifestRef({subjectId: bytes32(0), manifestVersion: 0, manifestHash: bytes32(0)});
    }

    function _emptyTemplate() private pure returns (ResourceRegistry.TemplateRef memory) {
        return
            ResourceRegistry.TemplateRef({templateId: bytes32(0), templateVersion: 0, templateManifestHash: bytes32(0)});
    }

    function _emptySettlement() private pure returns (ResourceRegistry.SettlementClassRef memory) {
        return ResourceRegistry.SettlementClassRef({classId: bytes32(0), classVersion: 0});
    }

    function _marketParameters() private pure returns (ResourceRegistry.MarketParameters memory) {
        return ResourceRegistry.MarketParameters({
            baseLotAtoms: 1 ether,
            quoteTickAtomsPerBaseLot: 1,
            minimumQuoteNotionalAtoms: 1,
            contractMultiplierNumerator: 1,
            contractMultiplierDenominator: 1,
            baseDecimals: 18,
            quoteDecimals: 6
        });
    }

    function _emptyMarketParameters() private pure returns (ResourceRegistry.MarketParameters memory) {
        return ResourceRegistry.MarketParameters({
            baseLotAtoms: 0,
            quoteTickAtomsPerBaseLot: 0,
            minimumQuoteNotionalAtoms: 0,
            contractMultiplierNumerator: 0,
            contractMultiplierDenominator: 0,
            baseDecimals: 0,
            quoteDecimals: 0
        });
    }
}

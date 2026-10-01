// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "openzeppelin-contracts/token/ERC20/IERC20.sol";
import {Math} from "openzeppelin-contracts/utils/math/Math.sol";
import {SafeERC20} from "openzeppelin-contracts/token/ERC20/utils/SafeERC20.sol";
import {CashCarrySeriesRegistry} from "../src/CashCarrySeriesRegistry.sol";
import {NaryxStrategyAccount} from "../src/NaryxStrategyAccount.sol";
import {NaryxStrategyAccountFactory} from "../src/NaryxStrategyAccountFactory.sol";
import {PackageQuoteShardRegistry} from "../src/PackageQuoteShardRegistry.sol";
import {PackageVerifier} from "../src/PackageVerifier.sol";
import {PolicyRegistry} from "../src/PolicyRegistry.sol";
import {ProtocolConfig} from "../src/ProtocolConfig.sol";
import {ResourceRegistry} from "../src/ResourceRegistry.sol";
import {SolverRegistry} from "../src/SolverRegistry.sol";
import {NaryxTestPerpMarket} from "../src/conformance/NaryxTestPerpMarket.sol";
import {AggregatorV3Interface} from "../src/interfaces/IAggregatorV3.sol";
import {IExactSpotPort} from "../src/interfaces/IExactSpotPort.sol";
import {ISpotFillRecorder} from "../src/interfaces/ISpotFillRecorder.sol";
import {StrategyAccountSeriesRegistry, StrategyAccountToken} from "./NaryxStrategyAccount.t.sol";
import {PerpMarketAggregator, PerpMarketUsdc} from "./NaryxTestPerpMarket.t.sol";

contract PricedSpotPort is IExactSpotPort {
    using SafeERC20 for IERC20;

    address public immutable verifier;
    bytes32 public immutable verifierCodeHash;
    IERC20 public immutable baseToken;
    IERC20 public immutable quoteToken;
    uint256 public quoteAtomsPerBase;

    constructor(address verifier_, IERC20 baseToken_, IERC20 quoteToken_, uint256 quoteAtomsPerBase_) {
        verifier = verifier_;
        verifierCodeHash = verifier_.codehash;
        baseToken = baseToken_;
        quoteToken = quoteToken_;
        quoteAtomsPerBase = quoteAtomsPerBase_;
    }

    function setPrice(uint256 quoteAtomsPerBase_) external {
        quoteAtomsPerBase = quoteAtomsPerBase_;
    }

    function buyExactOutput(
        uint256 packageNonce,
        bytes32 spotFillCommitment,
        bytes32 orderHash,
        bytes32 quoteHash,
        bytes32 routeHash,
        uint256 quantity,
        uint256 maxQuote
    ) external returns (uint256 quoteIn) {
        quoteIn = Math.mulDiv(quantity, quoteAtomsPerBase, 1e18, Math.Rounding.Ceil);
        require(quoteIn <= maxQuote, "quote bound");
        quoteToken.safeTransferFrom(msg.sender, address(this), quoteIn);
        baseToken.safeTransfer(msg.sender, quantity);
        ISpotFillRecorder(verifier)
            .recordSpotFill(
                msg.sender,
                packageNonce,
                spotFillCommitment,
                orderHash,
                quoteHash,
                routeHash,
                1,
                address(baseToken),
                address(quoteToken),
                quantity,
                quoteIn
            );
    }

    function sellExactInput(
        uint256 packageNonce,
        bytes32 spotFillCommitment,
        bytes32 orderHash,
        bytes32 quoteHash,
        bytes32 routeHash,
        uint256 quantity,
        uint256 minQuote
    ) external returns (uint256 quoteOut) {
        quoteOut = Math.mulDiv(quantity, quoteAtomsPerBase, 1e18);
        require(quoteOut >= minQuote, "quote bound");
        baseToken.safeTransferFrom(msg.sender, address(this), quantity);
        quoteToken.safeTransfer(msg.sender, quoteOut);
        ISpotFillRecorder(verifier)
            .recordSpotFill(
                msg.sender,
                packageNonce,
                spotFillCommitment,
                orderHash,
                quoteHash,
                routeHash,
                2,
                address(baseToken),
                address(quoteToken),
                quantity,
                quoteOut
            );
    }

    function assertDeployment() external view {}
}

/// Admits one exact admission hash and serves venue records for the account's margin gate check.
contract GateResourceRegistry {
    struct Venue {
        address localAddress;
        bytes32 expectedCodeHash;
        ResourceRegistry.Lifecycle state;
    }

    ProtocolConfig public immutable config;
    bytes32 public expectedAdmissionHash;
    mapping(bytes32 subjectId => Venue venue) private _venues;

    constructor(ProtocolConfig config_) {
        config = config_;
    }

    function setExpectedAdmissionHash(bytes32 expectedAdmissionHash_) external {
        expectedAdmissionHash = expectedAdmissionHash_;
    }

    function setVenue(bytes32 subjectId, address localAddress, bytes32 codeHash, ResourceRegistry.Lifecycle state)
        external
    {
        _venues[subjectId] = Venue(localAddress, codeHash, state);
    }

    function validateCashCarry(ResourceRegistry.CashCarryAdmission calldata admission) external view returns (uint256) {
        require(keccak256(abi.encode(admission)) == expectedAdmissionHash, "unadmitted route");
        return type(uint256).max;
    }

    function activeResource(ResourceRegistry.ResourceKind kind, bytes32 subjectId)
        external
        view
        returns (ResourceRegistry.ResourceBinding memory binding, ResourceRegistry.ResourceControl memory control)
    {
        Venue memory venue = _venues[subjectId];
        require(kind == ResourceRegistry.ResourceKind.VENUE && venue.localAddress != address(0), "unknown resource");
        binding.kind = kind;
        binding.localAddress = venue.localAddress;
        binding.expectedCodeHash = venue.expectedCodeHash;
        control.state = venue.state;
    }
}

contract NaryxStrategyAccountFactoryTest is Test {
    string private constant DOMAIN_ID = "eip155:31338";
    uint32 private constant EXPIRY = type(uint32).max;
    uint256 private constant QUANTITY = 1e18;
    bytes32 private constant DOMAIN_MANIFEST_HASH = keccak256("domain-manifest");
    bytes32 private constant PERP_VENUE_ID = keccak256("venue:naryx-test-perp");
    bytes32 private constant SERIES_IDENTITY_KEY = keccak256("series-identity");
    bytes32 private constant SERIES_BINDING_HASH = keccak256("series-binding");
    bytes32 private constant BASE_ASSET_ID = keccak256("base-asset");
    bytes32 private constant QUOTE_ASSET_ID = keccak256("quote-asset");
    address private constant PROPOSER = address(0x101);
    address private constant CANCELLER = address(0x102);
    address private constant GOVERNANCE_EXECUTOR = address(0x103);
    address private constant PAUSER = address(0x104);

    uint256 private ownerKey = 0xA11CE;
    uint256 private solverKey = 0xB0B;
    address private owner;
    address private solver;
    address private marketOwner = makeAddr("marketOwner");
    address private keeper = makeAddr("keeper");
    address private feeRecipient = makeAddr("feeRecipient");

    StrategyAccountToken private weth;
    PerpMarketUsdc private usdc;
    PerpMarketAggregator private oracle;
    ProtocolConfig private config;
    GateResourceRegistry private registry;
    PackageVerifier private verifier;
    NaryxStrategyAccountFactory private factory;
    NaryxTestPerpMarket private market;
    PricedSpotPort private spotPort;
    NaryxStrategyAccount private account;

    function setUp() public {
        vm.chainId(31_338);
        vm.warp(1_000_000);
        owner = vm.addr(ownerKey);
        solver = vm.addr(solverKey);
        weth = new StrategyAccountToken("Wrapped Ether", "WETH");
        usdc = new PerpMarketUsdc();
        oracle = new PerpMarketAggregator();
        oracle.setPrice(2_000e8);
        config =
            new ProtocolConfig(DOMAIN_ID, 1, DOMAIN_MANIFEST_HASH, 1, PROPOSER, CANCELLER, GOVERNANCE_EXECUTOR, PAUSER);
        registry = new GateResourceRegistry(config);
        StrategyAccountSeriesRegistry series =
            new StrategyAccountSeriesRegistry(config, ResourceRegistry(address(registry)));
        verifier = new PackageVerifier(
            config,
            new SolverRegistry(config, solver),
            ResourceRegistry(address(registry)),
            CashCarrySeriesRegistry(address(series)),
            new PackageQuoteShardRegistry(config),
            PolicyRegistry(address(0)),
            bytes32(0)
        );
        series.configure(_seriesBinding(), SERIES_IDENTITY_KEY, SERIES_BINDING_HASH);
        factory = new NaryxStrategyAccountFactory(verifier);
        market = new NaryxTestPerpMarket(_marketParameters());
        spotPort = new PricedSpotPort(address(verifier), IERC20(address(weth)), IERC20(address(usdc)), 2_000e6);
        registry.setVenue(PERP_VENUE_ID, address(market), address(market).codehash, ResourceRegistry.Lifecycle.ACTIVE);

        account = factory.create(owner);
        usdc.mint(address(account), 3_000e6);
        weth.mint(address(spotPort), 10e18);
        usdc.mint(address(spotPort), 10_000e6);
        usdc.mint(marketOwner, 1_000e6);
        vm.startPrank(marketOwner);
        usdc.approve(address(market), 1_000e6);
        market.fundInsurance(1_000e6);
        vm.stopPrank();

        vm.prank(PROPOSER);
        config.scheduleUnpause();
        vm.warp(block.timestamp + 1);
        vm.prank(GOVERNANCE_EXECUTOR);
        config.activateUnpause();
        oracle.setPrice(2_000e8);
    }

    function testFactoryPredictsCreatesIdempotentlyAndSharesOneCodeHash() public {
        address alice = makeAddr("alice");
        address predicted = factory.accountOf(alice);
        assertEq(predicted.code.length, 0);

        address anyone = makeAddr("anyone");
        vm.expectEmit(true, true, false, false, address(factory));
        emit NaryxStrategyAccountFactory.AccountCreated(alice, predicted);
        vm.prank(anyone);
        NaryxStrategyAccount created = factory.create(alice);
        assertEq(address(created), predicted);
        assertEq(created.owner(), alice);
        assertEq(address(created.verifier()), address(verifier));
        assertEq(address(factory.create(alice)), predicted);

        assertTrue(address(account) != predicted);
        assertEq(address(account).codehash, factory.accountCodeHash());
        assertEq(predicted.codehash, factory.accountCodeHash());
        assertEq(factory.referenceAccount().codehash, factory.accountCodeHash());

        vm.expectRevert(NaryxStrategyAccountFactory.InvalidOwner.selector);
        factory.create(address(0));
    }

    function testAccountMovesMarginOnlyThroughARegisteredVenueGate() public {
        address stranger = makeAddr("stranger");
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(NaryxStrategyAccount.UnauthorizedOwner.selector, stranger));
        account.depositPerpMargin(PERP_VENUE_ID, 1e6);

        vm.startPrank(owner);
        vm.expectRevert(bytes("unknown resource"));
        account.depositPerpMargin(keccak256("unregistered"), 1e6);
        account.depositPerpMargin(PERP_VENUE_ID, 400e6);
        assertEq(market.reserveOf(address(account)), 400e6);
        assertEq(usdc.balanceOf(address(account)), 2_600e6);
        assertEq(usdc.allowance(address(account), address(market)), 0);

        registry.setVenue(PERP_VENUE_ID, address(market), keccak256("other-code"), ResourceRegistry.Lifecycle.ACTIVE);
        vm.expectRevert(NaryxStrategyAccount.UnregisteredPerpVenue.selector);
        account.withdrawPerpMargin(PERP_VENUE_ID, 100e6);

        // An entry-paused venue takes no new margin but still returns it.
        registry.setVenue(
            PERP_VENUE_ID, address(market), address(market).codehash, ResourceRegistry.Lifecycle.ENTRY_PAUSED
        );
        vm.expectRevert(NaryxStrategyAccount.UnregisteredPerpVenue.selector);
        account.depositPerpMargin(PERP_VENUE_ID, 1e6);
        account.withdrawPerpMargin(PERP_VENUE_ID, 100e6);
        assertEq(market.reserveOf(address(account)), 300e6);
        assertEq(usdc.balanceOf(address(account)), 2_700e6);
        vm.expectRevert(NaryxStrategyAccount.InvalidMarginTransfer.selector);
        account.withdrawPerpMargin(PERP_VENUE_ID, 300e6 + 1);
        vm.stopPrank();
    }

    function testFactoryAccountEntersAndExitsThroughVerifierAgainstTheTestMarket() public {
        vm.prank(owner);
        account.depositPerpMargin(PERP_VENUE_ID, 400e6);

        (, uint256 entryNotional,, uint256 margin) = market.previewOpen(-int128(int256(QUANTITY)), 400e18);
        PackageVerifier.Execution memory entry = _execution(verifier.ENTRY(), 0);
        entry.spotQuoteBoundAtoms = 2_000e6;
        entry.expectedPostPerpSizeWad = -int128(int256(QUANTITY));
        entry.minimumPostPerpBalanceWad = int128(int256(margin));
        entry.maximumPostPerpBalanceWad = int128(int256(margin));
        entry.maximumPostPerpEntryNotionalWad = uint128(entryNotional);
        bytes32 entryReceiptHash = _executePackage(entry, _args(-int128(int256(QUANTITY)), 400e18));

        assertEq(weth.balanceOf(address(account)), QUANTITY);
        assertEq(usdc.balanceOf(address(account)), 600e6);
        assertEq(market.reserveOf(address(account)), 0);
        PackageVerifier.Receipt memory entryReceipt = verifier.receipt(entryReceiptHash);
        assertEq(entryReceipt.postPerpBalanceWad, int128(int256(margin)));
        assertEq(entryReceipt.postPerpEntryNotionalWad, uint128(entryNotional));

        vm.prank(keeper);
        market.setFundingRatePerSecond(1e13);
        vm.warp(block.timestamp + 1 hours);
        oracle.setPrice(1_900e8);
        spotPort.setPrice(1_900e6);

        PackageVerifier.Execution memory exit = _execution(verifier.EXIT(), 1);
        exit.orderHash = keccak256("exit-order");
        exit.quoteHash = keccak256("exit-quote");
        exit.spotFillCommitment = keccak256("exit-spot-fill");
        exit.spotQuoteBoundAtoms = 1_900e6;
        exit.expectedPrePerpBalanceWad = int128(int256(margin));
        exit.expectedPrePerpSizeWad = -int128(int256(QUANTITY));
        exit.expectedPrePerpEntryNotionalWad = uint128(entryNotional);
        exit.entryReceiptHash = entryReceiptHash;
        _executePackage(exit, _args(int128(int256(QUANTITY)), 0));

        assertEq(weth.balanceOf(address(account)), 0);
        assertEq(usdc.balanceOf(address(account)), 2_500e6);
        assertEq(market.getPosition(address(market), EXPIRY, address(account)).size, 0);
        assertFalse(verifier.hasOpenPackage(address(account)));
        // Margin 399.00021 + PnL 99.181 + funding 0.036 - close fee 0.9502 settles into the gate reserve.
        assertEq(market.reserveOf(address(account)), 497_267_010);

        vm.prank(owner);
        account.withdrawPerpMargin(PERP_VENUE_ID, 497_267_010);
        assertEq(usdc.balanceOf(address(account)), 2_500e6 + 497_267_010);
    }

    function _executePackage(PackageVerifier.Execution memory execution, bytes32[2] memory perpArgs)
        private
        returns (bytes32 receiptHash)
    {
        ResourceRegistry.CashCarryAdmission memory admission = _admission(execution);
        registry.setExpectedAdmissionHash(keccak256(abi.encode(admission)));
        bytes memory traderSignature = _signature(ownerKey, verifier.traderPermitDigest(execution, admission));
        bytes memory solverSignature = _signature(solverKey, verifier.solverAuthorizationDigest(execution, admission));
        return account.executePackage(execution, admission, traderSignature, solverSignature, perpArgs);
    }

    function _execution(uint8 action, uint256 nonce) private view returns (PackageVerifier.Execution memory execution) {
        execution.domainIdHash = keccak256(bytes(DOMAIN_ID));
        execution.domainManifestVersion = 1;
        execution.domainManifestHash = DOMAIN_MANIFEST_HASH;
        execution.orderHash = keccak256("entry-order");
        execution.quoteHash = keccak256("entry-quote");
        execution.routeHash = keccak256("route");
        execution.spotFillCommitment = keccak256("entry-spot-fill");
        execution.seriesIdentityKey = SERIES_IDENTITY_KEY;
        execution.seriesBindingVersion = 1;
        execution.seriesBindingHash = SERIES_BINDING_HASH;
        execution.action = action;
        execution.strategyAccount = address(account);
        execution.solver = solver;
        execution.spotPort = address(spotPort);
        execution.perpObserver = address(market);
        execution.perpInstrument = address(market);
        execution.perpExpiry = EXPIRY;
        execution.baseToken = address(weth);
        execution.quoteToken = address(usdc);
        execution.baseQuantityAtoms = QUANTITY;
        execution.perpQuantityWad = QUANTITY;
        execution.packageNotionalQuoteAtoms = 2_000e6;
        execution.packageSizeUnits = uint128(QUANTITY);
        execution.nonce = nonce;
        execution.deadline = block.timestamp + 1 hours;
    }

    function _admission(PackageVerifier.Execution memory execution)
        private
        view
        returns (ResourceRegistry.CashCarryAdmission memory admission)
    {
        admission.domain = ResourceRegistry.DomainRef({
            domainIdHash: execution.domainIdHash,
            manifestVersion: execution.domainManifestVersion,
            manifestHash: execution.domainManifestHash
        });
        admission.action = execution.action;
        admission.packageNotionalQuoteAtoms = execution.packageNotionalQuoteAtoms;
        admission.spot.adapter.localAddress = execution.spotPort;
        admission.perpetual.adapter.localAddress = address(verifier);
        admission.perpetual.venue.localAddress = address(market);
        admission.perpetual.market.localAddress = address(market);
        admission.baseAsset.localAddress = address(weth);
        admission.quoteAsset.localAddress = address(usdc);
        admission.baseAsset.manifest =
            ResourceRegistry.ManifestRef({subjectId: BASE_ASSET_ID, manifestVersion: 1, manifestHash: BASE_ASSET_ID});
        admission.quoteAsset.manifest =
            ResourceRegistry.ManifestRef({subjectId: QUOTE_ASSET_ID, manifestVersion: 1, manifestHash: QUOTE_ASSET_ID});
        admission.spot.quantityAtoms = QUANTITY;
        admission.perpetual.quantityAtoms = QUANTITY;
    }

    function _seriesBinding() private pure returns (CashCarrySeriesRegistry.CashCarrySeriesBindingV1 memory binding) {
        binding.bindingVersion = 1;
        binding.seriesManifestHash = keccak256("series-manifest");
        binding.executionClassManifestHash = keccak256("execution-class-manifest");
        binding.settlementClassIdentityHash = keccak256("atomic-settlement");
        binding.baseAsset = CashCarrySeriesRegistry.SeriesManifestRef({
            subjectIdentity: BASE_ASSET_ID, manifestVersion: 1, manifestHash: BASE_ASSET_ID
        });
        binding.quoteAsset = CashCarrySeriesRegistry.SeriesManifestRef({
            subjectIdentity: QUOTE_ASSET_ID, manifestVersion: 1, manifestHash: QUOTE_ASSET_ID
        });
        binding.entrySide = 1;
        binding.spotBaseAtomsPerPackageUnit = 1;
        binding.perpQuantityAtomsPerPackageUnit = 1;
    }

    function _marketParameters() private view returns (NaryxTestPerpMarket.Parameters memory) {
        return NaryxTestPerpMarket.Parameters({
            owner: marketOwner,
            fundingKeeper: keeper,
            feeRecipient: feeRecipient,
            collateral: IERC20(address(usdc)),
            oracle: AggregatorV3Interface(address(oracle)),
            expiry: EXPIRY,
            maxOracleAgeSeconds: 1 hours,
            takerFeeBps: 5,
            halfSpreadBps: 2,
            impactBps: 1,
            impactSizeWad: 10e18,
            initialMarginBps: 1_000,
            maintenanceMarginBps: 500,
            liquidationPenaltyBps: 50,
            maxPositionSizeWad: 10e18,
            maxMarginWad: 100_000e18,
            maxAbsFundingRatePerSecond: 1e15
        });
    }

    function _signature(uint256 key, bytes32 digest) private pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _args(int128 sizeDelta, int128 balanceDelta) private view returns (bytes32[2] memory args) {
        args[0] = bytes32(uint256(block.timestamp + 1 hours) << 56 | uint256(EXPIRY));
        args[1] = bytes32(uint256(uint128(sizeDelta)) << 128 | uint256(uint128(balanceDelta)));
    }
}

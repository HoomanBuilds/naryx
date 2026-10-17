// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "openzeppelin-contracts/token/ERC20/IERC20.sol";
import {NativeCashRangeMarket} from "../src/NativeCashRangeMarket.sol";
import {NativePackageClearingHouse} from "../src/NativePackageClearingHouse.sol";
import {NaryxTestUSDC} from "../src/conformance/NaryxTestUSDC.sol";

contract RangeReferenceFixture {
    uint8 public decimals = 8;
    uint80 public roundId = 1;
    uint80 public answeredInRound = 1;
    int256 public answer = 3500e8;
    uint256 public startedAt;
    uint256 public updatedAt;

    constructor() {
        startedAt = block.timestamp;
        updatedAt = block.timestamp;
    }

    function set(int256 value, uint256 time, uint80 round, uint80 answered) external {
        answer = value;
        updatedAt = time;
        roundId = round;
        answeredInRound = answered;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (roundId, answer, startedAt, updatedAt, answeredInRound);
    }
}

contract NativeCashRangeMarketTest is Test {
    RangeReferenceFixture private feed;
    NaryxTestUSDC private token;
    NativeCashRangeMarket private market;

    function configuration() private view returns (NativePackageClearingHouse.Configuration memory) {
        return NativePackageClearingHouse.Configuration({
            policyHash: keccak256("range-policy"),
            governor: address(this),
            pauser: address(this),
            markAuthority: address(0),
            packageQuantityIncrementAtoms: 1,
            priceTickQuoteAtoms: 1,
            initialMarginQuoteAtomsPerIncrement: 1_000_001,
            maintenanceMarginQuoteAtomsPerIncrement: 1_000_001,
            maximumPositionAtoms: 5,
            maximumOpenInterestAtoms: 10,
            maximumDefaultTransferDiscountBps: 500,
            markMaximumStalenessSeconds: 600,
            defaultAuctionDurationSeconds: 60,
            feeUpdateDelaySeconds: 60,
            maximumFeeBps: 100
        });
    }

    function source() private view returns (NativeCashRangeMarket.ReferenceConfiguration memory) {
        return NativeCashRangeMarket.ReferenceConfiguration({
            chainId: block.chainid,
            oracle: address(feed),
            sequencerFeed: address(0),
            markUpdater: address(this),
            lowerBound: 3000e8,
            upperBound: 4000e8,
            underlyingAtomsPerPackage: 1e15,
            maximumOracleAgeSeconds: 3600,
            sequencerGracePeriodSeconds: 3600,
            oracleDecimals: 8,
            underlyingDecimals: 18,
            allowMissingSequencer: true
        });
    }

    function setUp() public {
        vm.warp(10_000);
        feed = new RangeReferenceFixture();
        token = new NaryxTestUSDC();
        market = new NativeCashRangeMarket(IERC20(address(token)), configuration(), source());
    }

    function testReferenceIsBoundedAndOnlyControllerCanPublishHouseMarks() public {
        (uint128 price,,, uint64 until) = market.previewMark();
        assertEq(price, 500_001);
        assertEq(until, block.timestamp + 600);
        NativePackageClearingHouse house = market.clearingHouse();
        assertEq(house.markAuthority(), address(market));
        vm.expectRevert(NativePackageClearingHouse.Unauthorized.selector);
        house.publishMark(keccak256("bad"), 2_000_000, 1, uint64(block.timestamp + 30));
        market.refreshMark(keccak256("observed"), price, 1, until);
        (, uint128 stored,,,) = house.currentMark();
        assertEq(stored, price);
        vm.expectRevert(NativeCashRangeMarket.ReferenceChanged.selector);
        market.refreshMark(keccak256("wrong"), price + 1, 2, until);
        vm.prank(address(0xBEEF));
        vm.expectRevert(NativeCashRangeMarket.Unauthorized.selector);
        market.refreshMark(keccak256("wrong-authority"), price, 2, until);
    }

    function testRejectsStaleFutureIncompleteAndNonpositiveReferences() public {
        feed.set(3500e8, block.timestamp - 3600, 1, 1);
        vm.expectRevert(NativeCashRangeMarket.InvalidReference.selector);
        market.previewMark();
        feed.set(3500e8, block.timestamp + 1, 1, 1);
        vm.expectRevert(NativeCashRangeMarket.InvalidReference.selector);
        market.previewMark();
        feed.set(3500e8, block.timestamp, 2, 1);
        vm.expectRevert(NativeCashRangeMarket.InvalidReference.selector);
        market.previewMark();
        feed.set(0, block.timestamp, 1, 1);
        vm.expectRevert(NativeCashRangeMarket.InvalidReference.selector);
        market.previewMark();
    }

    function testCannotRenewPastTheSourceFreshnessDeadline() public {
        feed.set(3500e8, block.timestamp - 3550, 1, 1);
        (uint128 price,,, uint64 until) = market.previewMark();
        assertEq(until, block.timestamp + 50);
        vm.expectRevert(NativeCashRangeMarket.ReferenceChanged.selector);
        market.refreshMark(keccak256("renewal"), price, 1, until + 1);
        market.refreshMark(keccak256("bounded-renewal"), price, 1, until);
        vm.warp(block.timestamp + 50);
        vm.expectRevert(NativeCashRangeMarket.InvalidReference.selector);
        market.previewMark();
    }

    function testRequiresFullRangeCollateralAndExactChainAndFeedDecimals() public {
        NativePackageClearingHouse.Configuration memory config = configuration();
        config.initialMarginQuoteAtomsPerIncrement = 1_000_000;
        vm.expectRevert(NativeCashRangeMarket.InvalidConfiguration.selector);
        new NativeCashRangeMarket(IERC20(address(token)), config, source());
        NativeCashRangeMarket.ReferenceConfiguration memory ref = source();
        ref.chainId += 1;
        vm.expectRevert(NativeCashRangeMarket.InvalidConfiguration.selector);
        new NativeCashRangeMarket(IERC20(address(token)), configuration(), ref);
        ref = source();
        ref.oracleDecimals = 6;
        vm.expectRevert(NativeCashRangeMarket.InvalidConfiguration.selector);
        new NativeCashRangeMarket(IERC20(address(token)), configuration(), ref);
        ref = source();
        ref.allowMissingSequencer = false;
        vm.expectRevert(NativeCashRangeMarket.InvalidConfiguration.selector);
        new NativeCashRangeMarket(IERC20(address(token)), configuration(), ref);
    }

    function testSequencerDowntimeAndGracePeriodBlockReference() public {
        RangeReferenceFixture sequencer = new RangeReferenceFixture();
        NativeCashRangeMarket.ReferenceConfiguration memory ref = source();
        ref.sequencerFeed = address(sequencer);
        NativeCashRangeMarket protectedMarket = new NativeCashRangeMarket(IERC20(address(token)), configuration(), ref);
        sequencer.set(1, block.timestamp, 1, 1);
        vm.expectRevert(NativeCashRangeMarket.InvalidReference.selector);
        protectedMarket.previewMark();
        sequencer.set(0, block.timestamp, 1, 1);
        vm.expectRevert(NativeCashRangeMarket.InvalidReference.selector);
        protectedMarket.previewMark();
        vm.warp(block.timestamp + 3601);
        feed.set(3500e8, block.timestamp, 2, 2);
        (uint128 price,,,) = protectedMarket.previewMark();
        assertEq(price, 500_001);
    }

    function testFuzzEveryReferenceStaysInsideTheFullyCollateralizedRange(uint128 answer) public {
        vm.assume(answer > 0);
        feed.set(int256(uint256(answer)), block.timestamp, 1, 1);
        (uint128 price,,,) = market.previewMark();
        assertGe(price, 1);
        assertLe(price, 1_000_001);
        if (answer <= 3000e8) assertEq(price, 1);
        if (answer >= 4000e8) assertEq(price, 1_000_001);
    }

    function testFundedEntryAndPausedExitRealizeCashWithoutExternalPositions() public {
        NativePackageClearingHouse house = market.clearingHouse();
        bytes32 longId = keccak256("range-long");
        bytes32 shortId = keccak256("range-short");
        uint256 longKey = 101;
        uint256 shortKey = 202;
        token.mint(vm.addr(longKey), 2_000_000);
        token.mint(vm.addr(shortKey), 2_000_000);
        vm.startPrank(vm.addr(longKey));
        house.openAccount(longId);
        token.approve(address(house), 2_000_000);
        house.deposit(longId, 2_000_000);
        vm.stopPrank();
        vm.startPrank(vm.addr(shortKey));
        house.openAccount(shortId);
        token.approve(address(house), 2_000_000);
        house.deposit(shortId, 2_000_000);
        vm.stopPrank();
        market.refreshMark(keccak256("entry-mark"), 500_001, 1, uint64(block.timestamp + 600));
        house.setEntryPaused(false);
        NativePackageClearingHouse.NativeMatch memory trade = NativePackageClearingHouse.NativeMatch({
            authorizationHash: keccak256("range-entry"),
            longAccountId: longId,
            shortAccountId: shortId,
            feePayerAccountId: longId,
            longSequence: 1,
            shortSequence: 1,
            quantityAtoms: 1,
            priceTicks: 500_001,
            maxFeeBps: 0,
            expiry: uint64(block.timestamp + 60)
        });
        house.executeMatch(
            trade, signature(longKey, house.matchDigest(trade)), signature(shortKey, house.matchDigest(trade))
        );
        assertEq(house.account(longId).positionAtoms, 1);
        assertEq(house.account(shortId).positionAtoms, -1);
        feed.set(5000e8, block.timestamp, 2, 2);
        market.refreshMark(keccak256("exit-mark"), 1_000_001, 2, uint64(block.timestamp + 600));
        house.setEntryPaused(true);
        trade = NativePackageClearingHouse.NativeMatch({
            authorizationHash: keccak256("range-exit"),
            longAccountId: shortId,
            shortAccountId: longId,
            feePayerAccountId: shortId,
            longSequence: 2,
            shortSequence: 2,
            quantityAtoms: 1,
            priceTicks: 1_000_001,
            maxFeeBps: 0,
            expiry: uint64(block.timestamp + 60)
        });
        house.executeMatch(
            trade, signature(shortKey, house.matchDigest(trade)), signature(longKey, house.matchDigest(trade))
        );
        assertEq(house.openInterestAtoms(), 0);
        vm.startPrank(vm.addr(longKey));
        house.normalizeFlatAccount(longId);
        house.withdraw(longId, 2_500_000);
        vm.stopPrank();
        vm.startPrank(vm.addr(shortKey));
        house.normalizeFlatAccount(shortId);
        house.withdraw(shortId, 1_500_000);
        vm.stopPrank();
        assertEq(token.balanceOf(address(house)), 0);
        assertEq(token.balanceOf(vm.addr(longKey)) + token.balanceOf(vm.addr(shortKey)), 4_000_000);
        bytes32 digest = house.matchDigest(trade);
        bytes memory longSignature = signature(shortKey, digest);
        bytes memory shortSignature = signature(longKey, digest);
        vm.expectRevert(NativePackageClearingHouse.Replay.selector);
        house.executeMatch(trade, longSignature, shortSignature);
    }

    function signature(uint256 key, bytes32 digest) private pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {NaryxBaseSepoliaPerpTestSupport} from "../src/conformance/NaryxBaseSepoliaPerpTestSupport.sol";
import {ISynFuturesInstrument} from "../src/interfaces/ISynFuturesInstrument.sol";
import {ISynFuturesPositionObserver} from "../src/interfaces/ISynFuturesPositionObserver.sol";

contract NaryxPerpTradeHarness {
    NaryxBaseSepoliaPerpTestSupport public venue;
    uint256 public marker;

    function setVenue(NaryxBaseSepoliaPerpTestSupport venue_) external {
        require(address(venue) == address(0), "venue already set");
        venue = venue_;
    }

    function trade(bytes32[2] calldata args) external returns (ISynFuturesInstrument.PositionCache memory position) {
        marker += 1;
        return venue.trade(args);
    }
}

contract NaryxBaseSepoliaPerpTestSupportTest is Test {
    uint32 private constant EXPIRY = 4_102_444_800;
    uint128 private constant ENTRY_PRICE = 2_000e18;
    uint128 private constant MAXIMUM_SIZE = 10e18;
    uint128 private constant MAXIMUM_BALANCE = 100_000e18;

    address private owner;
    address private stranger;
    NaryxPerpTradeHarness private harness;
    NaryxBaseSepoliaPerpTestSupport private venue;

    function setUp() public {
        vm.chainId(31_338);
        owner = makeAddr("owner");
        stranger = makeAddr("stranger");
        harness = new NaryxPerpTradeHarness();
        venue = new NaryxBaseSepoliaPerpTestSupport(
            owner, address(harness), EXPIRY, ENTRY_PRICE, MAXIMUM_SIZE, MAXIMUM_BALANCE
        );
        harness.setVenue(venue);
    }

    function testEntryRecordsExactObserverStateAndReturnData() public {
        int128 size = -2e18;
        int128 balance = 4_000e18;

        ISynFuturesInstrument.PositionCache memory returned = harness.trade(_tradeArgs(size, balance));
        ISynFuturesPositionObserver.Position memory observed =
            venue.getPosition(address(venue), EXPIRY, address(harness));

        assertEq(returned.balance, balance);
        assertEq(returned.size, size);
        assertEq(returned.entryNotional, 4_000e18);
        assertEq(returned.entrySocialLossIndex, 0);
        assertEq(returned.entryFundingIndex, 0);
        assertEq(observed.balance, balance);
        assertEq(observed.size, size);
        assertEq(observed.entryNotional, 4_000e18);
        assertEq(observed.entrySocialLossIndex, 0);
        assertEq(observed.entryFundingIndex, 0);
    }

    function testExactCloseClearsObserverState() public {
        harness.trade(_tradeArgs(-2e18, 4_000e18));

        ISynFuturesInstrument.PositionCache memory returned = harness.trade(_tradeArgs(2e18, -4_000e18));
        ISynFuturesPositionObserver.Position memory observed =
            venue.getPosition(address(venue), EXPIRY, address(harness));

        assertEq(returned.balance, 0);
        assertEq(returned.size, 0);
        assertEq(returned.entryNotional, 0);
        assertEq(observed.balance, 0);
        assertEq(observed.size, 0);
        assertEq(observed.entryNotional, 0);
    }

    function testRejectsInexactCloseWithoutChangingPosition() public {
        harness.trade(_tradeArgs(-2e18, 4_000e18));

        vm.expectRevert(NaryxBaseSepoliaPerpTestSupport.InvalidTrade.selector);
        harness.trade(_tradeArgs(1e18, -2_000e18));

        ISynFuturesPositionObserver.Position memory observed =
            venue.getPosition(address(venue), EXPIRY, address(harness));
        assertEq(observed.balance, 4_000e18);
        assertEq(observed.size, -2e18);
        assertEq(observed.entryNotional, 4_000e18);
    }

    function testRejectsEntryOutsideConfiguredSizeOrBalanceBounds() public {
        vm.expectRevert(NaryxBaseSepoliaPerpTestSupport.InvalidTrade.selector);
        harness.trade(_tradeArgs(-int128(MAXIMUM_SIZE + 1), 4_000e18));

        vm.expectRevert(NaryxBaseSepoliaPerpTestSupport.InvalidTrade.selector);
        harness.trade(_tradeArgs(-2e18, int128(MAXIMUM_BALANCE + 1)));
    }

    function testForcedRejectionRollsBackCallerAndVenueState() public {
        vm.prank(owner);
        venue.setForcedRejection(true);

        vm.expectRevert(NaryxBaseSepoliaPerpTestSupport.ForcedRejection.selector);
        harness.trade(_tradeArgs(-2e18, 4_000e18));

        assertEq(harness.marker(), 0);
        ISynFuturesPositionObserver.Position memory observed =
            venue.getPosition(address(venue), EXPIRY, address(harness));
        assertEq(observed.balance, 0);
        assertEq(observed.size, 0);
        assertEq(observed.entryNotional, 0);
    }

    function testRejectsWrongCallerAndNonOwnerFaultControl() public {
        vm.prank(stranger);
        vm.expectRevert(NaryxBaseSepoliaPerpTestSupport.UnauthorizedCaller.selector);
        venue.trade(_tradeArgs(-2e18, 4_000e18));

        vm.prank(stranger);
        vm.expectRevert(NaryxBaseSepoliaPerpTestSupport.UnauthorizedCaller.selector);
        venue.setForcedRejection(true);
    }

    function testRejectsWrongDeploymentAndRuntimeChains() public {
        vm.chainId(31_337);
        vm.expectRevert(NaryxBaseSepoliaPerpTestSupport.InvalidChain.selector);
        new NaryxBaseSepoliaPerpTestSupport(owner, address(harness), EXPIRY, ENTRY_PRICE, MAXIMUM_SIZE, MAXIMUM_BALANCE);

        vm.chainId(84_532);
        vm.expectRevert(NaryxBaseSepoliaPerpTestSupport.InvalidChain.selector);
        venue.getPosition(address(venue), EXPIRY, address(harness));
    }

    function testRejectsExpiredOrMismatchedTradeHeader() public {
        bytes32[2] memory expired = _tradeArgs(-2e18, 4_000e18);
        expired[0] = bytes32(uint256(block.timestamp) << 56 | uint256(EXPIRY));
        vm.expectRevert(NaryxBaseSepoliaPerpTestSupport.InvalidTrade.selector);
        harness.trade(expired);

        bytes32[2] memory wrongExpiry = _tradeArgs(-2e18, 4_000e18);
        wrongExpiry[0] = bytes32(uint256(block.timestamp + 1 hours) << 56 | uint256(EXPIRY - 1));
        vm.expectRevert(NaryxBaseSepoliaPerpTestSupport.InvalidTrade.selector);
        harness.trade(wrongExpiry);
    }

    function _tradeArgs(int128 sizeDelta, int128 balanceDelta) private view returns (bytes32[2] memory args) {
        args[0] = bytes32(uint256(block.timestamp + 1 hours) << 56 | uint256(EXPIRY));
        args[1] = bytes32(uint256(uint128(sizeDelta)) << 128 | uint256(uint128(balanceDelta)));
    }
}

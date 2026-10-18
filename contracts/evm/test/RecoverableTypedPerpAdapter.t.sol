// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {RecoverableTypedPerpAdapter} from "../src/RecoverableTypedPerpAdapter.sol";
import {ISynFuturesPositionObserver} from "../src/interfaces/ISynFuturesPositionObserver.sol";
import {TypedAdapterToken, TypedAdapterAccountHarness, TypedAdapterPerpVenue} from "./TypedStrategyAdapters.t.sol";

contract RecoverableTypedPerpAdapterTest is Test {
    TypedAdapterToken private base;
    TypedAdapterToken private quote;
    TypedAdapterAccountHarness private account;
    TypedAdapterPerpVenue private venue;
    RecoverableTypedPerpAdapter private adapter;
    bytes32 private constant PACKAGE = keccak256("recovery-package");

    function setUp() public {
        base = new TypedAdapterToken("Base", "BASE");
        quote = new TypedAdapterToken("Quote", "QUOTE");
        account = new TypedAdapterAccountHarness();
        venue = new TypedAdapterPerpVenue(quote, 1_900_000_000);
        adapter = new RecoverableTypedPerpAdapter(RecoverableTypedPerpAdapter.Deployment({
            chainId: block.chainid, adapterClassId: keccak256("naryx.evm.perp-recoverable"),
            strategyAccount: address(account), packageId: PACKAGE, baseToken: base, collateralToken: quote,
            instrument: venue, observer: venue, marginGate: venue, expiry: 1_900_000_000,
            strategyAccountCodeHash: address(account).codehash, baseTokenCodeHash: address(base).codehash,
            collateralTokenCodeHash: address(quote).codehash, instrumentCodeHash: address(venue).codehash,
            observerCodeHash: address(venue).codehash, marginGateCodeHash: address(venue).codehash
        }));
        quote.mint(address(account), 1_000 ether);
    }

    function entry(uint64 generation) private pure returns (bytes memory) {
        RecoverableTypedPerpAdapter.ExactPerpLeg memory leg;
        ISynFuturesPositionObserver.Position memory empty;
        leg.packageId = PACKAGE;
        leg.orderHash = keccak256("entry-order");
        leg.quoteHash = keccak256("entry-quote");
        leg.routeHash = keccak256("entry-route");
        leg.expectedPrePositionHash = keccak256(abi.encode(empty));
        leg.tradeArgs[1] = bytes32((uint256(uint128(10)) << 128) | uint128(50 ether));
        leg.expectedPostSizeWad = 10;
        leg.minimumPostBalanceWad = 50 ether;
        leg.maximumPostBalanceWad = 50 ether;
        leg.minimumPostEntryNotionalWad = 20;
        leg.maximumPostEntryNotionalWad = 20;
        leg.minimumReserveAfterAtoms = 50 ether;
        leg.maximumReserveAfterAtoms = 50 ether;
        leg.collateralInAtoms = 100 ether;
        return abi.encode(uint8(1), generation, leg);
    }

    function close(bytes memory opening, uint64 generation, uint256 minimum)
        private pure returns (RecoverableTypedPerpAdapter.RecoveryClose memory leg)
    {
        leg.packageId = PACKAGE;
        leg.orderHash = keccak256("recovery-order");
        leg.quoteHash = keccak256("recovery-quote");
        leg.routeHash = keccak256("recovery-route");
        leg.generation = generation;
        leg.entryPayloadHash = keccak256(opening);
        leg.expectedSizeWad = 10;
        leg.tradeArgs[1] = bytes32(uint256(uint128(int128(-10))) << 128);
        leg.minimumCollateralOutAtoms = minimum;
        leg.maximumCollateralOutAtoms = 100 ether;
    }

    function testRecoveryCanBeCommittedBeforeEntryAndCannotReplayAgainstLaterEntry() public {
        bytes memory opening = entry(1);
        bytes memory recovery = abi.encode(uint8(2), close(opening, 1, 100 ether));
        assertTrue(adapter.isRiskIncreasing(opening));
        assertFalse(adapter.isRiskIncreasing(recovery));
        account.execute(adapter, quote, 100 ether, opening);
        assertEq(adapter.entryPayloadHash(), keccak256(opening));
        account.execute(adapter, quote, 0, recovery);
        assertEq(adapter.position().size, 0);
        assertEq(venue.reserveOf(address(adapter)), 0);
        assertEq(quote.balanceOf(address(account)), 1_000 ether);
        assertEq(quote.allowance(address(account), address(adapter)), 0);
        assertEq(quote.allowance(address(adapter), address(venue)), 0);
        vm.expectRevert(RecoverableTypedPerpAdapter.PreconditionFailed.selector);
        account.execute(adapter, quote, 0, recovery);
        account.execute(adapter, quote, 100 ether, entry(2));
        vm.expectRevert(RecoverableTypedPerpAdapter.PreconditionFailed.selector);
        account.execute(adapter, quote, 0, recovery);
    }

    function testFundingChangesDoNotInvalidateRecoveryButLossLimitIsEnforced() public {
        bytes memory opening = entry(1);
        account.execute(adapter, quote, 100 ether, opening);
        bytes32 slot = keccak256(abi.encode(address(adapter), uint256(1)));
        vm.store(address(venue), slot, bytes32((uint256(uint128(10)) << 128) | uint128(45 ether)));
        assertEq(adapter.position().balance, 45 ether);
        vm.expectRevert(RecoverableTypedPerpAdapter.PostconditionFailed.selector);
        account.execute(adapter, quote, 0, abi.encode(uint8(2), close(opening, 1, 99 ether)));
        assertEq(adapter.entryPayloadHash(), keccak256(opening));
        assertEq(adapter.position().size, 10);
        account.execute(adapter, quote, 0, abi.encode(uint8(2), close(opening, 1, 90 ether)));
        assertEq(quote.balanceOf(address(account)), 995 ether);
        assertEq(adapter.position().size, 0);
        assertEq(venue.reserveOf(address(adapter)), 0);
    }

    function testRecoveryRejectsForeignEntryWrongSizeAndPartialClose() public {
        bytes memory opening = entry(1);
        account.execute(adapter, quote, 100 ether, opening);
        RecoverableTypedPerpAdapter.RecoveryClose memory recovery = close(opening, 1, 100 ether);
        recovery.entryPayloadHash = keccak256("other-entry");
        vm.expectRevert(RecoverableTypedPerpAdapter.PreconditionFailed.selector);
        account.execute(adapter, quote, 0, abi.encode(uint8(2), recovery));
        recovery = close(opening, 1, 100 ether);
        recovery.expectedSizeWad = 9;
        vm.expectRevert(RecoverableTypedPerpAdapter.PreconditionFailed.selector);
        account.execute(adapter, quote, 0, abi.encode(uint8(2), recovery));
        recovery = close(opening, 1, 100 ether);
        recovery.tradeArgs[1] = bytes32(uint256(uint128(int128(-9))) << 128);
        vm.expectRevert();
        account.execute(adapter, quote, 0, abi.encode(uint8(2), recovery));
        assertEq(adapter.position().size, 10);
        recovery = close(opening, 1, 0);
        vm.expectRevert(RecoverableTypedPerpAdapter.PreconditionFailed.selector);
        account.execute(adapter, quote, 0, abi.encode(uint8(2), recovery));
    }

    function testRecoveryRejectsUnauthorizedCallsAndChangedDeployment() public {
        bytes memory opening = entry(1);
        vm.expectRevert(RecoverableTypedPerpAdapter.UnauthorizedCaller.selector);
        adapter.executeLeg(opening);
        account.execute(adapter, quote, 100 ether, opening);
        vm.chainId(block.chainid + 1);
        vm.expectRevert(RecoverableTypedPerpAdapter.DeploymentChanged.selector);
        account.execute(adapter, quote, 0, abi.encode(uint8(2), close(opening, 1, 100 ether)));
    }

    function testLiquidatedPositionRequiresNewCleanupBoundsAndReleasesItsReserve() public {
        bytes memory opening = entry(1);
        account.execute(adapter, quote, 100 ether, opening);
        bytes32 slot = keccak256(abi.encode(address(adapter), uint256(1)));
        vm.store(address(venue), slot, bytes32(0));
        vm.store(address(venue), bytes32(uint256(slot) + 1), bytes32(0));
        vm.store(address(venue), bytes32(uint256(slot) + 2), bytes32(0));
        vm.expectRevert(RecoverableTypedPerpAdapter.PreconditionFailed.selector);
        account.execute(adapter, quote, 0, abi.encode(uint8(2), close(opening, 1, 100 ether)));
        RecoverableTypedPerpAdapter.RecoveryClose memory cleanup = close(opening, 1, 50 ether);
        cleanup.expectedSizeWad = 0;
        cleanup.tradeArgs[1] = bytes32(0);
        account.execute(adapter, quote, 0, abi.encode(uint8(2), cleanup));
        assertEq(quote.balanceOf(address(account)), 950 ether);
        assertEq(venue.reserveOf(address(adapter)), 0);
        assertEq(adapter.entryPayloadHash(), bytes32(0));
        vm.expectRevert(RecoverableTypedPerpAdapter.PreconditionFailed.selector);
        account.execute(adapter, quote, 0, abi.encode(uint8(2), cleanup));
        account.execute(adapter, quote, 100 ether, entry(2));
        assertEq(adapter.generation(), 2);
    }

    function testPartialLiquidationCanCloseOnlyItsCurrentSameDirectionRemainder() public {
        bytes memory opening = entry(1);
        account.execute(adapter, quote, 100 ether, opening);
        bytes32 slot = keccak256(abi.encode(address(adapter), uint256(1)));
        RecoverableTypedPerpAdapter.RecoveryClose memory cleanup = close(opening, 1, 75 ether);
        cleanup.expectedSizeWad = 5;
        cleanup.tradeArgs[1] = bytes32(uint256(uint128(int128(-5))) << 128);
        vm.store(address(venue), slot, bytes32((uint256(uint128(11)) << 128) | uint128(25 ether)));
        vm.expectRevert(RecoverableTypedPerpAdapter.PreconditionFailed.selector);
        account.execute(adapter, quote, 0, abi.encode(uint8(2), cleanup));
        vm.store(address(venue), slot, bytes32((uint256(uint128(5)) << 128) | uint128(25 ether)));
        vm.expectRevert(RecoverableTypedPerpAdapter.PreconditionFailed.selector);
        account.execute(adapter, quote, 0, abi.encode(uint8(2), close(opening, 1, 100 ether)));
        account.execute(adapter, quote, 0, abi.encode(uint8(2), cleanup));
        assertEq(adapter.position().size, 0);
        assertEq(venue.reserveOf(address(adapter)), 0);
        assertEq(quote.balanceOf(address(account)), 975 ether);
    }
}

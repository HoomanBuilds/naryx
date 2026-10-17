// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "openzeppelin-contracts/token/ERC20/IERC20.sol";
import {NativeCashStandingMaker} from "../src/NativeCashStandingMaker.sol";
import {NativeCashRangeMarket} from "../src/NativeCashRangeMarket.sol";
import {NativePackageClearingHouse} from "../src/NativePackageClearingHouse.sol";
import {NaryxTestUSDC} from "../src/conformance/NaryxTestUSDC.sol";
import {RangeReferenceFixture} from "./NativeCashRangeMarket.t.sol";

contract NativeCashStandingMakerTest is Test {
    NativeCashStandingMaker private maker;
    NativeCashRangeMarket private controller;
    NativePackageClearingHouse private house;
    NaryxTestUSDC private token;
    RangeReferenceFixture private feed;
    uint256 private constant USER_KEY = 91;
    bytes32 private constant MAKER_ID = keccak256("standing-maker");
    bytes32 private constant USER_ID = keccak256("standing-user");

    function setUp() public {
        vm.warp(10_000);
        feed = new RangeReferenceFixture();
        token = new NaryxTestUSDC();
        NativePackageClearingHouse.Configuration memory cfg = NativePackageClearingHouse.Configuration({
            policyHash: keccak256("standing-policy"),
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
        NativeCashRangeMarket.ReferenceConfiguration memory source = NativeCashRangeMarket.ReferenceConfiguration({
            chainId: block.chainid,
            oracle: address(feed),
            sequencerFeed: address(0),
            markUpdater: address(this),
            lowerBound: 3000e8,
            upperBound: 4000e8,
            underlyingAtomsPerPackage: 1e15,
            maximumOracleAgeSeconds: 3600,
            sequencerGracePeriodSeconds: 0,
            oracleDecimals: 8,
            underlyingDecimals: 18,
            allowMissingSequencer: true
        });
        controller = new NativeCashRangeMarket(IERC20(address(token)), cfg, source);
        house = controller.clearingHouse();
        (uint128 price,,, uint64 until) = controller.previewMark();
        controller.refreshMark(keccak256("mark"), price, 1, until);
        house.setEntryPaused(false);
        maker = new NativeCashStandingMaker(controller, MAKER_ID, address(this), 10);
        token.mint(address(this), 10_000_000);
        token.approve(address(maker), 10_000_000);
        maker.fund(10_000_000);
        maker.setEnabled(true);
        address user = vm.addr(USER_KEY);
        token.mint(user, 10_000_000);
        vm.startPrank(user);
        house.openAccount(USER_ID);
        token.approve(address(house), 10_000_000);
        house.deposit(USER_ID, 10_000_000);
        vm.stopPrank();
    }

    function terms(bool buy, uint128 price) private view returns (NativePackageClearingHouse.NativeMatch memory) {
        return NativePackageClearingHouse.NativeMatch({
            authorizationHash: keccak256(abi.encode(buy, house.account(USER_ID).sequence)),
            longAccountId: buy ? USER_ID : MAKER_ID,
            shortAccountId: buy ? MAKER_ID : USER_ID,
            feePayerAccountId: USER_ID,
            longSequence: house.account(buy ? USER_ID : MAKER_ID).sequence,
            shortSequence: house.account(buy ? MAKER_ID : USER_ID).sequence,
            quantityAtoms: 1,
            priceTicks: price,
            maxFeeBps: 0,
            expiry: uint64(block.timestamp + 20)
        });
    }

    function execute(NativePackageClearingHouse.NativeMatch memory match_, bool buy) private {
        bytes32 digest = house.matchDigest(match_);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(USER_KEY, digest);
        bytes memory userSignature = abi.encodePacked(r, s, v);
        bytes memory makerSignature = abi.encode(match_);
        house.executeMatch(match_, buy ? userSignature : makerSignature, buy ? makerSignature : userSignature);
    }

    function testFundedStandingBookExecutesAndPausedMakerStillQuotesExit() public {
        (uint128 bid, uint128 ask, uint128 bidSize, uint128 askSize,) = maker.book();
        assertGt(bidSize, 0);
        assertGt(askSize, 0);
        assertLt(bid, ask);
        execute(terms(true, ask), true);
        assertEq(house.account(USER_ID).positionAtoms, 1);
        maker.setEnabled(false);
        (bid,, bidSize, askSize,) = maker.book();
        assertEq(bidSize, 1);
        assertEq(askSize, 0);
        execute(terms(false, bid), false);
        assertEq(house.account(USER_ID).positionAtoms, 0);
        assertEq(house.account(MAKER_ID).positionAtoms, 0);
        assertEq(house.account(USER_ID).cashBalanceQuoteAtoms + house.account(MAKER_ID).cashBalanceQuoteAtoms, 0);
        maker.withdraw(1_000_000);
        assertEq(token.balanceOf(address(this)), 1_000_000);
    }

    function testInvalidPriceReplayAndUnauthorizedWithdrawalFailClosed() public {
        (, uint128 ask,,,) = maker.book();
        NativePackageClearingHouse.NativeMatch memory bad = terms(true, ask - 1);
        assertEq(maker.isValidSignature(house.matchDigest(bad), abi.encode(bad)), bytes4(0xffffffff));
        NativePackageClearingHouse.NativeMatch memory good = terms(true, ask);
        execute(good, true);
        bytes32 digest = house.matchDigest(good);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(USER_KEY, digest);
        bytes memory signature = abi.encodePacked(r, s, v);
        vm.expectRevert(NativePackageClearingHouse.Replay.selector);
        house.executeMatch(good, signature, abi.encode(good));
        vm.expectRevert(NativeCashStandingMaker.InventoryIsActive.selector);
        maker.withdraw(1);
        vm.prank(vm.addr(USER_KEY));
        vm.expectRevert();
        maker.setEnabled(false);
        vm.warp(block.timestamp + 601);
        vm.expectRevert();
        maker.book();
    }
}

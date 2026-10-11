// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "openzeppelin-contracts/token/ERC20/IERC20.sol";
import {NaryxTestUSDC} from "../src/conformance/NaryxTestUSDC.sol";
import {NativePackageClearingHouse} from "../src/NativePackageClearingHouse.sol";

contract NativePackageClearingHouseTest is Test {
    uint256 private constant LONG_KEY = 0xA11CE;
    uint256 private constant SHORT_KEY = 0xB0B;
    uint256 private constant BACKSTOP_KEY = 0xCAFE;
    bytes32 private constant LONG_ACCOUNT = keccak256("long-account");
    bytes32 private constant SHORT_ACCOUNT = keccak256("short-account");
    bytes32 private constant BACKSTOP_ACCOUNT = keccak256("backstop-account");

    NaryxTestUSDC private token;
    NativePackageClearingHouse private clearing;

    function setUp() public {
        token = new NaryxTestUSDC();
        NativePackageClearingHouse.Configuration memory configuration = NativePackageClearingHouse.Configuration({
            policyHash: keccak256("policy"),
            governor: address(this),
            pauser: address(this),
            markAuthority: address(this),
            packageQuantityIncrementAtoms: 1,
            priceTickQuoteAtoms: 1_000,
            initialMarginQuoteAtomsPerIncrement: 20_000,
            maintenanceMarginQuoteAtomsPerIncrement: 10_000,
            maximumPositionAtoms: 10,
            maximumOpenInterestAtoms: 100,
            maximumDefaultTransferDiscountBps: 1_000,
            markMaximumStalenessSeconds: 600,
            defaultAuctionDurationSeconds: 60,
            feeUpdateDelaySeconds: 30,
            maximumFeeBps: 100
        });
        clearing = new NativePackageClearingHouse(IERC20(address(token)), configuration);
        _openAndFund(LONG_KEY, LONG_ACCOUNT, 1_000_000);
        _openAndFund(SHORT_KEY, SHORT_ACCOUNT, 1_000_000);
        _openAndFund(BACKSTOP_KEY, BACKSTOP_ACCOUNT, 1_000_000);
        clearing.publishMark(keccak256("mark-1"), 100, 1, uint64(block.timestamp + 600));
        clearing.setEntryPaused(false);
    }

    function testRejectsAFeeCeilingAboveTheHardMaximum() public {
        NativePackageClearingHouse.Configuration memory configuration = NativePackageClearingHouse.Configuration({
            policyHash: keccak256("policy"),
            governor: address(this),
            pauser: address(this),
            markAuthority: address(this),
            packageQuantityIncrementAtoms: 1,
            priceTickQuoteAtoms: 1_000,
            initialMarginQuoteAtomsPerIncrement: 20_000,
            maintenanceMarginQuoteAtomsPerIncrement: 10_000,
            maximumPositionAtoms: 10,
            maximumOpenInterestAtoms: 100,
            maximumDefaultTransferDiscountBps: 1_000,
            markMaximumStalenessSeconds: 600,
            defaultAuctionDurationSeconds: 60,
            feeUpdateDelaySeconds: 30,
            maximumFeeBps: 1_001
        });
        vm.expectRevert(NativePackageClearingHouse.InvalidConfiguration.selector);
        new NativePackageClearingHouse(IERC20(address(token)), configuration);
        configuration.maximumFeeBps = 1_000;
        new NativePackageClearingHouse(IERC20(address(token)), configuration);
    }

    function testRejectsTheClearingHouseAsItsOwnFeeRecipient() public {
        vm.expectRevert(NativePackageClearingHouse.InvalidConfiguration.selector);
        clearing.scheduleFeeUpdate(10, address(clearing));
        clearing.scheduleFeeUpdate(10, address(this));
    }

    function testExecutesOwnerSignedMatchAndChargesDelayedFee() public {
        clearing.scheduleFeeUpdate(10, address(this));
        vm.warp(block.timestamp + 30);
        clearing.activateFeeUpdate();
        NativePackageClearingHouse.NativeMatch memory match_ = _match(keccak256("authorization-1"));
        bytes32 digest = clearing.matchDigest(match_);
        bytes memory longSignature = _sign(LONG_KEY, digest);
        bytes memory shortSignature = _sign(SHORT_KEY, digest);

        clearing.executeMatch(match_, longSignature, shortSignature);

        NativePackageClearingHouse.Account memory long = clearing.account(LONG_ACCOUNT);
        NativePackageClearingHouse.Account memory short = clearing.account(SHORT_ACCOUNT);
        assertEq(long.positionAtoms, 1);
        assertEq(short.positionAtoms, -1);
        assertEq(long.cashBalanceQuoteAtoms, -100_000);
        assertEq(short.cashBalanceQuoteAtoms, 100_000);
        assertEq(long.collateralQuoteAtoms, 999_900);
        assertEq(clearing.accruedProtocolFees(), 100);
        assertEq(clearing.openInterestAtoms(), 1);

        vm.expectRevert(NativePackageClearingHouse.Replay.selector);
        clearing.executeMatch(match_, longSignature, shortSignature);
    }

    function testSettlesDefaultThroughBoundedAuctionAndReserve() public {
        vm.prank(vm.addr(LONG_KEY));
        clearing.withdraw(LONG_ACCOUNT, 975_000);
        NativePackageClearingHouse.NativeMatch memory match_ = _match(keccak256("authorization-2"));
        clearing.executeMatch(
            match_, _sign(LONG_KEY, clearing.matchDigest(match_)), _sign(SHORT_KEY, clearing.matchDigest(match_))
        );
        clearing.publishMark(keccak256("mark-2"), 1, 2, uint64(block.timestamp + 600));
        token.mint(address(this), 100_000);
        token.approve(address(clearing), 100_000);
        clearing.fundRecoveryReserve(100_000);

        bytes32 auctionId = keccak256("auction-1");
        clearing.openDefaultAuction(auctionId, LONG_ACCOUNT);
        vm.prank(vm.addr(BACKSTOP_KEY));
        clearing.bidDefaultAuction(auctionId, BACKSTOP_ACCOUNT, 1, uint64(block.timestamp + 600));
        clearing.publishMark(keccak256("mark-2-current"), 2, 3, uint64(block.timestamp + 600));
        vm.warp(block.timestamp + 60);
        clearing.settleDefaultAuction(auctionId);

        NativePackageClearingHouse.Account memory defaulted = clearing.account(LONG_ACCOUNT);
        NativePackageClearingHouse.Account memory backstop = clearing.account(BACKSTOP_ACCOUNT);
        assertEq(defaulted.positionAtoms, 0);
        assertEq(defaulted.cashBalanceQuoteAtoms, 0);
        assertEq(defaulted.collateralQuoteAtoms, 0);
        assertEq(backstop.positionAtoms, 1);
        assertEq(clearing.openInterestAtoms(), 1);
        assertEq(clearing.recoveryReserveQuoteAtoms(), 26_000);
        assertEq(clearing.accountLock(LONG_ACCOUNT), bytes32(0));
        assertEq(clearing.accountLock(BACKSTOP_ACCOUNT), bytes32(0));
    }

    function testExpiredAuctionCanBeUnlockedWithoutSettlement() public {
        vm.prank(vm.addr(LONG_KEY));
        clearing.withdraw(LONG_ACCOUNT, 975_000);
        NativePackageClearingHouse.NativeMatch memory match_ = _match(keccak256("authorization-3"));
        clearing.executeMatch(
            match_, _sign(LONG_KEY, clearing.matchDigest(match_)), _sign(SHORT_KEY, clearing.matchDigest(match_))
        );
        clearing.publishMark(keccak256("mark-3"), 1, 2, uint64(block.timestamp + 60));
        bytes32 auctionId = keccak256("auction-2");
        clearing.openDefaultAuction(auctionId, LONG_ACCOUNT);

        vm.warp(block.timestamp + 61);
        clearing.cancelExpiredDefaultAuction(auctionId);

        assertEq(clearing.accountLock(LONG_ACCOUNT), bytes32(0));
    }

    function testFlatAccountCannotWithdrawCollateralBackingRealizedLoss() public {
        NativePackageClearingHouse.NativeMatch memory open_ = _match(keccak256("authorization-4"));
        clearing.executeMatch(
            open_, _sign(LONG_KEY, clearing.matchDigest(open_)), _sign(SHORT_KEY, clearing.matchDigest(open_))
        );
        NativePackageClearingHouse.NativeMatch memory close_ = NativePackageClearingHouse.NativeMatch({
            authorizationHash: keccak256("authorization-5"),
            longAccountId: SHORT_ACCOUNT,
            shortAccountId: LONG_ACCOUNT,
            feePayerAccountId: SHORT_ACCOUNT,
            longSequence: clearing.account(SHORT_ACCOUNT).sequence,
            shortSequence: clearing.account(LONG_ACCOUNT).sequence,
            quantityAtoms: 1,
            priceTicks: 50,
            maxFeeBps: 0,
            expiry: uint64(block.timestamp + 300)
        });
        clearing.executeMatch(
            close_, _sign(SHORT_KEY, clearing.matchDigest(close_)), _sign(LONG_KEY, clearing.matchDigest(close_))
        );
        NativePackageClearingHouse.Account memory long = clearing.account(LONG_ACCOUNT);
        assertEq(long.positionAtoms, 0);
        assertEq(long.cashBalanceQuoteAtoms, -50_000);

        vm.startPrank(vm.addr(LONG_KEY));
        vm.expectRevert(NativePackageClearingHouse.MarginViolation.selector);
        clearing.withdraw(LONG_ACCOUNT, 950_001);
        clearing.withdraw(LONG_ACCOUNT, 950_000);
        vm.stopPrank();
        assertEq(clearing.account(LONG_ACCOUNT).collateralQuoteAtoms, 50_000);
    }

    function testRejectsMatchSignedBelowActiveFee() public {
        clearing.scheduleFeeUpdate(11, address(this));
        vm.warp(block.timestamp + 30);
        clearing.activateFeeUpdate();
        NativePackageClearingHouse.NativeMatch memory match_ = _match(keccak256("authorization-6"));
        bytes32 digest = clearing.matchDigest(match_);

        vm.expectRevert(NativePackageClearingHouse.InvalidMatch.selector);
        clearing.executeMatch(match_, _sign(LONG_KEY, digest), _sign(SHORT_KEY, digest));
    }

    function testLiquidatesSolventAccountBelowMaintenance() public {
        _openUnderMarginedLong(keccak256("authorization-7"));
        bytes32 auctionId = keccak256("auction-3");
        clearing.publishMark(keccak256("mark-at-maintenance"), 85, 2, uint64(block.timestamp + 600));
        assertEq(clearing.accountStatus(LONG_ACCOUNT), 2);
        vm.expectRevert(NativePackageClearingHouse.InvalidAuction.selector);
        clearing.openDefaultAuction(auctionId, LONG_ACCOUNT);

        clearing.publishMark(keccak256("mark-below-maintenance"), 84, 3, uint64(block.timestamp + 600));
        assertEq(clearing.accountStatus(LONG_ACCOUNT), 3);
        clearing.openDefaultAuction(auctionId, LONG_ACCOUNT);
        vm.prank(vm.addr(BACKSTOP_KEY));
        clearing.bidDefaultAuction(auctionId, BACKSTOP_ACCOUNT, 84, uint64(block.timestamp + 600));
        vm.warp(block.timestamp + 60);
        clearing.settleDefaultAuction(auctionId);

        NativePackageClearingHouse.Account memory defaulted = clearing.account(LONG_ACCOUNT);
        assertEq(defaulted.positionAtoms, 0);
        assertEq(defaulted.collateralQuoteAtoms, 9_000);
        assertEq(defaulted.cashBalanceQuoteAtoms, 0);
        assertEq(clearing.account(BACKSTOP_ACCOUNT).positionAtoms, 1);
    }

    function testBidMustStayLiveThroughSettlementWindow() public {
        _openUnderMarginedLong(keccak256("authorization-8"));
        clearing.publishMark(keccak256("mark-default"), 84, 2, uint64(block.timestamp + 600));
        bytes32 auctionId = keccak256("auction-4");
        clearing.openDefaultAuction(auctionId, LONG_ACCOUNT);
        NativePackageClearingHouse.DefaultAuction memory opened = clearing.auction(auctionId);

        vm.startPrank(vm.addr(BACKSTOP_KEY));
        vm.expectRevert(NativePackageClearingHouse.InvalidAuction.selector);
        clearing.bidDefaultAuction(auctionId, BACKSTOP_ACCOUNT, 84, opened.closeAt);
        vm.expectRevert(NativePackageClearingHouse.InvalidAuction.selector);
        clearing.bidDefaultAuction(auctionId, BACKSTOP_ACCOUNT, 84, opened.markValidUntil - 1);
        clearing.bidDefaultAuction(auctionId, BACKSTOP_ACCOUNT, 84, opened.markValidUntil);
        vm.stopPrank();

        vm.warp(opened.closeAt + 1);
        clearing.settleDefaultAuction(auctionId);
        assertTrue(clearing.auction(auctionId).settled);
    }

    function _openUnderMarginedLong(bytes32 authorizationHash) private {
        vm.prank(vm.addr(LONG_KEY));
        clearing.withdraw(LONG_ACCOUNT, 975_000);
        NativePackageClearingHouse.NativeMatch memory match_ = _match(authorizationHash);
        clearing.executeMatch(
            match_, _sign(LONG_KEY, clearing.matchDigest(match_)), _sign(SHORT_KEY, clearing.matchDigest(match_))
        );
    }

    function _match(bytes32 authorizationHash) private view returns (NativePackageClearingHouse.NativeMatch memory) {
        return NativePackageClearingHouse.NativeMatch({
            authorizationHash: authorizationHash,
            longAccountId: LONG_ACCOUNT,
            shortAccountId: SHORT_ACCOUNT,
            feePayerAccountId: LONG_ACCOUNT,
            longSequence: clearing.account(LONG_ACCOUNT).sequence,
            shortSequence: clearing.account(SHORT_ACCOUNT).sequence,
            quantityAtoms: 1,
            priceTicks: 100,
            maxFeeBps: 10,
            expiry: uint64(block.timestamp + 300)
        });
    }

    function _openAndFund(uint256 key, bytes32 accountId, uint256 amount) private {
        address owner = vm.addr(key);
        token.mint(owner, amount);
        vm.startPrank(owner);
        clearing.openAccount(accountId);
        token.approve(address(clearing), amount);
        clearing.deposit(accountId, amount);
        vm.stopPrank();
    }

    function _sign(uint256 key, bytes32 digest) private pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "openzeppelin-contracts/token/ERC20/ERC20.sol";
import {IERC20} from "openzeppelin-contracts/token/ERC20/IERC20.sol";
import {PerformanceBondVault} from "../src/PerformanceBondVault.sol";

contract BondToken is ERC20 {
    constructor() ERC20("Bond USD", "BUSD") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// A token that keeps one unit of every transfer, which must never back a bond.
contract SkimmingToken is ERC20 {
    constructor() ERC20("Skim", "SKM") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0) && value > 0) {
            super._update(from, address(0xdead), 1);
            super._update(from, to, value - 1);
        } else {
            super._update(from, to, value);
        }
    }
}

contract PerformanceBondVaultTest is Test {
    address private constant CLAIMS = address(0xC1);
    address private constant RESOLVER = address(0xD1);
    address private constant SOLVER = address(0x501);
    address private constant TAKER = address(0x7A);
    bytes32 private constant BOND = keccak256("bond-1");
    bytes32 private constant EVIDENCE_A = keccak256("fault-a");
    bytes32 private constant EVIDENCE_B = keccak256("fault-b");
    uint8 private constant RESERVATION_FAULT = 1;
    uint8 private constant OFF_ROUTE_FAULT = 2;

    PerformanceBondVault private vault;
    BondToken private token;

    function setUp() public {
        vm.warp(1_000);
        vault = new PerformanceBondVault(CLAIMS, RESOLVER);
        token = new BondToken();
        token.mint(SOLVER, 1_000);
        vm.prank(SOLVER);
        token.approve(address(vault), type(uint256).max);
    }

    function _open(uint8 faults) private {
        vm.prank(SOLVER);
        vault.openBond(BOND, IERC20(address(token)), 1_000, faults, 600, 100, 5_000);
    }

    function _file(bytes32 evidence, uint8 fault, uint256 payout) private {
        vm.prank(CLAIMS);
        vault.fileClaim(BOND, evidence, fault, payout, TAKER);
    }

    function testAnUndisputedClaimPaysAfterItsWindowAndTheRemainderReturnsOnce() public {
        _open(uint8(1 << RESERVATION_FAULT));
        assertEq(token.balanceOf(address(vault)), 1_000);
        _file(EVIDENCE_A, RESERVATION_FAULT, 400);

        vm.expectRevert(PerformanceBondVault.DisputeWindowOpen.selector);
        vault.settleClaim(BOND, EVIDENCE_A);
        vm.warp(1_100);
        vault.settleClaim(BOND, EVIDENCE_A);
        assertEq(token.balanceOf(TAKER), 400);
        vm.expectRevert(PerformanceBondVault.ClaimNotPending.selector);
        vault.settleClaim(BOND, EVIDENCE_A);

        vm.expectRevert(PerformanceBondVault.NotExpired.selector);
        vault.release(BOND);
        vm.warp(5_000);
        vault.release(BOND);
        assertEq(token.balanceOf(SOLVER), 600);
        vm.expectRevert(PerformanceBondVault.BondClosed.selector);
        vault.release(BOND);
    }

    function testClaimsAreBoundedByCoverageCapUniquenessAndTheUnencumberedBond() public {
        _open(uint8(1 << RESERVATION_FAULT));
        vm.prank(address(0xBAD));
        vm.expectRevert(abi.encodeWithSelector(PerformanceBondVault.Unauthorized.selector, address(0xBAD)));
        vault.fileClaim(BOND, EVIDENCE_A, RESERVATION_FAULT, 100, TAKER);

        vm.prank(CLAIMS);
        vm.expectRevert(abi.encodeWithSelector(PerformanceBondVault.FaultNotCovered.selector, OFF_ROUTE_FAULT));
        vault.fileClaim(BOND, EVIDENCE_A, OFF_ROUTE_FAULT, 100, TAKER);
        vm.prank(CLAIMS);
        vm.expectRevert(PerformanceBondVault.PayoutAboveCap.selector);
        vault.fileClaim(BOND, EVIDENCE_A, RESERVATION_FAULT, 601, TAKER);
        vm.prank(CLAIMS);
        vm.expectRevert(PerformanceBondVault.InvalidClaim.selector);
        vault.fileClaim(BOND, EVIDENCE_A, RESERVATION_FAULT, 100, SOLVER);

        _file(EVIDENCE_A, RESERVATION_FAULT, 600);
        vm.prank(CLAIMS);
        vm.expectRevert(PerformanceBondVault.ClaimExists.selector);
        vault.fileClaim(BOND, EVIDENCE_A, RESERVATION_FAULT, 100, TAKER);
        // Pending claims already promise 600 of 1000, so a second 500 cannot be promised.
        vm.prank(CLAIMS);
        vm.expectRevert(PerformanceBondVault.PayoutAboveUnencumbered.selector);
        vault.fileClaim(BOND, EVIDENCE_B, RESERVATION_FAULT, 500, TAKER);

        vm.warp(5_000);
        vm.prank(CLAIMS);
        vm.expectRevert(PerformanceBondVault.BondClosed.selector);
        vault.fileClaim(BOND, EVIDENCE_B, RESERVATION_FAULT, 100, TAKER);
        // An open claim blocks release until it is settled.
        vm.expectRevert(PerformanceBondVault.OpenClaims.selector);
        vault.release(BOND);
        vault.settleClaim(BOND, EVIDENCE_A);
        vault.release(BOND);
        assertEq(token.balanceOf(TAKER), 600);
        assertEq(token.balanceOf(SOLVER), 400);
    }

    function testDisputesAreTheSolversAndOnlyTheResolverDecidesThem() public {
        _open(uint8(1 << RESERVATION_FAULT) | uint8(1 << OFF_ROUTE_FAULT));
        _file(EVIDENCE_A, RESERVATION_FAULT, 300);
        _file(EVIDENCE_B, OFF_ROUTE_FAULT, 300);

        vm.prank(TAKER);
        vm.expectRevert(abi.encodeWithSelector(PerformanceBondVault.Unauthorized.selector, TAKER));
        vault.disputeClaim(BOND, EVIDENCE_A);
        vm.startPrank(SOLVER);
        vault.disputeClaim(BOND, EVIDENCE_A);
        vault.disputeClaim(BOND, EVIDENCE_B);
        vm.stopPrank();
        // A disputed claim never pays by waiting.
        vm.warp(2_000);
        vm.expectRevert(PerformanceBondVault.ClaimNotPending.selector);
        vault.settleClaim(BOND, EVIDENCE_A);

        vm.prank(CLAIMS);
        vm.expectRevert(abi.encodeWithSelector(PerformanceBondVault.Unauthorized.selector, CLAIMS));
        vault.resolveDispute(BOND, EVIDENCE_A, true);
        vm.startPrank(RESOLVER);
        vault.resolveDispute(BOND, EVIDENCE_A, true);
        vault.resolveDispute(BOND, EVIDENCE_B, false);
        vm.expectRevert(PerformanceBondVault.ClaimNotDisputed.selector);
        vault.resolveDispute(BOND, EVIDENCE_A, false);
        vm.stopPrank();
        assertEq(token.balanceOf(TAKER), 300);
        assertEq(uint8(vault.claim(BOND, EVIDENCE_A).state), uint8(PerformanceBondVault.ClaimState.REJECTED));
        // The rejected claim's promise is freed again.
        assertEq(vault.bond(BOND).encumberedAtoms, 300);
    }

    function testADisputeMustArriveInsideTheWindow() public {
        _open(uint8(1 << RESERVATION_FAULT));
        _file(EVIDENCE_A, RESERVATION_FAULT, 100);
        vm.warp(1_100);
        vm.prank(SOLVER);
        vm.expectRevert(PerformanceBondVault.DisputeWindowClosed.selector);
        vault.disputeClaim(BOND, EVIDENCE_A);
    }

    function testBondsRejectBadTermsDuplicatesAndSkimmingTokens() public {
        vm.startPrank(SOLVER);
        vm.expectRevert(PerformanceBondVault.InvalidBond.selector);
        vault.openBond(BOND, IERC20(address(token)), 1_000, 1 << 4, 600, 100, 5_000);
        vm.expectRevert(PerformanceBondVault.InvalidBond.selector);
        vault.openBond(BOND, IERC20(address(token)), 1_000, 1 << 1, 1_001, 100, 5_000);
        vm.expectRevert(PerformanceBondVault.InvalidBond.selector);
        vault.openBond(BOND, IERC20(address(token)), 1_000, 1 << 1, 600, 100, 1_000);
        vault.openBond(BOND, IERC20(address(token)), 500, 1 << 1, 300, 100, 5_000);
        vm.expectRevert(PerformanceBondVault.BondExists.selector);
        vault.openBond(BOND, IERC20(address(token)), 500, 1 << 1, 300, 100, 5_000);
        vm.stopPrank();

        SkimmingToken skim = new SkimmingToken();
        skim.mint(SOLVER, 1_000);
        vm.startPrank(SOLVER);
        skim.approve(address(vault), type(uint256).max);
        vm.expectRevert(PerformanceBondVault.TransferAmountMismatch.selector);
        vault.openBond(keccak256("bond-2"), IERC20(address(skim)), 1_000, 1 << 1, 300, 100, 5_000);
        vm.stopPrank();

        vm.expectRevert(PerformanceBondVault.InvalidConfiguration.selector);
        new PerformanceBondVault(CLAIMS, CLAIMS);
    }

    function testFuzzPaidNeverExceedsTheBond(uint256 first, uint256 second, uint256 third) public {
        _open(uint8(1 << RESERVATION_FAULT));
        uint256[3] memory payouts = [bound(first, 1, 600), bound(second, 1, 600), bound(third, 1, 600)];
        bytes32[3] memory evidence = [EVIDENCE_A, EVIDENCE_B, keccak256("fault-c")];
        uint256 promised;
        for (uint256 index = 0; index < 3; index++) {
            if (promised + payouts[index] > 1_000) {
                vm.prank(CLAIMS);
                vm.expectRevert(PerformanceBondVault.PayoutAboveUnencumbered.selector);
                vault.fileClaim(BOND, evidence[index], RESERVATION_FAULT, payouts[index], TAKER);
            } else {
                _file(evidence[index], RESERVATION_FAULT, payouts[index]);
                promised += payouts[index];
            }
        }
        vm.warp(5_000);
        for (uint256 index = 0; index < 3; index++) {
            if (vault.claim(BOND, evidence[index]).state == PerformanceBondVault.ClaimState.PENDING) {
                vault.settleClaim(BOND, evidence[index]);
            }
        }
        vault.release(BOND);
        assertEq(token.balanceOf(TAKER), promised);
        assertEq(token.balanceOf(SOLVER), 1_000 - promised);
        assertEq(token.balanceOf(address(vault)), 0);
    }
}

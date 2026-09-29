// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {ProtocolConfig} from "../src/ProtocolConfig.sol";
import {SolverRegistry} from "../src/SolverRegistry.sol";

contract SolverRegistryTest is Test {
    bytes32 private constant MANIFEST_HASH = keccak256("manifest");
    address private constant PROPOSER = address(0x101);
    address private constant CANCELLER = address(0x102);
    address private constant GOVERNANCE_EXECUTOR = address(0x103);
    address private constant PAUSER = address(0x104);
    address private constant INITIAL_SOLVER = address(0x201);
    address private constant NEXT_SOLVER = address(0x202);
    address private constant THIRD_SOLVER = address(0x203);
    address private constant OUTSIDER = address(0x301);

    ProtocolConfig private config;
    SolverRegistry private registry;

    function setUp() public {
        config =
            new ProtocolConfig("eip155:31337", 1, MANIFEST_HASH, 50, PROPOSER, CANCELLER, GOVERNANCE_EXECUTOR, PAUSER);
        registry = new SolverRegistry(config, INITIAL_SOLVER);
    }

    function testProposalCanBeCancelledWithoutChangingTheActiveSet() public {
        vm.prank(OUTSIDER);
        vm.expectRevert(abi.encodeWithSelector(SolverRegistry.UnauthorizedRole.selector, OUTSIDER, PROPOSER));
        registry.proposeSolver(NEXT_SOLVER);

        vm.warp(100);
        vm.prank(PROPOSER);
        registry.proposeSolver(NEXT_SOLVER);
        assertTrue(registry.isActiveSolver(INITIAL_SOLVER));
        assertFalse(registry.isActiveSolver(NEXT_SOLVER));
        assertEq(registry.pendingActivationTimestamp(NEXT_SOLVER), 150);

        vm.prank(PROPOSER);
        vm.expectRevert(SolverRegistry.SolverProposalExists.selector);
        registry.proposeSolver(NEXT_SOLVER);
        vm.prank(PROPOSER);
        vm.expectRevert(SolverRegistry.SolverAlreadyActive.selector);
        registry.proposeSolver(INITIAL_SOLVER);

        vm.prank(OUTSIDER);
        vm.expectRevert(abi.encodeWithSelector(SolverRegistry.UnauthorizedRole.selector, OUTSIDER, CANCELLER));
        registry.cancelSolverProposal(NEXT_SOLVER);

        vm.prank(CANCELLER);
        registry.cancelSolverProposal(NEXT_SOLVER);
        assertEq(registry.pendingActivationTimestamp(NEXT_SOLVER), 0);
        assertEq(registry.activeSolverCount(), 1);

        vm.prank(CANCELLER);
        vm.expectRevert(SolverRegistry.SolverProposalMissing.selector);
        registry.cancelSolverProposal(NEXT_SOLVER);
    }

    function testActivationRequiresGovernanceRoleAndExactDelayBoundary() public {
        vm.warp(200);
        vm.prank(PROPOSER);
        registry.proposeSolver(NEXT_SOLVER);

        vm.warp(249);
        vm.prank(GOVERNANCE_EXECUTOR);
        vm.expectRevert(abi.encodeWithSelector(SolverRegistry.SolverProposalNotReady.selector, uint64(250)));
        registry.activateSolver(NEXT_SOLVER);

        vm.warp(250);
        vm.prank(OUTSIDER);
        vm.expectRevert(abi.encodeWithSelector(SolverRegistry.UnauthorizedRole.selector, OUTSIDER, GOVERNANCE_EXECUTOR));
        registry.activateSolver(NEXT_SOLVER);

        vm.prank(GOVERNANCE_EXECUTOR);
        registry.activateSolver(NEXT_SOLVER);
        assertTrue(registry.isActiveSolver(INITIAL_SOLVER));
        assertTrue(registry.isActiveSolver(NEXT_SOLVER));
        assertEq(registry.pendingActivationTimestamp(NEXT_SOLVER), 0);
        assertEq(registry.activeSolverCount(), 2);

        vm.prank(GOVERNANCE_EXECUTOR);
        vm.expectRevert(SolverRegistry.SolverProposalMissing.selector);
        registry.activateSolver(THIRD_SOLVER);
    }

    function testThePauserRemovesASolverImmediatelyAndTheSetStaysDense() public {
        vm.warp(10);
        vm.startPrank(PROPOSER);
        registry.proposeSolver(NEXT_SOLVER);
        registry.proposeSolver(THIRD_SOLVER);
        vm.stopPrank();
        vm.warp(60);
        vm.startPrank(GOVERNANCE_EXECUTOR);
        registry.activateSolver(NEXT_SOLVER);
        registry.activateSolver(THIRD_SOLVER);
        vm.stopPrank();

        vm.prank(GOVERNANCE_EXECUTOR);
        vm.expectRevert(abi.encodeWithSelector(SolverRegistry.UnauthorizedRole.selector, GOVERNANCE_EXECUTOR, PAUSER));
        registry.removeSolver(INITIAL_SOLVER);

        vm.prank(PAUSER);
        registry.removeSolver(INITIAL_SOLVER);
        assertFalse(registry.isActiveSolver(INITIAL_SOLVER));
        address[] memory active = registry.activeSolvers();
        assertEq(active.length, 2);
        assertEq(active[0], THIRD_SOLVER);
        assertEq(active[1], NEXT_SOLVER);

        vm.prank(PAUSER);
        vm.expectRevert(SolverRegistry.SolverNotActive.selector);
        registry.removeSolver(INITIAL_SOLVER);

        vm.startPrank(PAUSER);
        registry.removeSolver(NEXT_SOLVER);
        registry.removeSolver(THIRD_SOLVER);
        vm.stopPrank();
        // With no active solver, settlement fails closed until governance adds one again.
        assertEq(registry.activeSolverCount(), 0);
    }

    function testTheActiveSetIsBounded() public {
        vm.warp(1);
        for (uint160 index = 1; index < registry.MAX_ACTIVE_SOLVERS(); index++) {
            address candidate = address(0x1000 + index);
            vm.prank(PROPOSER);
            registry.proposeSolver(candidate);
        }
        vm.warp(51);
        for (uint160 index = 1; index < registry.MAX_ACTIVE_SOLVERS(); index++) {
            vm.prank(GOVERNANCE_EXECUTOR);
            registry.activateSolver(address(0x1000 + index));
        }
        assertEq(registry.activeSolverCount(), registry.MAX_ACTIVE_SOLVERS());
        vm.prank(PROPOSER);
        registry.proposeSolver(NEXT_SOLVER);
        vm.warp(101);
        vm.prank(GOVERNANCE_EXECUTOR);
        vm.expectRevert(SolverRegistry.SolverSetFull.selector);
        registry.activateSolver(NEXT_SOLVER);
    }

    function testProposalTimestampOverflowUsesRegistryError() public {
        vm.warp(type(uint64).max);
        vm.prank(PROPOSER);
        vm.expectRevert(SolverRegistry.ActivationTimestampOverflow.selector);
        registry.proposeSolver(NEXT_SOLVER);
    }
}

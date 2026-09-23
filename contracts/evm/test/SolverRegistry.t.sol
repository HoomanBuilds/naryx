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
    address private constant OUTSIDER = address(0x301);

    ProtocolConfig private config;
    SolverRegistry private registry;

    function setUp() public {
        config =
            new ProtocolConfig("eip155:31337", 1, MANIFEST_HASH, 50, PROPOSER, CANCELLER, GOVERNANCE_EXECUTOR, PAUSER);
        registry = new SolverRegistry(config, INITIAL_SOLVER);
    }

    function testProposalCanBeCancelledWithoutChangingActiveSolver() public {
        vm.prank(OUTSIDER);
        vm.expectRevert(abi.encodeWithSelector(SolverRegistry.UnauthorizedRole.selector, OUTSIDER, PROPOSER));
        registry.proposeSolver(NEXT_SOLVER);

        vm.warp(100);
        vm.prank(PROPOSER);
        registry.proposeSolver(NEXT_SOLVER);
        assertEq(registry.activeSolver(), INITIAL_SOLVER);
        assertEq(registry.pendingSolver(), NEXT_SOLVER);
        assertEq(registry.pendingActivationTimestamp(), 150);

        vm.prank(OUTSIDER);
        vm.expectRevert(abi.encodeWithSelector(SolverRegistry.UnauthorizedRole.selector, OUTSIDER, CANCELLER));
        registry.cancelSolverProposal();

        vm.prank(CANCELLER);
        registry.cancelSolverProposal();
        assertEq(registry.activeSolver(), INITIAL_SOLVER);
        assertEq(registry.pendingSolver(), address(0));
        assertEq(registry.pendingActivationTimestamp(), 0);
    }

    function testActivationRequiresGovernanceRoleAndExactDelayBoundary() public {
        vm.warp(200);
        vm.prank(PROPOSER);
        registry.proposeSolver(NEXT_SOLVER);

        vm.warp(249);
        vm.prank(GOVERNANCE_EXECUTOR);
        vm.expectRevert(abi.encodeWithSelector(SolverRegistry.SolverProposalNotReady.selector, uint64(250)));
        registry.activateSolver();

        vm.warp(250);
        vm.prank(OUTSIDER);
        vm.expectRevert(abi.encodeWithSelector(SolverRegistry.UnauthorizedRole.selector, OUTSIDER, GOVERNANCE_EXECUTOR));
        registry.activateSolver();

        vm.prank(GOVERNANCE_EXECUTOR);
        registry.activateSolver();
        assertEq(registry.activeSolver(), NEXT_SOLVER);
        assertEq(registry.pendingSolver(), address(0));
        assertEq(registry.pendingActivationTimestamp(), 0);
    }

    function testProposalTimestampOverflowUsesRegistryError() public {
        vm.warp(type(uint64).max);
        vm.prank(PROPOSER);
        vm.expectRevert(SolverRegistry.ActivationTimestampOverflow.selector);
        registry.proposeSolver(NEXT_SOLVER);
    }
}

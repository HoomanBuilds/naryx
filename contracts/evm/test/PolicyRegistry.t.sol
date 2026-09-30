// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {PolicyRegistry} from "../src/PolicyRegistry.sol";
import {ProtocolConfig} from "../src/ProtocolConfig.sol";

contract PolicyRegistryTest is Test {
    address private constant PROPOSER = address(0xA1);
    address private constant CANCELLER = address(0xA2);
    address private constant EXECUTOR = address(0xA3);
    address private constant PAUSER = address(0xA4);
    bytes32 private constant FEES = keccak256("cash-carry-fees");
    bytes32 private constant TEMPLATE = keccak256("cash-and-carry-v1");
    PolicyRegistry.PolicyKind private constant FEE = PolicyRegistry.PolicyKind.FEE_POLICY;

    PolicyRegistry private registry;

    function setUp() public {
        vm.warp(1_000);
        ProtocolConfig config =
            new ProtocolConfig("eip155:84532", 1, keccak256("domain"), 60, PROPOSER, CANCELLER, EXECUTOR, PAUSER);
        registry = new PolicyRegistry(config);
    }

    function _activate(PolicyRegistry.PolicyKind kind, bytes32 subject, uint32 version, bytes32 hash, uint16 bps)
        private
    {
        vm.prank(PROPOSER);
        registry.proposeActivation(kind, subject, version, hash, bps);
        vm.warp(block.timestamp + 60);
        vm.prank(EXECUTOR);
        registry.activate(kind, subject);
    }

    function testActivationWaitsOutTheDelayAndBindsExactVersionAndHash() public {
        vm.prank(PROPOSER);
        registry.proposeActivation(FEE, FEES, 1, keccak256("fees-v1"), 25);
        vm.prank(EXECUTOR);
        vm.expectRevert(abi.encodeWithSelector(PolicyRegistry.ProposalNotReady.selector, uint64(1_060)));
        registry.activate(FEE, FEES);
        vm.warp(1_060);
        vm.prank(EXECUTOR);
        registry.activate(FEE, FEES);
        assertTrue(registry.isActive(FEE, FEES, 1, keccak256("fees-v1")));
        assertFalse(registry.isActive(FEE, FEES, 1, keccak256("fees-v2")));
        assertEq(registry.policy(FEE, FEES).maximumFeeBps, 25);

        vm.prank(PROPOSER);
        vm.expectRevert(abi.encodeWithSelector(PolicyRegistry.VersionNotIncreasing.selector, uint32(1), uint32(1)));
        registry.proposeActivation(FEE, FEES, 1, keccak256("fees-v1b"), 25);
    }

    function testRolesCapsAndCancellation() public {
        vm.prank(EXECUTOR);
        vm.expectRevert(abi.encodeWithSelector(PolicyRegistry.UnauthorizedRole.selector, EXECUTOR, PROPOSER));
        registry.proposeActivation(FEE, FEES, 1, keccak256("fees-v1"), 25);
        vm.startPrank(PROPOSER);
        vm.expectRevert(PolicyRegistry.InvalidPolicy.selector);
        registry.proposeActivation(FEE, FEES, 1, keccak256("fees-v1"), 1_001);
        vm.expectRevert(PolicyRegistry.InvalidPolicy.selector);
        registry.proposeActivation(PolicyRegistry.PolicyKind.TEMPLATE, TEMPLATE, 1, keccak256("template-v1"), 1);
        registry.proposeActivation(FEE, FEES, 1, keccak256("fees-v1"), 25);
        vm.expectRevert(PolicyRegistry.ProposalExists.selector);
        registry.proposeActivation(FEE, FEES, 2, keccak256("fees-v2"), 25);
        vm.stopPrank();
        vm.prank(CANCELLER);
        registry.cancel(FEE, FEES);
        vm.warp(1_060);
        vm.prank(EXECUTOR);
        vm.expectRevert(PolicyRegistry.ProposalMissing.selector);
        registry.activate(FEE, FEES);
    }

    function testPauseIsImmediateAndResumeWaitsOutTheDelay() public {
        _activate(PolicyRegistry.PolicyKind.TEMPLATE, TEMPLATE, 1, keccak256("template-v1"), 0);
        vm.prank(PAUSER);
        registry.pause(PolicyRegistry.PolicyKind.TEMPLATE, TEMPLATE);
        assertFalse(registry.isActive(PolicyRegistry.PolicyKind.TEMPLATE, TEMPLATE, 1, keccak256("template-v1")));
        vm.prank(PROPOSER);
        registry.proposeResume(PolicyRegistry.PolicyKind.TEMPLATE, TEMPLATE);
        vm.prank(EXECUTOR);
        vm.expectRevert();
        registry.activate(PolicyRegistry.PolicyKind.TEMPLATE, TEMPLATE);
        vm.warp(block.timestamp + 60);
        vm.prank(EXECUTOR);
        registry.activate(PolicyRegistry.PolicyKind.TEMPLATE, TEMPLATE);
        assertTrue(registry.isActive(PolicyRegistry.PolicyKind.TEMPLATE, TEMPLATE, 1, keccak256("template-v1")));
    }

    function testAVersionQueuedBeforeAPauseActivatesStillPaused() public {
        _activate(FEE, FEES, 1, keccak256("fees-v1"), 25);
        vm.prank(PROPOSER);
        registry.proposeActivation(FEE, FEES, 2, keccak256("fees-v2"), 25);
        vm.prank(PAUSER);
        registry.pause(FEE, FEES);
        vm.warp(block.timestamp + 60);
        vm.prank(EXECUTOR);
        registry.activate(FEE, FEES);
        assertEq(registry.policy(FEE, FEES).version, 2);
        assertTrue(registry.policy(FEE, FEES).paused);
        assertFalse(registry.isActive(FEE, FEES, 2, keccak256("fees-v2")));
    }
}

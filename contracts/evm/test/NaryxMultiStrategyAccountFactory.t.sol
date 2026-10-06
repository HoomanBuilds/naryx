// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {NaryxMultiStrategyAccount} from "../src/NaryxMultiStrategyAccount.sol";
import {NaryxMultiStrategyAccountFactory} from "../src/NaryxMultiStrategyAccountFactory.sol";
import {ProtocolConfig} from "../src/ProtocolConfig.sol";
import {SolverRegistry} from "../src/SolverRegistry.sol";
import {StrategyFeePolicyRegistry} from "../src/StrategyFeePolicyRegistry.sol";
import {TypedStrategyAdapterRegistry} from "../src/TypedStrategyAdapterRegistry.sol";

contract NaryxMultiStrategyAccountFactoryTest is Test {
    bytes32 private constant FEE_POLICY_SUBJECT_ID = keccak256("multi-strategy-fees");
    address private constant PROPOSER = address(0x101);
    address private constant CANCELLER = address(0x102);
    address private constant GOVERNANCE_EXECUTOR = address(0x103);
    address private constant PAUSER = address(0x104);
    address private constant SOLVER = address(0x105);

    NaryxMultiStrategyAccountFactory private factory;

    function setUp() public {
        ProtocolConfig config = new ProtocolConfig(
            "eip155:31337", 1, keccak256("domain"), 1, PROPOSER, CANCELLER, GOVERNANCE_EXECUTOR, PAUSER
        );
        SolverRegistry solvers = new SolverRegistry(config, SOLVER);
        TypedStrategyAdapterRegistry adapters = new TypedStrategyAdapterRegistry(config);
        StrategyFeePolicyRegistry fees = new StrategyFeePolicyRegistry(config);
        factory = new NaryxMultiStrategyAccountFactory(config, solvers, adapters, fees, FEE_POLICY_SUBJECT_ID);
    }

    function testPredictsCreatesAndRecognizesOneAccountPerOwner() public {
        address owner = address(0xA11CE);
        address predicted = factory.accountOf(owner);
        assertEq(predicted.code.length, 0);

        NaryxMultiStrategyAccount account = factory.create(owner);

        assertEq(address(account), predicted);
        assertEq(account.owner(), owner);
        assertEq(account.accountFactory(), address(factory));
        assertTrue(factory.isAccount(predicted));
        assertEq(predicted.codehash, factory.accountCodeHash());
        assertEq(factory.referenceAccount().codehash, factory.accountCodeHash());
        assertEq(address(factory.create(owner)), predicted);
    }

    function testRejectsInvalidOwners() public {
        vm.expectRevert(NaryxMultiStrategyAccountFactory.InvalidOwner.selector);
        factory.create(address(0));
        vm.expectRevert(NaryxMultiStrategyAccountFactory.InvalidOwner.selector);
        factory.create(address(factory));
    }
}

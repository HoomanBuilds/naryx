// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {NaryxTestUSDC} from "../src/conformance/NaryxTestUSDC.sol";

contract NaryxTestUSDCTest is Test {
    function testAnyoneMintsUpToTheFaucetBalanceLimit() public {
        NaryxTestUSDC token = new NaryxTestUSDC();
        address trader = makeAddr("trader");
        vm.prank(makeAddr("anyone"));
        token.mint(trader, 10_000e6);
        assertEq(token.balanceOf(trader), 10_000e6);
        assertEq(token.decimals(), 6);

        vm.expectRevert(abi.encodeWithSelector(NaryxTestUSDC.FaucetLimitExceeded.selector, trader, 10_000e6, 0));
        token.mint(trader, 0);
        token.mint(trader, token.MAXIMUM_FAUCET_BALANCE() - 10_000e6);
        vm.expectRevert(
            abi.encodeWithSelector(
                NaryxTestUSDC.FaucetLimitExceeded.selector, trader, token.MAXIMUM_FAUCET_BALANCE(), 1
            )
        );
        token.mint(trader, 1);
    }

    function testRefusesEveryChainButTheTwoTestnetsAndLocal() public {
        vm.chainId(8453);
        vm.expectRevert(abi.encodeWithSelector(NaryxTestUSDC.TestnetOnly.selector, 8453));
        new NaryxTestUSDC();
        vm.chainId(42_161);
        vm.expectRevert(abi.encodeWithSelector(NaryxTestUSDC.TestnetOnly.selector, 42_161));
        new NaryxTestUSDC();
        vm.chainId(84_532);
        new NaryxTestUSDC();
        vm.chainId(421_614);
        new NaryxTestUSDC();
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Script} from "forge-std/Script.sol";
import {NaryxTestUSDC} from "../src/conformance/NaryxTestUSDC.sol";

/// @notice Deploys Naryx Test USDC on Base Sepolia or Arbitrum Sepolia; the token itself refuses any other chain.
contract DeployNaryxTestUSDC is Script {
    function run() external returns (NaryxTestUSDC token) {
        vm.startBroadcast();
        token = new NaryxTestUSDC();
        vm.stopBroadcast();
    }
}

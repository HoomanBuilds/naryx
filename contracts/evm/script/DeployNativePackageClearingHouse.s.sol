// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Script} from "forge-std/Script.sol";
import {IERC20} from "openzeppelin-contracts/token/ERC20/IERC20.sol";
import {NativePackageClearingHouse} from "../src/NativePackageClearingHouse.sol";

contract DeployNativePackageClearingHouse is Script {
    struct Parameters {
        uint256 expectedChainId;
        IERC20 collateralToken;
        bytes32 collateralTokenCodeHash;
        NativePackageClearingHouse.Configuration configuration;
    }

    error InvalidChain();
    error DependencyChanged(address dependency);

    function run(Parameters calldata parameters) external returns (NativePackageClearingHouse clearingHouse) {
        vm.startBroadcast();
        clearingHouse = deploy(parameters);
        vm.stopBroadcast();
    }

    function deploy(Parameters calldata parameters) public returns (NativePackageClearingHouse clearingHouse) {
        if (parameters.expectedChainId == 0 || block.chainid != parameters.expectedChainId) revert InvalidChain();
        address collateral = address(parameters.collateralToken);
        if (collateral.code.length == 0 || collateral.codehash != parameters.collateralTokenCodeHash) {
            revert DependencyChanged(collateral);
        }
        clearingHouse = new NativePackageClearingHouse(parameters.collateralToken, parameters.configuration);
    }
}

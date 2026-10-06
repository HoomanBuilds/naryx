// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {ERC20} from "openzeppelin-contracts/token/ERC20/ERC20.sol";
import {IERC20} from "openzeppelin-contracts/token/ERC20/IERC20.sol";
import {ERC4626} from "openzeppelin-contracts/token/ERC20/extensions/ERC4626.sol";

contract NaryxTestVault is ERC4626 {
    uint256 public constant BASE_SEPOLIA_CHAIN_ID = 84_532;
    uint256 public constant ARBITRUM_SEPOLIA_CHAIN_ID = 421_614;
    uint256 public constant ANVIL_CHAIN_ID = 31_337;
    uint256 public constant LOCAL_EVM_CHAIN_ID = 31_338;

    error TestnetOnly(uint256 chainId);

    constructor(IERC20 asset_) ERC20("Naryx Test Vault Share", "ntVS") ERC4626(asset_) {
        if (
            block.chainid != BASE_SEPOLIA_CHAIN_ID && block.chainid != ARBITRUM_SEPOLIA_CHAIN_ID
                && block.chainid != ANVIL_CHAIN_ID && block.chainid != LOCAL_EVM_CHAIN_ID
        ) revert TestnetOnly(block.chainid);
    }
}

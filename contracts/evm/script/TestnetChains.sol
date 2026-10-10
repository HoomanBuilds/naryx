// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

/// @notice Chains a broadcasting script may target: local Anvil, Base Sepolia, Arbitrum Sepolia and Ethereum
/// Sepolia. An operator-supplied expected chain ID alone does not keep a script off mainnet.
library TestnetChains {
    function isAllowed(uint256 chainId) internal pure returns (bool) {
        return chainId == 31_337 || chainId == 84_532 || chainId == 421_614 || chainId == 11_155_111;
    }
}

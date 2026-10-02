// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {ERC20} from "openzeppelin-contracts/token/ERC20/ERC20.sol";

/// @notice Naryx Test USDC: a six-decimal test collateral anyone can mint on Base Sepolia, Arbitrum Sepolia, or a
/// local chain, so traders and reviewers can fund packages without the public USDC faucet's small per-request grant.
/// It has no owner, no admin, and no value. Construction reverts on every other chain, so it can never exist on a
/// mainnet. `mint(address,uint256)` matches the GMX test-token faucet, so one client call funds either token.
contract NaryxTestUSDC is ERC20 {
    uint256 public constant BASE_SEPOLIA_CHAIN_ID = 84_532;
    uint256 public constant ARBITRUM_SEPOLIA_CHAIN_ID = 421_614;
    uint256 public constant LOCAL_CHAIN_ID = 31_337;
    /// Faucet mints stop once the recipient holds this much.
    uint256 public constant MAXIMUM_FAUCET_BALANCE = 10_000_000e6;

    error TestnetOnly(uint256 chainId);
    error FaucetLimitExceeded(address recipient, uint256 balance, uint256 amount);

    constructor() ERC20("Naryx Test USDC", "tUSDC") {
        if (
            block.chainid != BASE_SEPOLIA_CHAIN_ID && block.chainid != ARBITRUM_SEPOLIA_CHAIN_ID
                && block.chainid != LOCAL_CHAIN_ID
        ) revert TestnetOnly(block.chainid);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Mints test USDC to `recipient` while its balance stays at or below the faucet limit.
    function mint(address recipient, uint256 amount) external {
        uint256 balance = balanceOf(recipient);
        if (amount == 0 || balance >= MAXIMUM_FAUCET_BALANCE || amount > MAXIMUM_FAUCET_BALANCE - balance) {
            revert FaucetLimitExceeded(recipient, balance, amount);
        }
        _mint(recipient, amount);
    }
}

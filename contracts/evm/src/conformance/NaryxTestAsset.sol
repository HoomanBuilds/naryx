// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {ERC20} from "openzeppelin-contracts/token/ERC20/ERC20.sol";

contract NaryxTestAsset is ERC20 {
    uint256 public constant BASE_SEPOLIA_CHAIN_ID = 84_532;
    uint256 public constant ARBITRUM_SEPOLIA_CHAIN_ID = 421_614;
    uint256 public constant ANVIL_CHAIN_ID = 31_337;
    uint256 public constant LOCAL_EVM_CHAIN_ID = 31_338;

    uint8 private immutable _assetDecimals;
    uint256 public immutable maximumFaucetBalanceAtoms;

    error TestnetOnly(uint256 chainId);
    error InvalidConfiguration();
    error FaucetLimitExceeded(address recipient, uint256 balance, uint256 amount);

    constructor(string memory name_, string memory symbol_, uint8 decimals_, uint256 maximumFaucetBalanceAtoms_)
        ERC20(name_, symbol_)
    {
        if (!_supportedChain()) revert TestnetOnly(block.chainid);
        if (decimals_ > 18 || maximumFaucetBalanceAtoms_ == 0) revert InvalidConfiguration();
        _assetDecimals = decimals_;
        maximumFaucetBalanceAtoms = maximumFaucetBalanceAtoms_;
    }

    function decimals() public view override returns (uint8) {
        return _assetDecimals;
    }

    function mint(address recipient, uint256 amount) external {
        uint256 balance = balanceOf(recipient);
        if (
            recipient == address(0) || amount == 0 || balance >= maximumFaucetBalanceAtoms
                || amount > maximumFaucetBalanceAtoms - balance
        ) revert FaucetLimitExceeded(recipient, balance, amount);
        _mint(recipient, amount);
    }

    function _supportedChain() private view returns (bool) {
        return block.chainid == BASE_SEPOLIA_CHAIN_ID || block.chainid == ARBITRUM_SEPOLIA_CHAIN_ID
            || block.chainid == ANVIL_CHAIN_ID || block.chainid == LOCAL_EVM_CHAIN_ID;
    }
}

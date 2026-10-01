// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "openzeppelin-contracts/token/ERC20/IERC20.sol";

/// @notice A perpetual venue's collateral gate: a per-trader free reserve, in collateral atoms, that
/// position margin is drawn from and settles back into.
interface IPerpMarginGate {
    function collateral() external view returns (IERC20);

    function reserveOf(address trader) external view returns (uint256);

    function deposit(uint256 amount) external;

    function withdraw(uint256 amount) external;
}

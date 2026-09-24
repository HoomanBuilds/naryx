// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "openzeppelin-contracts/token/ERC20/IERC20.sol";

interface IExactSpotPort {
    function verifier() external view returns (address);
    function verifierCodeHash() external view returns (bytes32);
    function baseToken() external view returns (IERC20);
    function quoteToken() external view returns (IERC20);
    function buyExactOutput(
        uint256 packageNonce,
        bytes32 spotFillCommitment,
        bytes32 orderHash,
        bytes32 quoteHash,
        bytes32 routeHash,
        uint256 quantity,
        uint256 maxQuote
    ) external returns (uint256 quoteIn);
    function sellExactInput(
        uint256 packageNonce,
        bytes32 spotFillCommitment,
        bytes32 orderHash,
        bytes32 quoteHash,
        bytes32 routeHash,
        uint256 quantity,
        uint256 minQuote
    ) external returns (uint256 quoteOut);
}

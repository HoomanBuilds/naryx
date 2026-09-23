// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "openzeppelin-contracts/token/ERC20/IERC20.sol";

interface IShortPerpPort {
    struct PositionSnapshot {
        int256 baseSize;
        uint256 collateral;
        int256 accountValue;
    }

    function executor() external view returns (address);
    function deploymentChainId() external view returns (uint256);
    function venue() external view returns (address);
    function venueCodeHash() external view returns (bytes32);
    function baseAssetId() external view returns (bytes32);
    function quoteToken() external view returns (IERC20);
    function position(address trader) external view returns (PositionSnapshot memory);

    function openShort(address trader, uint256 baseQuantity, uint256 maxCollateral, uint256 deadline)
        external
        returns (PositionSnapshot memory post);

    function closeShort(address trader, uint256 baseQuantity, uint256 minQuoteReturned, uint256 deadline)
        external
        returns (PositionSnapshot memory post, uint256 quoteReturned);
}

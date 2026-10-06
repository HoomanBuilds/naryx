// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

interface IPremiaV3Pool {
    struct PositionDelta {
        int256 collateral;
        int256 longs;
        int256 shorts;
    }

    function getPoolSettings()
        external
        view
        returns (address base, address quote, address oracleAdapter, uint256 strike, uint256 maturity, bool isCallPool);
    function trade(uint256 size, bool isBuy, uint256 premiumLimit, address referrer)
        external
        returns (uint256 totalPremium, PositionDelta memory delta);
    function exercise() external returns (uint256 exerciseValue, uint256 exerciseFee);
    function settle() external returns (uint256 collateral);
    function balanceOf(address account, uint256 tokenId) external view returns (uint256);
}

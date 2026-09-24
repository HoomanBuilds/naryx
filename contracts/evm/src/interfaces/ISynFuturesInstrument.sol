// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

interface ISynFuturesInstrument {
    struct PositionCache {
        int256 balance;
        int256 size;
        uint256 entryNotional;
        uint256 entrySocialLossIndex;
        int256 entryFundingIndex;
    }

    function trade(bytes32[2] calldata args) external returns (PositionCache memory position);
}

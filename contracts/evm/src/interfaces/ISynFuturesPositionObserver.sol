// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

interface ISynFuturesPositionObserver {
    struct Position {
        int128 balance;
        int128 size;
        uint128 entryNotional;
        uint128 entrySocialLossIndex;
        int128 entryFundingIndex;
    }

    function getPosition(address instrument, uint32 expiry, address target)
        external
        view
        returns (Position memory position);
}

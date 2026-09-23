// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

interface ISpotFillRecorder {
    function recordSpotFill(
        address strategyAccount,
        uint256 packageNonce,
        uint8 action,
        address baseToken,
        address quoteToken,
        uint256 baseAtoms,
        uint256 quoteAtoms
    ) external;
}

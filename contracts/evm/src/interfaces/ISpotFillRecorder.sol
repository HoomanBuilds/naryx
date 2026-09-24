// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

interface ISpotFillRecorder {
    function recordSpotFill(
        address strategyAccount,
        uint256 packageNonce,
        bytes32 spotFillCommitment,
        bytes32 orderHash,
        bytes32 quoteHash,
        bytes32 routeHash,
        uint8 action,
        address baseToken,
        address quoteToken,
        uint256 baseAtoms,
        uint256 quoteAtoms
    ) external;
}

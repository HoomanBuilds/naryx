// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {AggregatorV3Interface} from "../interfaces/IAggregatorV3.sol";

contract NaryxTestOracleMarker is AggregatorV3Interface {
    uint8 public constant decimals = 8;

    error UnauthorizedCaller();
    error InvalidAnswer();

    address public immutable owner;
    uint80 public roundId;
    int256 public answer;
    uint256 public updatedAt;

    constructor() {
        owner = msg.sender;
        _setAnswer(2_000e8);
    }

    function setAnswer(int256 nextAnswer) external {
        if (msg.sender != owner) revert UnauthorizedCaller();
        _setAnswer(nextAnswer);
    }

    function latestRoundData()
        external
        view
        returns (
            uint80 currentRoundId,
            int256 currentAnswer,
            uint256 startedAt,
            uint256 currentUpdatedAt,
            uint80 answeredInRound
        )
    {
        return (roundId, answer, updatedAt, updatedAt, roundId);
    }

    function _setAnswer(int256 nextAnswer) private {
        if (nextAnswer <= 0) revert InvalidAnswer();
        roundId += 1;
        answer = nextAnswer;
        updatedAt = block.timestamp;
    }
}

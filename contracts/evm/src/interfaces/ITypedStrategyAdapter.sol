// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

interface ITypedStrategyAdapter {
    function executeLeg(bytes calldata payload) external returns (bytes32 evidenceHash);
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

interface INaryxMultiStrategyAccountFactory {
    function isAccount(address account) external view returns (bool);
    function accountCodeHash() external view returns (bytes32);
}

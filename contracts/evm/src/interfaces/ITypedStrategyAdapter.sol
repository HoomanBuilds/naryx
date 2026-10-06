// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

interface ITypedStrategyAdapter {
    function adapterMetadata()
        external
        view
        returns (address strategyAccount, bytes32 classId, uint32 classVersion, address baseAsset, address quoteAsset);

    function executeLeg(bytes calldata payload) external returns (bytes32 evidenceHash);
}

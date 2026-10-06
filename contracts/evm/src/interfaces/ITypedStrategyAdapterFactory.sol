// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

interface ITypedStrategyAdapterFactory {
    function factoryMetadata()
        external
        view
        returns (bytes32 adapterClassId, uint32 adapterClassVersion, address baseAsset, address quoteAsset);

    function validateInstance(address instance, address strategyAccount, bytes32 packageId) external view returns (bool);
}

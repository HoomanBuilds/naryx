// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

interface ITypedStrategyAdapter {
    function adapterMetadata()
        external
        view
        returns (address strategyAccount, bytes32 classId, uint32 classVersion, address baseAsset, address quoteAsset);

    function executeLeg(bytes calldata payload) external returns (bytes32 evidenceHash);

    /// @notice Whether executing `payload` now would increase this adapter's venue exposure. A strategy account
    /// rejects a leg labelled risk-reducing when this returns true.
    function isRiskIncreasing(bytes calldata payload) external view returns (bool);
}

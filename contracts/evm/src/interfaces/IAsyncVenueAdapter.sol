// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

interface IAsyncVenueAdapter {
    struct VenueRequest {
        bytes32 marketId;
        address collateralToken;
        int256 sizeDelta;
        uint256 collateralAtoms;
        uint256 acceptablePrice;
        uint256 executionFeeWei;
        uint256 callbackGasLimit;
        uint64 submissionDeadline;
        uint64 venueDeadline;
        uint64 recoveryDeadline;
    }

    enum RecoveryAction {
        CANCEL_OR_RECONCILE
    }

    function createRequest(bytes32 packageId, VenueRequest calldata request) external returns (bytes32 requestKey);

    function requestRecovery(bytes32 packageId, bytes32 requestKey, RecoveryAction action) external returns (bool);
}

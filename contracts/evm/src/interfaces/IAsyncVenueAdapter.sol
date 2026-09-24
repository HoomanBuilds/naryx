// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

interface IAsyncVenueAdapter {
    struct SpotEntry {
        address fundingOwner;
        address port;
        bytes32 portCodeHash;
        address baseToken;
        address quoteToken;
        uint256 baseAtoms;
        uint256 maxQuoteAtoms;
        uint256 rollbackMinQuoteAtoms;
        bytes32 entryFillCommitment;
        bytes32 rollbackFillCommitment;
    }

    struct VenueRequest {
        bytes32 marketId;
        address collateralToken;
        int256 sizeDelta;
        uint256 collateralAtoms;
        uint256 acceptablePrice;
        uint256 executionFeeWei;
        uint256 callbackGasLimit;
        uint256 packageNonce;
        bytes32 orderHash;
        bytes32 quoteHash;
        bytes32 routeHash;
        SpotEntry spot;
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

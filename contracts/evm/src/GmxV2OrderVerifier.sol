// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {GmxV2, IGmxV2OrderVerifier} from "./interfaces/IGmxV2.sol";

contract GmxV2OrderVerifier is IGmxV2OrderVerifier {
    error InvalidOrderData();

    function verify(
        address account,
        address callbackContract,
        GmxV2.RequestRegistration calldata registration,
        GmxV2.EventLogData calldata orderData
    ) external pure {
        if (
            _addressValue(orderData, "account") != account
                || _addressValue(orderData, "receiver") != registration.beneficiary
                || _addressValue(orderData, "cancellationReceiver") != registration.refundRecipient
                || _addressValue(orderData, "callbackContract") != callbackContract
                || _addressValue(orderData, "uiFeeReceiver") != address(0)
                || _addressValue(orderData, "market") != registration.market
                || _addressValue(orderData, "initialCollateralToken") != registration.collateralToken
                || _uintValue(orderData, "orderType") != uint256(GmxV2.OrderType.MarketIncrease)
                || _uintValue(orderData, "decreasePositionSwapType") != 0
                || _uintValue(orderData, "sizeDeltaUsd") != registration.sizeDeltaUsd
                || _uintValue(orderData, "initialCollateralDeltaAmount") != registration.collateralAtoms
                || _uintValue(orderData, "triggerPrice") != 0
                || _uintValue(orderData, "acceptablePrice") != registration.acceptablePrice
                || _uintValue(orderData, "executionFee") != registration.executionFeeWei
                || _uintValue(orderData, "callbackGasLimit") != registration.callbackGasLimit
                || _uintValue(orderData, "minOutputAmount") != 0 || _uintValue(orderData, "validFromTime") != 0
                || _uintValue(orderData, "srcChainId") != 0 || _boolValue(orderData, "isLong") != registration.isLong
                || _boolValue(orderData, "shouldUnwrapNativeToken") || _boolValue(orderData, "autoCancel")
        ) revert InvalidOrderData();
        address[] calldata swapPath = _addressArrayValue(orderData, "swapPath");
        bytes32[] calldata dataList = _bytes32ArrayValue(orderData, "dataList");
        if (
            swapPath.length != 0 || dataList.length != 2 || dataList[0] != registration.packageId
                || dataList[1] != registration.requestPayloadHash
        ) revert InvalidOrderData();
    }

    function _addressValue(GmxV2.EventLogData calldata data, string memory key) private pure returns (address) {
        bytes32 target = keccak256(bytes(key));
        for (uint256 i; i < data.addressItems.items.length; i++) {
            if (keccak256(bytes(data.addressItems.items[i].key)) == target) return data.addressItems.items[i].value;
        }
        revert InvalidOrderData();
    }

    function _uintValue(GmxV2.EventLogData calldata data, string memory key) private pure returns (uint256) {
        bytes32 target = keccak256(bytes(key));
        for (uint256 i; i < data.uintItems.items.length; i++) {
            if (keccak256(bytes(data.uintItems.items[i].key)) == target) return data.uintItems.items[i].value;
        }
        revert InvalidOrderData();
    }

    function _boolValue(GmxV2.EventLogData calldata data, string memory key) private pure returns (bool) {
        bytes32 target = keccak256(bytes(key));
        for (uint256 i; i < data.boolItems.items.length; i++) {
            if (keccak256(bytes(data.boolItems.items[i].key)) == target) return data.boolItems.items[i].value;
        }
        revert InvalidOrderData();
    }

    function _addressArrayValue(GmxV2.EventLogData calldata data, string memory key)
        private
        pure
        returns (address[] calldata)
    {
        bytes32 target = keccak256(bytes(key));
        for (uint256 i; i < data.addressItems.arrayItems.length; i++) {
            if (keccak256(bytes(data.addressItems.arrayItems[i].key)) == target) {
                return data.addressItems.arrayItems[i].value;
            }
        }
        revert InvalidOrderData();
    }

    function _bytes32ArrayValue(GmxV2.EventLogData calldata data, string memory key)
        private
        pure
        returns (bytes32[] calldata)
    {
        bytes32 target = keccak256(bytes(key));
        for (uint256 i; i < data.bytes32Items.arrayItems.length; i++) {
            if (keccak256(bytes(data.bytes32Items.arrayItems[i].key)) == target) {
                return data.bytes32Items.arrayItems[i].value;
            }
        }
        revert InvalidOrderData();
    }
}

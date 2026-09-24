// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {GmxV2, IGmxV2ExitOrderVerifier} from "./interfaces/IGmxV2.sol";

contract GmxV2ExitOrderVerifier is IGmxV2ExitOrderVerifier {
    error InvalidOrderData();

    function verify(
        address callbackContract,
        GmxV2.ExitRegistration calldata registration,
        GmxV2.EventLogData calldata orderData
    ) external pure {
        if (
            _addressValue(orderData, "account") != registration.account
                || _addressValue(orderData, "receiver") != registration.receiver
                || _addressValue(orderData, "cancellationReceiver") != registration.executionFeeRefundRecipient
                || _addressValue(orderData, "callbackContract") != callbackContract
                || _addressValue(orderData, "uiFeeReceiver") != address(0)
                || _addressValue(orderData, "market") != registration.market
                || _addressValue(orderData, "initialCollateralToken") != registration.collateralToken
                || _uintValue(orderData, "orderType") != uint256(GmxV2.OrderType.MarketDecrease)
                || _uintValue(orderData, "decreasePositionSwapType") != 0
                || _uintValue(orderData, "sizeDeltaUsd") != registration.fullCloseSizeUsd
                || _uintValue(orderData, "initialCollateralDeltaAmount") != type(uint256).max
                || _uintValue(orderData, "triggerPrice") != 0
                || _uintValue(orderData, "acceptablePrice") != registration.acceptablePrice
                || _uintValue(orderData, "executionFee") != registration.executionFeeWei
                || _uintValue(orderData, "callbackGasLimit") != registration.callbackGasLimit
                || _uintValue(orderData, "minOutputAmount") != registration.minOutputAmount
                || _uintValue(orderData, "validFromTime") != 0 || _uintValue(orderData, "srcChainId") != 0
                || _boolValue(orderData, "isLong") != registration.isLong
                || _boolValue(orderData, "shouldUnwrapNativeToken") || _boolValue(orderData, "autoCancel")
        ) revert InvalidOrderData();
        address[] calldata swapPath = _addressArrayValue(orderData, "swapPath");
        bytes32[] calldata dataList = _bytes32ArrayValue(orderData, "dataList");
        if (
            swapPath.length != 0 || dataList.length != 3 || dataList[0] != registration.packageId
                || dataList[1] != registration.entryRequestKey || dataList[2] != registration.authorizationHash
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

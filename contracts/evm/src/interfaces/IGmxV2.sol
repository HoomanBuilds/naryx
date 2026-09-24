// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

library GmxV2 {
    enum OrderType {
        MarketSwap,
        LimitSwap,
        MarketIncrease,
        LimitIncrease,
        MarketDecrease,
        LimitDecrease,
        StopLossDecrease,
        Liquidation,
        StopIncrease
    }

    enum DecreasePositionSwapType {
        NoSwap,
        SwapPnlTokenToCollateralToken,
        SwapCollateralTokenToPnlToken
    }

    struct CreateOrderParamsAddresses {
        address receiver;
        address cancellationReceiver;
        address callbackContract;
        address uiFeeReceiver;
        address market;
        address initialCollateralToken;
        address[] swapPath;
    }

    struct CreateOrderParamsNumbers {
        uint256 sizeDeltaUsd;
        uint256 initialCollateralDeltaAmount;
        uint256 triggerPrice;
        uint256 acceptablePrice;
        uint256 executionFee;
        uint256 callbackGasLimit;
        uint256 minOutputAmount;
        uint256 validFromTime;
    }

    struct CreateOrderParams {
        CreateOrderParamsAddresses addresses;
        CreateOrderParamsNumbers numbers;
        OrderType orderType;
        DecreasePositionSwapType decreasePositionSwapType;
        bool isLong;
        bool shouldUnwrapNativeToken;
        bool autoCancel;
        bytes32 referralCode;
        bytes32[] dataList;
    }

    struct AddressKeyValue {
        string key;
        address value;
    }

    struct AddressArrayKeyValue {
        string key;
        address[] value;
    }

    struct UintKeyValue {
        string key;
        uint256 value;
    }

    struct UintArrayKeyValue {
        string key;
        uint256[] value;
    }

    struct IntKeyValue {
        string key;
        int256 value;
    }

    struct IntArrayKeyValue {
        string key;
        int256[] value;
    }

    struct BoolKeyValue {
        string key;
        bool value;
    }

    struct BoolArrayKeyValue {
        string key;
        bool[] value;
    }

    struct Bytes32KeyValue {
        string key;
        bytes32 value;
    }

    struct Bytes32ArrayKeyValue {
        string key;
        bytes32[] value;
    }

    struct BytesKeyValue {
        string key;
        bytes value;
    }

    struct BytesArrayKeyValue {
        string key;
        bytes[] value;
    }

    struct StringKeyValue {
        string key;
        string value;
    }

    struct StringArrayKeyValue {
        string key;
        string[] value;
    }

    struct AddressItems {
        AddressKeyValue[] items;
        AddressArrayKeyValue[] arrayItems;
    }

    struct UintItems {
        UintKeyValue[] items;
        UintArrayKeyValue[] arrayItems;
    }

    struct IntItems {
        IntKeyValue[] items;
        IntArrayKeyValue[] arrayItems;
    }

    struct BoolItems {
        BoolKeyValue[] items;
        BoolArrayKeyValue[] arrayItems;
    }

    struct Bytes32Items {
        Bytes32KeyValue[] items;
        Bytes32ArrayKeyValue[] arrayItems;
    }

    struct BytesItems {
        BytesKeyValue[] items;
        BytesArrayKeyValue[] arrayItems;
    }

    struct StringItems {
        StringKeyValue[] items;
        StringArrayKeyValue[] arrayItems;
    }

    struct EventLogData {
        AddressItems addressItems;
        UintItems uintItems;
        IntItems intItems;
        BoolItems boolItems;
        Bytes32Items bytes32Items;
        BytesItems bytesItems;
        StringItems stringItems;
    }

    struct Deployment {
        address dataStore;
        address eventEmitter;
        address exchangeRouter;
        address router;
        address orderVault;
        address orderHandler;
        address roleStore;
        bytes32 dataStoreCodeHash;
        bytes32 eventEmitterCodeHash;
        bytes32 exchangeRouterCodeHash;
        bytes32 routerCodeHash;
        bytes32 orderVaultCodeHash;
        bytes32 orderHandlerCodeHash;
        bytes32 roleStoreCodeHash;
    }

    struct RequestRegistration {
        bytes32 packageId;
        bytes32 requestPayloadHash;
        address beneficiary;
        address refundRecipient;
        address market;
        address collateralToken;
        uint256 sizeDeltaUsd;
        bool isLong;
        uint256 collateralAtoms;
        uint256 acceptablePrice;
        uint256 executionFeeWei;
        uint256 callbackGasLimit;
        uint64 submissionDeadline;
        uint64 venueDeadline;
        uint64 recoveryDeadline;
    }

    struct SpotEntryRegistration {
        bytes32 packageId;
        bytes32 requestPayloadHash;
        address fundingOwner;
        address port;
        bytes32 portCodeHash;
        address baseToken;
        address quoteToken;
        uint256 packageNonce;
        bytes32 orderHash;
        bytes32 quoteHash;
        bytes32 routeHash;
        bytes32 entryFillCommitment;
        bytes32 rollbackFillCommitment;
        uint256 baseAtoms;
        uint256 maxQuoteAtoms;
        uint256 rollbackMinQuoteAtoms;
    }

    struct ExitRegistration {
        bytes32 packageId;
        bytes32 entryRequestKey;
        bytes32 authorizationHash;
        address account;
        address owner;
        address receiver;
        address feePayer;
        address executionFeeRefundRecipient;
        address market;
        address collateralToken;
        bool isLong;
        uint256 fullCloseSizeUsd;
        uint256 acceptablePrice;
        uint256 minOutputAmount;
        uint256 executionFeeWei;
        uint256 callbackGasLimit;
        uint64 authorizationExpiry;
        uint64 cancelAfter;
        uint256 nonce;
    }
}

interface IGmxV2ExchangeRouter {
    function dataStore() external view returns (address);
    function eventEmitter() external view returns (address);
    function router() external view returns (address);
    function orderHandler() external view returns (address);
    function roleStore() external view returns (address);
    function sendTokens(address token, address receiver, uint256 amount) external payable;
    function sendWnt(address receiver, uint256 amount) external payable;
    function createOrder(GmxV2.CreateOrderParams calldata params) external payable returns (bytes32);
    function cancelOrder(bytes32 key) external payable;
}

interface IGmxV2DataStore {
    function containsBytes32(bytes32 setKey, bytes32 value) external view returns (bool);
    function getUint(bytes32 key) external view returns (uint256);
}

interface IGmxV2RoleStore {
    function hasRole(address account, bytes32 roleKey) external view returns (bool);
}

interface IGmxV2OrderCallbackReceiver {
    function afterOrderExecution(
        bytes32 key,
        GmxV2.EventLogData calldata orderData,
        GmxV2.EventLogData calldata eventData
    ) external;

    function afterOrderCancellation(
        bytes32 key,
        GmxV2.EventLogData calldata orderData,
        GmxV2.EventLogData calldata eventData
    ) external;

    function afterOrderFrozen(bytes32 key, GmxV2.EventLogData calldata orderData, GmxV2.EventLogData calldata eventData)
        external;
}

interface IGmxV2OrderVerifier {
    function verify(
        address account,
        address callbackContract,
        GmxV2.RequestRegistration calldata registration,
        GmxV2.EventLogData calldata orderData
    ) external pure;
}

interface IGmxV2ExitOrderVerifier {
    function verify(
        address callbackContract,
        GmxV2.ExitRegistration calldata registration,
        GmxV2.EventLogData calldata orderData
    ) external pure;
}

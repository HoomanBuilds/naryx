// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Math} from "openzeppelin-contracts/utils/math/Math.sol";
import {ISynFuturesInstrument} from "../interfaces/ISynFuturesInstrument.sol";
import {ISynFuturesPositionObserver} from "../interfaces/ISynFuturesPositionObserver.sol";

contract NaryxBaseSepoliaPerpTestSupport is ISynFuturesInstrument, ISynFuturesPositionObserver {
    uint256 public constant BASE_SEPOLIA_CHAIN_ID = 84532;
    uint256 public constant LOCAL_CHAIN_ID = 31338;
    uint256 private constant WAD = 1e18;

    error ForcedRejection();
    error InvalidChain();
    error InvalidConfiguration();
    error InvalidInstrument();
    error InvalidTrade();
    error UnauthorizedCaller();

    event ForcedRejectionSet(bool enabled);
    event PositionChanged(address indexed strategyAccount, int128 balance, int128 size, uint128 entryNotional);

    address public immutable owner;
    address public immutable strategyAccount;
    uint32 public immutable expiry;
    uint128 public immutable entryPriceWad;
    uint128 public immutable maximumSizeWad;
    uint128 public immutable maximumBalanceWad;
    uint256 public immutable deploymentChainId;

    bool public forcedRejection;

    mapping(address target => Position position) private _positions;

    constructor(
        address owner_,
        address strategyAccount_,
        uint32 expiry_,
        uint128 entryPriceWad_,
        uint128 maximumSizeWad_,
        uint128 maximumBalanceWad_
    ) {
        if (block.chainid != BASE_SEPOLIA_CHAIN_ID && block.chainid != LOCAL_CHAIN_ID) {
            revert InvalidChain();
        }
        if (
            owner_ == address(0) || strategyAccount_ == address(0) || expiry_ == 0 || entryPriceWad_ == 0
                || maximumSizeWad_ == 0 || maximumSizeWad_ > uint128(type(int128).max) || maximumBalanceWad_ == 0
                || maximumBalanceWad_ > uint128(type(int128).max)
        ) revert InvalidConfiguration();

        owner = owner_;
        strategyAccount = strategyAccount_;
        expiry = expiry_;
        entryPriceWad = entryPriceWad_;
        maximumSizeWad = maximumSizeWad_;
        maximumBalanceWad = maximumBalanceWad_;
        deploymentChainId = block.chainid;
    }

    function setForcedRejection(bool enabled) external {
        if (msg.sender != owner) revert UnauthorizedCaller();
        _requireDeploymentChain();
        forcedRejection = enabled;
        emit ForcedRejectionSet(enabled);
    }

    function trade(bytes32[2] calldata args) external returns (PositionCache memory result) {
        if (msg.sender != strategyAccount) revert UnauthorizedCaller();
        _requireDeploymentChain();
        if (forcedRejection) revert ForcedRejection();

        uint256 tradeHeader = uint256(args[0]);
        uint64 deadline = uint64(tradeHeader >> 56);
        if (
            uint32(tradeHeader) != expiry || tradeHeader != (uint256(deadline) << 56 | uint256(expiry))
                || block.timestamp >= deadline
        ) revert InvalidTrade();

        uint256 packed = uint256(args[1]);
        int128 sizeDelta = int128(uint128(packed >> 128));
        int128 balanceDelta = int128(uint128(packed));
        Position storage position = _positions[msg.sender];

        if (position.size == 0) {
            _enter(position, sizeDelta, balanceDelta);
        } else {
            _close(position, sizeDelta, balanceDelta);
        }

        result.balance = position.balance;
        result.size = position.size;
        result.entryNotional = position.entryNotional;
        result.entrySocialLossIndex = position.entrySocialLossIndex;
        result.entryFundingIndex = position.entryFundingIndex;
        emit PositionChanged(msg.sender, position.balance, position.size, position.entryNotional);
    }

    function getPosition(address instrument, uint32 requestedExpiry, address target)
        external
        view
        returns (Position memory position)
    {
        _requireDeploymentChain();
        if (instrument != address(this)) revert InvalidInstrument();
        if (requestedExpiry != expiry) revert InvalidTrade();
        return _positions[target];
    }

    function _enter(Position storage position, int128 sizeDelta, int128 balanceDelta) private {
        if (sizeDelta >= 0 || balanceDelta <= 0) revert InvalidTrade();

        uint128 size = uint128(uint256(-int256(sizeDelta)));
        uint128 balance = uint128(balanceDelta);
        if (size > maximumSizeWad || balance > maximumBalanceWad) revert InvalidTrade();

        uint256 entryNotional = Math.mulDiv(uint256(size), uint256(entryPriceWad), WAD);
        if (entryNotional == 0 || entryNotional > type(uint128).max) revert InvalidTrade();

        position.balance = balanceDelta;
        position.size = sizeDelta;
        position.entryNotional = uint128(entryNotional);
    }

    function _close(Position storage position, int128 sizeDelta, int128 balanceDelta) private {
        if (sizeDelta != -position.size || balanceDelta != -position.balance) revert InvalidTrade();
        delete _positions[msg.sender];
    }

    function _requireDeploymentChain() private view {
        if (block.chainid != deploymentChainId) revert InvalidChain();
    }
}

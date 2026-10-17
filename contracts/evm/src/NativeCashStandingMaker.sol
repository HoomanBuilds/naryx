// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Ownable} from "openzeppelin-contracts/access/Ownable.sol";
import {Ownable2Step} from "openzeppelin-contracts/access/Ownable2Step.sol";
import {IERC20} from "openzeppelin-contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/utils/ReentrancyGuard.sol";
import {NativePackageClearingHouse} from "./NativePackageClearingHouse.sol";
import {NativeCashRangeMarket} from "./NativeCashRangeMarket.sol";

contract NativeCashStandingMaker is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    NativeCashRangeMarket public immutable controller;
    NativePackageClearingHouse public immutable clearingHouse;
    bytes32 public immutable makerAccountId;
    uint16 public immutable spreadBps;
    bool public enabled;

    error InvalidConfiguration();
    error InventoryIsActive();
    event QuotingChanged(bool enabled);
    event InventoryFunded(address indexed supplier, uint256 amount);
    event InventoryWithdrawn(address indexed recipient, uint256 amount);

    constructor(NativeCashRangeMarket controller_, bytes32 accountId_, address owner_, uint16 spreadBps_)
        Ownable(owner_)
    {
        if (address(controller_) == address(0) || accountId_ == bytes32(0) || spreadBps_ > 500) {
            revert InvalidConfiguration();
        }
        controller = controller_;
        clearingHouse = controller_.clearingHouse();
        makerAccountId = accountId_;
        spreadBps = spreadBps_;
        if (
            clearingHouse.packageQuantityIncrementAtoms() != 1 || clearingHouse.priceTickQuoteAtoms() != 1
                || clearingHouse.initialMarginQuoteAtomsPerIncrement() < controller_.maximumPriceTicks()
        ) {
            revert InvalidConfiguration();
        }
        clearingHouse.openAccount(accountId_);
    }

    function setEnabled(bool value) external onlyOwner {
        enabled = value;
        emit QuotingChanged(value);
    }

    function fund(uint256 amount) external nonReentrant {
        if (amount == 0) revert InvalidConfiguration();
        IERC20 token = clearingHouse.collateralToken();
        uint256 beforeBalance = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        if (token.balanceOf(address(this)) != beforeBalance + amount) revert InvalidConfiguration();
        token.forceApprove(address(clearingHouse), amount);
        clearingHouse.deposit(makerAccountId, amount);
        emit InventoryFunded(msg.sender, amount);
    }

    function withdraw(uint256 amount) external onlyOwner nonReentrant {
        if (enabled || clearingHouse.account(makerAccountId).positionAtoms != 0) revert InventoryIsActive();
        clearingHouse.normalizeFlatAccount(makerAccountId);
        clearingHouse.withdraw(makerAccountId, amount);
        clearingHouse.collateralToken().safeTransfer(owner(), amount);
        emit InventoryWithdrawn(owner(), amount);
    }

    function book()
        public
        view
        returns (uint128 bidTicks, uint128 askTicks, uint128 bidQuantity, uint128 askQuantity, uint64 validUntil)
    {
        uint128 price;
        (price, bidTicks, askTicks, validUntil) = _prices();
        (bidQuantity, askQuantity) = _capacity(price);
    }

    function _prices() private view returns (uint128 price, uint128 bidTicks, uint128 askTicks, uint64 validUntil) {
        uint64 sourceUntil;
        (price,,, sourceUntil) = controller.previewMark();
        (, uint128 storedPrice,, uint64 observedAt, uint64 storedUntil) = clearingHouse.currentMark();
        if (
            price != storedPrice || storedUntil <= block.timestamp || observedAt > block.timestamp
                || block.timestamp - observedAt > clearingHouse.markMaximumStalenessSeconds()
                || clearingHouse.feeBps() != 0
        ) {
            revert InvalidConfiguration();
        }
        uint256 offset = (uint256(price) * spreadBps + 9999) / 10000;
        bidTicks = offset >= price ? 1 : uint128(price - offset);
        uint256 ask = uint256(price) + offset;
        askTicks = ask > controller.maximumPriceTicks() ? controller.maximumPriceTicks() : uint128(ask);
        validUntil = sourceUntil < storedUntil ? sourceUntil : storedUntil;
    }

    function _capacity(uint128 price) private view returns (uint128 bidQuantity, uint128 askQuantity) {
        NativePackageClearingHouse.Account memory account_ = clearingHouse.account(makerAccountId);
        int256 position = account_.positionAtoms;
        int256 equity =
            int256(account_.collateralQuoteAtoms) + account_.cashBalanceQuoteAtoms + position * int256(uint256(price));
        if (equity < 0) return (0, 0);
        uint256 lots = uint256(equity) / clearingHouse.initialMarginQuoteAtomsPerIncrement();
        uint256 maxPosition = clearingHouse.maximumPositionAtoms();
        if (lots > maxPosition) lots = maxPosition;
        uint256 available = clearingHouse.maximumOpenInterestAtoms() - clearingHouse.openInterestAtoms();
        bidQuantity = _size(int256(lots) - position, available + (position < 0 ? uint256(-position) : 0));
        askQuantity = _size(int256(lots) + position, available + (position > 0 ? uint256(position) : 0));
        if (!enabled || clearingHouse.entryPaused()) {
            bidQuantity = position < 0 ? uint128(uint256(-position)) : 0;
            askQuantity = position > 0 ? uint128(uint256(position)) : 0;
        }
    }

    function _size(int256 target, uint256 cap) private pure returns (uint128) {
        return target <= 0 ? 0 : uint128(uint256(target) < cap ? uint256(target) : cap);
    }

    function isValidSignature(bytes32 digest, bytes calldata signature) external view returns (bytes4) {
        if (signature.length != 320) return bytes4(0xffffffff);
        NativePackageClearingHouse.NativeMatch memory match_ =
            abi.decode(signature, (NativePackageClearingHouse.NativeMatch));
        if (
            clearingHouse.matchDigest(match_) != digest || match_.expiry <= block.timestamp
                || match_.expiry > block.timestamp + 30 || match_.maxFeeBps != 0 || match_.quantityAtoms == 0
                || match_.longAccountId == match_.shortAccountId || match_.feePayerAccountId == makerAccountId
                || match_.priceTicks == 0 || match_.priceTicks > controller.maximumPriceTicks()
        ) {
            return bytes4(0xffffffff);
        }
        (uint128 bid, uint128 ask, uint128 bidSize, uint128 askSize,) = book();
        uint64 sequence = clearingHouse.account(makerAccountId).sequence;
        bool makerLong = match_.longAccountId == makerAccountId;
        bool makerShort = match_.shortAccountId == makerAccountId;
        bool accepted = makerLong && match_.longSequence == sequence && match_.quantityAtoms <= bidSize
            && match_.priceTicks <= bid || makerShort && match_.shortSequence == sequence
            && match_.quantityAtoms <= askSize && match_.priceTicks >= ask;
        if ((!enabled || clearingHouse.entryPaused()) && accepted) {
            NativePackageClearingHouse.Account memory other =
                clearingHouse.account(makerLong ? match_.shortAccountId : match_.longAccountId);
            accepted = makerLong
                ? other.positionAtoms > 0 && uint128(other.positionAtoms) >= match_.quantityAtoms
                : other.positionAtoms < 0 && uint256(-int256(other.positionAtoms)) >= match_.quantityAtoms;
        }
        return accepted ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }

    function renounceOwnership() public pure override {
        revert InvalidConfiguration();
    }
}

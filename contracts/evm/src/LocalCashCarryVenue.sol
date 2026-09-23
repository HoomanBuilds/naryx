// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "openzeppelin-contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "openzeppelin-contracts/utils/math/Math.sol";

contract LocalCashCarryVenue {
    using SafeERC20 for IERC20;

    struct ShortPosition {
        uint256 quantity;
        uint256 collateral;
    }

    error UnauthorizedExecutor();
    error InvalidConfiguration();
    error InvalidQuantity();
    error PositionExists();
    error PositionMismatch();
    error QuoteBoundExceeded();

    IERC20 public immutable baseToken;
    IERC20 public immutable quoteToken;
    address public immutable executor;
    uint256 public immutable priceNumerator;
    uint256 public immutable priceDenominator;
    mapping(address => ShortPosition) public shortPositions;

    modifier onlyExecutor() {
        if (msg.sender != executor) revert UnauthorizedExecutor();
        _;
    }

    constructor(IERC20 baseToken_, IERC20 quoteToken_, address executor_, uint256 numerator_, uint256 denominator_) {
        if (
            address(baseToken_).code.length == 0 || address(quoteToken_).code.length == 0
                || address(baseToken_) == address(quoteToken_) || executor_ == address(0) || numerator_ == 0
                || denominator_ == 0
        ) revert InvalidConfiguration();
        baseToken = baseToken_;
        quoteToken = quoteToken_;
        executor = executor_;
        priceNumerator = numerator_;
        priceDenominator = denominator_;
    }

    function buyExactOutput(uint256 quantity, uint256 maxQuote) external onlyExecutor returns (uint256 quoteIn) {
        if (quantity == 0) revert InvalidQuantity();
        quoteIn = Math.mulDiv(quantity, priceNumerator, priceDenominator, Math.Rounding.Ceil);
        if (quoteIn > maxQuote) revert QuoteBoundExceeded();
        quoteToken.safeTransferFrom(msg.sender, address(this), quoteIn);
        baseToken.safeTransfer(msg.sender, quantity);
    }

    function sellExactInput(uint256 quantity, uint256 minQuote) external onlyExecutor returns (uint256 quoteOut) {
        if (quantity == 0) revert InvalidQuantity();
        quoteOut = Math.mulDiv(quantity, priceNumerator, priceDenominator, Math.Rounding.Floor);
        if (quoteOut < minQuote) revert QuoteBoundExceeded();
        baseToken.safeTransferFrom(msg.sender, address(this), quantity);
        quoteToken.safeTransfer(msg.sender, quoteOut);
    }

    function openShort(address trader, uint256 quantity, uint256 collateral) external onlyExecutor {
        if (trader == address(0) || quantity == 0 || collateral == 0) revert InvalidQuantity();
        if (shortPositions[trader].quantity != 0) revert PositionExists();
        quoteToken.safeTransferFrom(msg.sender, address(this), collateral);
        shortPositions[trader] = ShortPosition(quantity, collateral);
    }

    function closeShort(address trader, uint256 quantity, uint256 collateral) external onlyExecutor {
        ShortPosition memory position = shortPositions[trader];
        if (position.quantity != quantity || position.collateral != collateral || quantity == 0) {
            revert PositionMismatch();
        }
        delete shortPositions[trader];
        quoteToken.safeTransfer(msg.sender, collateral);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "openzeppelin-contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "openzeppelin-contracts/utils/math/Math.sol";
import {SafeCast} from "openzeppelin-contracts/utils/math/SafeCast.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/utils/ReentrancyGuard.sol";
import {IPremiaV3Pool} from "../interfaces/IPremiaV3Pool.sol";

contract NaryxTestOptionPool is IPremiaV3Pool, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    uint256 private constant BPS = 10_000;
    uint256 public constant BASE_SEPOLIA_CHAIN_ID = 84_532;
    uint256 public constant ARBITRUM_SEPOLIA_CHAIN_ID = 421_614;
    uint256 public constant ANVIL_CHAIN_ID = 31_337;
    uint256 public constant LOCAL_EVM_CHAIN_ID = 31_338;
    uint256 public constant LONG_TOKEN_ID = 1;
    uint256 public constant SHORT_TOKEN_ID = 0;

    IERC20 public immutable baseToken;
    IERC20 public immutable quoteToken;
    IERC20 public immutable poolToken;
    address public immutable oracleAdapter;
    uint256 public immutable strike;
    uint256 public immutable maturity;
    bool public immutable isCallPool;
    uint16 public immutable premiumBps;
    uint16 public immutable exerciseValueBps;

    mapping(address account => uint256 amount) private _longs;
    mapping(address account => uint256 amount) private _shorts;
    mapping(address account => uint256 amount) private _shortCollateral;

    error TestnetOnly(uint256 chainId);
    error InvalidConfiguration();
    error InvalidTrade();
    error InsufficientLiquidity();
    error NotMatured();

    constructor(
        IERC20 baseToken_,
        IERC20 quoteToken_,
        address oracleAdapter_,
        uint256 strike_,
        uint256 maturity_,
        bool isCallPool_,
        uint16 premiumBps_,
        uint16 exerciseValueBps_
    ) {
        if (!_supportedChain()) revert TestnetOnly(block.chainid);
        if (
            address(baseToken_).code.length == 0 || address(quoteToken_).code.length == 0
                || address(baseToken_) == address(quoteToken_) || oracleAdapter_.code.length == 0 || strike_ == 0
                || maturity_ <= block.timestamp || premiumBps_ == 0 || premiumBps_ >= BPS || exerciseValueBps_ > BPS
        ) revert InvalidConfiguration();
        baseToken = baseToken_;
        quoteToken = quoteToken_;
        poolToken = isCallPool_ ? baseToken_ : quoteToken_;
        oracleAdapter = oracleAdapter_;
        strike = strike_;
        maturity = maturity_;
        isCallPool = isCallPool_;
        premiumBps = premiumBps_;
        exerciseValueBps = exerciseValueBps_;
    }

    function getPoolSettings() external view returns (address, address, address, uint256, uint256, bool) {
        return (address(baseToken), address(quoteToken), oracleAdapter, strike, maturity, isCallPool);
    }

    function trade(uint256 size, bool isBuy, uint256 premiumLimit, address)
        external
        nonReentrant
        returns (uint256 totalPremium, PositionDelta memory delta)
    {
        if (size == 0 || block.timestamp >= maturity) revert InvalidTrade();
        totalPremium = Math.mulDiv(size, premiumBps, BPS, Math.Rounding.Ceil);
        if (isBuy) {
            if (totalPremium > premiumLimit) revert InvalidTrade();
            poolToken.safeTransferFrom(msg.sender, address(this), totalPremium);
            uint256 shorts = _shorts[msg.sender];
            if (shorts == 0) {
                _longs[msg.sender] += size;
                delta.longs = size.toInt256();
                delta.collateral = -totalPremium.toInt256();
            } else {
                if (shorts < size) revert InvalidTrade();
                uint256 collateral = Math.mulDiv(_shortCollateral[msg.sender], size, shorts);
                _shorts[msg.sender] = shorts - size;
                _shortCollateral[msg.sender] -= collateral;
                poolToken.safeTransfer(msg.sender, collateral);
                delta.shorts = -size.toInt256();
                delta.collateral = collateral.toInt256() - totalPremium.toInt256();
            }
        } else {
            if (totalPremium < premiumLimit || poolToken.balanceOf(address(this)) < totalPremium) {
                revert InsufficientLiquidity();
            }
            uint256 longs = _longs[msg.sender];
            if (longs == 0) {
                poolToken.safeTransferFrom(msg.sender, address(this), size);
                _shorts[msg.sender] += size;
                _shortCollateral[msg.sender] += size;
                delta.shorts = size.toInt256();
                delta.collateral = totalPremium.toInt256() - size.toInt256();
            } else {
                if (longs < size) revert InvalidTrade();
                _longs[msg.sender] = longs - size;
                delta.longs = -size.toInt256();
                delta.collateral = totalPremium.toInt256();
            }
            poolToken.safeTransfer(msg.sender, totalPremium);
        }
    }

    function exercise() external nonReentrant returns (uint256 exerciseValue, uint256 exerciseFee) {
        if (block.timestamp < maturity) revert NotMatured();
        uint256 longs = _longs[msg.sender];
        if (longs == 0) revert InvalidTrade();
        exerciseValue = Math.mulDiv(longs, exerciseValueBps, BPS);
        if (poolToken.balanceOf(address(this)) < exerciseValue) revert InsufficientLiquidity();
        delete _longs[msg.sender];
        if (exerciseValue != 0) poolToken.safeTransfer(msg.sender, exerciseValue);
        return (exerciseValue, 0);
    }

    function settle() external nonReentrant returns (uint256 collateral) {
        if (block.timestamp < maturity) revert NotMatured();
        uint256 shorts = _shorts[msg.sender];
        if (shorts == 0) revert InvalidTrade();
        collateral = _shortCollateral[msg.sender];
        delete _shorts[msg.sender];
        delete _shortCollateral[msg.sender];
        if (collateral != 0) poolToken.safeTransfer(msg.sender, collateral);
    }

    function balanceOf(address account, uint256 tokenId) external view returns (uint256) {
        return tokenId == LONG_TOKEN_ID ? _longs[account] : tokenId == SHORT_TOKEN_ID ? _shorts[account] : 0;
    }

    function _supportedChain() private view returns (bool) {
        return block.chainid == BASE_SEPOLIA_CHAIN_ID || block.chainid == ARBITRUM_SEPOLIA_CHAIN_ID
            || block.chainid == ANVIL_CHAIN_ID || block.chainid == LOCAL_EVM_CHAIN_ID;
    }
}

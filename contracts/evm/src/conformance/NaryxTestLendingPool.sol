// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "openzeppelin-contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "openzeppelin-contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "openzeppelin-contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "openzeppelin-contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/utils/ReentrancyGuard.sol";
import {IAaveV3Pool} from "../interfaces/IAaveV3Pool.sol";

interface INaryxTestMintableToken is IERC20 {
    function mint(address recipient, uint256 amount) external;
}

contract NaryxTestLendingPool is IAaveV3Pool, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 private constant BPS = 10_000;
    uint256 private constant WAD = 1e18;
    uint256 public constant BASE_SEPOLIA_CHAIN_ID = 84_532;
    uint256 public constant ARBITRUM_SEPOLIA_CHAIN_ID = 421_614;
    uint256 public constant ANVIL_CHAIN_ID = 31_337;
    uint256 public constant LOCAL_EVM_CHAIN_ID = 31_338;

    IERC20 public immutable collateralToken;
    INaryxTestMintableToken public immutable debtToken;
    uint256 public immutable collateralUnit;
    uint256 public immutable collateralPriceDebtAtomsPerWholeToken;
    uint16 public immutable loanToValueBps;
    uint16 public immutable liquidationThresholdBps;

    mapping(address account => uint256 amount) public collateralOf;
    mapping(address account => uint256 amount) public debtOf;

    error TestnetOnly(uint256 chainId);
    error InvalidConfiguration();
    error InvalidAction();
    error InsufficientCollateral();

    constructor(
        IERC20 collateralToken_,
        INaryxTestMintableToken debtToken_,
        uint256 collateralPriceDebtAtomsPerWholeToken_,
        uint16 loanToValueBps_,
        uint16 liquidationThresholdBps_
    ) {
        if (!_supportedChain()) revert TestnetOnly(block.chainid);
        if (
            address(collateralToken_).code.length == 0 || address(debtToken_).code.length == 0
                || address(collateralToken_) == address(debtToken_) || loanToValueBps_ == 0
                || loanToValueBps_ >= liquidationThresholdBps_ || liquidationThresholdBps_ > BPS
                || collateralPriceDebtAtomsPerWholeToken_ == 0
        ) revert InvalidConfiguration();
        uint8 collateralDecimals = IERC20Metadata(address(collateralToken_)).decimals();
        if (collateralDecimals > 18) revert InvalidConfiguration();
        collateralToken = collateralToken_;
        debtToken = debtToken_;
        collateralUnit = 10 ** collateralDecimals;
        collateralPriceDebtAtomsPerWholeToken = collateralPriceDebtAtomsPerWholeToken_;
        loanToValueBps = loanToValueBps_;
        liquidationThresholdBps = liquidationThresholdBps_;
    }

    function supply(address asset, uint256 amount, address onBehalfOf, uint16) external nonReentrant {
        if (asset != address(collateralToken) || amount == 0 || onBehalfOf == address(0)) revert InvalidAction();
        collateralToken.safeTransferFrom(msg.sender, address(this), amount);
        collateralOf[onBehalfOf] += amount;
    }

    function withdraw(address asset, uint256 amount, address to) external nonReentrant returns (uint256) {
        uint256 collateral = collateralOf[msg.sender];
        if (asset != address(collateralToken) || amount == 0 || amount > collateral || to == address(0)) {
            revert InvalidAction();
        }
        uint256 remaining = collateral - amount;
        if (debtOf[msg.sender] > Math.mulDiv(_collateralValue(remaining), loanToValueBps, BPS)) {
            revert InsufficientCollateral();
        }
        collateralOf[msg.sender] = remaining;
        collateralToken.safeTransfer(to, amount);
        return amount;
    }

    function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16, address onBehalfOf)
        external
        nonReentrant
    {
        if (asset != address(debtToken) || amount == 0 || interestRateMode != 2 || onBehalfOf != msg.sender) {
            revert InvalidAction();
        }
        uint256 nextDebt = debtOf[msg.sender] + amount;
        if (nextDebt > Math.mulDiv(_collateralValue(collateralOf[msg.sender]), loanToValueBps, BPS)) {
            revert InsufficientCollateral();
        }
        debtOf[msg.sender] = nextDebt;
        debtToken.mint(msg.sender, amount);
    }

    function repay(address asset, uint256 amount, uint256 interestRateMode, address onBehalfOf)
        external
        nonReentrant
        returns (uint256 repaid)
    {
        if (asset != address(debtToken) || amount == 0 || interestRateMode != 2 || onBehalfOf != msg.sender) {
            revert InvalidAction();
        }
        uint256 debt = debtOf[msg.sender];
        repaid = amount < debt ? amount : debt;
        if (repaid == 0) revert InvalidAction();
        IERC20(address(debtToken)).safeTransferFrom(msg.sender, address(this), repaid);
        debtOf[msg.sender] = debt - repaid;
    }

    function getUserAccountData(address user)
        external
        view
        returns (uint256, uint256, uint256, uint256, uint256, uint256)
    {
        uint256 collateral = _collateralValue(collateralOf[user]);
        uint256 debt = debtOf[user];
        uint256 borrowLimit = Math.mulDiv(collateral, loanToValueBps, BPS);
        uint256 available = borrowLimit > debt ? borrowLimit - debt : 0;
        uint256 healthFactor =
            debt == 0 ? type(uint256).max : Math.mulDiv(collateral, uint256(liquidationThresholdBps) * WAD, debt * BPS);
        return (collateral, debt, available, liquidationThresholdBps, loanToValueBps, healthFactor);
    }

    function _collateralValue(uint256 collateralAtoms) private view returns (uint256) {
        return Math.mulDiv(collateralAtoms, collateralPriceDebtAtomsPerWholeToken, collateralUnit);
    }

    function _supportedChain() private view returns (bool) {
        return block.chainid == BASE_SEPOLIA_CHAIN_ID || block.chainid == ARBITRUM_SEPOLIA_CHAIN_ID
            || block.chainid == ANVIL_CHAIN_ID || block.chainid == LOCAL_EVM_CHAIN_ID;
    }
}

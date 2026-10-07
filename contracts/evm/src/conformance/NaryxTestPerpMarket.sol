// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "openzeppelin-contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "openzeppelin-contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "openzeppelin-contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "openzeppelin-contracts/utils/math/Math.sol";
import {SafeCast} from "openzeppelin-contracts/utils/math/SafeCast.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/utils/ReentrancyGuard.sol";
import {AggregatorV3Interface} from "../interfaces/IAggregatorV3.sol";
import {IPerpMarginGate} from "../interfaces/IPerpMarginGate.sol";
import {ISynFuturesInstrument} from "../interfaces/ISynFuturesInstrument.sol";
import {ISynFuturesPositionObserver} from "../interfaces/ISynFuturesPositionObserver.sol";

/// @notice Test perpetual for Base Sepolia that prices, charges, funds, margins, and liquidates the way a
/// venue does, so testnet package results predict mainnet ones. The market is every taker's counterparty:
/// a trader's loss accrues to the insurance balance and a trader's profit is paid from it. Margin comes
/// only from the trader's free reserve in this gate, never from the trader's wallet during a trade.
/// Reserves are collateral atoms; position balances, notionals, prices, and insurance are WAD.
contract NaryxTestPerpMarket is ISynFuturesInstrument, ISynFuturesPositionObserver, IPerpMarginGate, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;
    using SafeCast for int256;

    uint256 public constant BASE_SEPOLIA_CHAIN_ID = 84532;
    uint256 public constant FOUNDRY_CHAIN_ID = 31337;
    uint256 public constant LOCAL_CHAIN_ID = 31338;
    uint256 public constant MAX_ORACLE_AGE_SECONDS = 1 days;
    uint256 public constant MAX_TAKER_FEE_BPS = 100;
    uint256 public constant MAX_SLIPPAGE_BPS = 500;
    uint256 public constant MAX_LIQUIDATION_PENALTY_BPS = 500;
    uint256 public constant MAX_FUNDING_RATE_PER_SECOND = 1e17;
    uint256 private constant WAD = 1e18;
    uint256 private constant BPS = 10_000;

    struct Parameters {
        address owner;
        address fundingKeeper;
        address feeRecipient;
        IERC20 collateral;
        AggregatorV3Interface oracle;
        uint32 expiry;
        uint32 maxOracleAgeSeconds;
        uint16 takerFeeBps;
        uint16 halfSpreadBps;
        uint16 impactBps;
        uint128 impactSizeWad;
        uint16 initialMarginBps;
        uint16 maintenanceMarginBps;
        uint16 liquidationPenaltyBps;
        uint128 maxPositionSizeWad;
        uint128 maxMarginWad;
        uint128 maxAbsFundingRatePerSecond;
    }

    struct Settlement {
        uint256 exitNotional;
        int256 realizedPnl;
        int256 funding;
        uint256 charged;
        uint256 payout;
        uint256 badDebt;
    }

    error InvalidChain();
    error InvalidConfiguration();
    error UnauthorizedCaller();
    error InvalidAmount();
    error InsufficientReserve();
    error TransferMismatch();
    error InvalidInstrument();
    error InvalidExpiry();
    error InvalidTradeHeader();
    error InvalidTradeShape();
    error OpensPaused();
    error PositionTooLarge();
    error MarginTooLarge();
    error InsufficientInitialMargin();
    error NoPosition();
    error PositionHealthy();
    error InsuranceInsufficient();
    error FundingRateTooLarge();
    error OracleChanged();
    error InvalidOraclePrice();
    error StaleOraclePrice();
    error IncompleteOracleRound();

    event Deposited(address indexed trader, uint256 amount);
    event Withdrawn(address indexed trader, uint256 amount);
    event InsuranceFunded(address indexed funder, uint256 amount);
    event PositionOpened(
        address indexed trader,
        int128 size,
        int128 margin,
        uint128 entryNotional,
        uint256 fillPriceWad,
        uint256 feeWad,
        int128 entryFundingIndex
    );
    event PositionClosed(
        address indexed trader,
        int128 size,
        uint256 exitNotional,
        int256 realizedPnl,
        int256 funding,
        uint256 feeWad,
        uint256 payoutWad,
        uint256 badDebtWad
    );
    event PositionLiquidated(
        address indexed trader,
        address indexed liquidator,
        int128 size,
        uint256 exitNotional,
        int256 realizedPnl,
        int256 funding,
        uint256 penaltyWad,
        uint256 payoutWad,
        uint256 badDebtWad
    );
    event FundingRateSet(int256 ratePerSecond, int256 fundingIndex);
    event FundingKeeperSet(address indexed keeper);
    event OpensPausedSet(bool paused);

    address public immutable owner;
    address public immutable feeRecipient;
    IERC20 public immutable collateral;
    AggregatorV3Interface public immutable oracle;
    bytes32 public immutable oracleCodeHash;
    uint32 public immutable expiry;
    uint32 public immutable maxOracleAgeSeconds;
    uint16 public immutable takerFeeBps;
    uint16 public immutable halfSpreadBps;
    uint16 public immutable impactBps;
    uint128 public immutable impactSizeWad;
    uint16 public immutable initialMarginBps;
    uint16 public immutable maintenanceMarginBps;
    uint16 public immutable liquidationPenaltyBps;
    uint128 public immutable maxPositionSizeWad;
    uint128 public immutable maxMarginWad;
    uint128 public immutable maxAbsFundingRatePerSecond;
    uint256 public immutable collateralScale;
    uint256 private immutable _oracleScale;
    uint256 public immutable deploymentChainId;

    /// @notice Mirrors the funding a real venue pays. The keeper sets the rate in quote WAD per base WAD
    /// per second, positive when longs pay shorts, bounded by `maxAbsFundingRatePerSecond`.
    address public fundingKeeper;
    bool public opensPaused;
    int256 public fundingRatePerSecond;
    int256 public fundingIndex;
    uint64 public lastFundingUpdate;
    uint256 public insuranceWad;
    uint256 public badDebtWad;
    uint256 public totalReserveAtoms;
    uint256 public totalMarginWad;

    mapping(address trader => uint256 atoms) private _reserves;
    mapping(address trader => Position position) private _positions;

    constructor(Parameters memory parameters) {
        if (
            block.chainid != BASE_SEPOLIA_CHAIN_ID && block.chainid != FOUNDRY_CHAIN_ID
                && block.chainid != LOCAL_CHAIN_ID
        ) revert InvalidChain();
        if (
            parameters.owner == address(0) || parameters.fundingKeeper == address(0)
                || parameters.feeRecipient == address(0) || address(parameters.collateral).code.length == 0
                || address(parameters.oracle).code.length == 0 || parameters.expiry == 0
                || parameters.maxOracleAgeSeconds == 0 || parameters.maxOracleAgeSeconds > MAX_ORACLE_AGE_SECONDS
                || parameters.takerFeeBps > MAX_TAKER_FEE_BPS || parameters.maintenanceMarginBps == 0
                || parameters.maintenanceMarginBps >= parameters.initialMarginBps || parameters.initialMarginBps > BPS
                || parameters.liquidationPenaltyBps > MAX_LIQUIDATION_PENALTY_BPS || parameters.impactSizeWad == 0
                || parameters.maxPositionSizeWad == 0 || parameters.maxPositionSizeWad > uint128(type(int128).max)
                || parameters.maxMarginWad == 0 || parameters.maxMarginWad > uint128(type(int128).max)
                || parameters.maxAbsFundingRatePerSecond > MAX_FUNDING_RATE_PER_SECOND
                || _slippage(
                        parameters.halfSpreadBps,
                        parameters.impactBps,
                        parameters.impactSizeWad,
                        parameters.maxPositionSizeWad
                    ) > MAX_SLIPPAGE_BPS * WAD
        ) revert InvalidConfiguration();
        uint8 collateralDecimals = IERC20Metadata(address(parameters.collateral)).decimals();
        uint8 oracleDecimals = parameters.oracle.decimals();
        if (collateralDecimals > 18 || oracleDecimals > 18) revert InvalidConfiguration();

        owner = parameters.owner;
        fundingKeeper = parameters.fundingKeeper;
        feeRecipient = parameters.feeRecipient;
        collateral = parameters.collateral;
        oracle = parameters.oracle;
        oracleCodeHash = address(parameters.oracle).codehash;
        expiry = parameters.expiry;
        maxOracleAgeSeconds = parameters.maxOracleAgeSeconds;
        takerFeeBps = parameters.takerFeeBps;
        halfSpreadBps = parameters.halfSpreadBps;
        impactBps = parameters.impactBps;
        impactSizeWad = parameters.impactSizeWad;
        initialMarginBps = parameters.initialMarginBps;
        maintenanceMarginBps = parameters.maintenanceMarginBps;
        liquidationPenaltyBps = parameters.liquidationPenaltyBps;
        maxPositionSizeWad = parameters.maxPositionSizeWad;
        maxMarginWad = parameters.maxMarginWad;
        maxAbsFundingRatePerSecond = parameters.maxAbsFundingRatePerSecond;
        collateralScale = 10 ** (18 - collateralDecimals);
        _oracleScale = 10 ** (18 - oracleDecimals);
        deploymentChainId = block.chainid;
        lastFundingUpdate = uint64(block.timestamp);
    }

    function deposit(uint256 amount) external nonReentrant {
        _requireDeploymentChain();
        if (amount == 0) revert InvalidAmount();
        _pull(amount);
        _reserves[msg.sender] += amount;
        totalReserveAtoms += amount;
        emit Deposited(msg.sender, amount);
    }

    function withdraw(uint256 amount) external nonReentrant {
        _requireDeploymentChain();
        uint256 reserve = _reserves[msg.sender];
        if (amount == 0) revert InvalidAmount();
        if (amount > reserve) revert InsufficientReserve();
        _reserves[msg.sender] = reserve - amount;
        totalReserveAtoms -= amount;
        uint256 balanceBefore = collateral.balanceOf(address(this));
        collateral.safeTransfer(msg.sender, amount);
        if (collateral.balanceOf(address(this)) != balanceBefore - amount) revert TransferMismatch();
        emit Withdrawn(msg.sender, amount);
    }

    function reserveOf(address trader) external view returns (uint256) {
        return _reserves[trader];
    }

    /// @notice Adds counterparty capital that pays trader profits. It has no withdrawal path.
    function fundInsurance(uint256 amount) external nonReentrant {
        _onlyOwner();
        if (amount == 0) revert InvalidAmount();
        _pull(amount);
        insuranceWad += amount * collateralScale;
        emit InsuranceFunded(msg.sender, amount);
    }

    /// @notice Opens from flat (`sizeDelta != 0`, `balanceDelta > 0` drawn from the free reserve) or closes
    /// the whole position (`sizeDelta == -size`, `balanceDelta == 0`). Any other shape is rejected.
    function trade(bytes32[2] calldata args) external nonReentrant returns (PositionCache memory result) {
        _requireDeploymentChain();
        uint256 tradeHeader = uint256(args[0]);
        uint64 deadline = uint64(tradeHeader >> 56);
        if (
            uint32(tradeHeader) != expiry || tradeHeader != (uint256(deadline) << 56 | uint256(expiry))
                || block.timestamp >= deadline
        ) revert InvalidTradeHeader();

        _accrueFunding();
        uint256 packed = uint256(args[1]);
        int128 sizeDelta = int128(uint128(packed >> 128));
        int128 balanceDelta = int128(uint128(packed));
        Position storage position = _positions[msg.sender];
        if (position.size == 0) {
            _open(position, sizeDelta, balanceDelta);
        } else {
            _close(position, sizeDelta, balanceDelta);
        }

        result.balance = position.balance;
        result.size = position.size;
        result.entryNotional = position.entryNotional;
        result.entrySocialLossIndex = position.entrySocialLossIndex;
        result.entryFundingIndex = position.entryFundingIndex;
    }

    /// @notice Closes an unhealthy position at the oracle price: equity (margin, unrealized PnL, and
    /// funding) below the maintenance margin of the oracle notional. The penalty goes to the fee recipient,
    /// the remainder, floored at zero, to the trader's reserve.
    function liquidate(address trader) external nonReentrant returns (uint256 payoutWad) {
        _requireDeploymentChain();
        _accrueFunding();
        Position memory position = _positions[trader];
        if (position.size == 0) revert NoPosition();
        uint256 sizeAbs = _abs(position.size);
        uint256 exitNotional = _notional(sizeAbs, oraclePriceWad(), position.size < 0);
        (int256 realizedPnl, int256 funding, int256 equity) = _equity(position, exitNotional);
        if (equity >= int256(Math.mulDiv(exitNotional, maintenanceMarginBps, BPS))) revert PositionHealthy();

        Settlement memory settlement = _settle(
            trader, position, exitNotional, realizedPnl, funding, equity, _feeWad(exitNotional, liquidationPenaltyBps)
        );
        emit PositionLiquidated(
            trader,
            msg.sender,
            position.size,
            exitNotional,
            realizedPnl,
            funding,
            settlement.charged,
            settlement.payout,
            settlement.badDebt
        );
        return settlement.payout;
    }

    function setFundingRatePerSecond(int256 ratePerSecond) external nonReentrant {
        _requireDeploymentChain();
        if (msg.sender != fundingKeeper) revert UnauthorizedCaller();
        if (_abs(ratePerSecond) > maxAbsFundingRatePerSecond) revert FundingRateTooLarge();
        _accrueFunding();
        fundingRatePerSecond = ratePerSecond;
        emit FundingRateSet(ratePerSecond, fundingIndex);
    }

    function setFundingKeeper(address keeper) external {
        _onlyOwner();
        if (keeper == address(0)) revert InvalidConfiguration();
        fundingKeeper = keeper;
        emit FundingKeeperSet(keeper);
    }

    /// @notice Pauses new opens only. Closes, liquidations, and reserve withdrawals stay available.
    function setOpensPaused(bool paused) external {
        _onlyOwner();
        opensPaused = paused;
        emit OpensPausedSet(paused);
    }

    function getPosition(address instrument, uint32 requestedExpiry, address target)
        external
        view
        returns (Position memory)
    {
        _requireDeploymentChain();
        if (instrument != address(this)) revert InvalidInstrument();
        if (requestedExpiry != expiry) revert InvalidExpiry();
        return _positions[target];
    }

    function oraclePriceWad() public view returns (uint256) {
        _requireDeploymentChain();
        if (address(oracle).codehash != oracleCodeHash) revert OracleChanged();
        (uint80 roundId, int256 answer,, uint256 updatedAt, uint80 answeredInRound) = oracle.latestRoundData();
        if (answer <= 0) revert InvalidOraclePrice();
        if (updatedAt == 0 || updatedAt > block.timestamp || block.timestamp - updatedAt > maxOracleAgeSeconds) {
            revert StaleOraclePrice();
        }
        if (answeredInRound < roundId) revert IncompleteOracleRound();
        return uint256(answer) * _oracleScale;
    }

    /// @notice The funding index including accrual up to this block.
    function currentFundingIndex() public view returns (int256) {
        return fundingIndex + fundingRatePerSecond * int256(block.timestamp - lastFundingUpdate);
    }

    /// @notice What an open of this shape fills at against the current oracle. The executed fill uses the
    /// oracle at execution, so a package bounds the post-trade balance and entry notional with a range.
    function previewOpen(int128 sizeDelta, uint256 balanceWad)
        external
        view
        returns (uint256 fillPriceWad, uint256 entryNotionalWad, uint256 feeWad, uint256 marginWad)
    {
        if (sizeDelta == 0) revert InvalidTradeShape();
        (fillPriceWad, entryNotionalWad, feeWad) = _quoteOpen(sizeDelta);
        marginWad = balanceWad > feeWad ? balanceWad - feeWad : 0;
    }

    /// @notice Equity at the oracle price and the maintenance requirement a liquidation is judged against.
    function health(address trader) external view returns (int256 equityWad, uint256 maintenanceWad) {
        Position memory position = _positions[trader];
        if (position.size == 0) revert NoPosition();
        uint256 exitNotional = _notional(_abs(position.size), oraclePriceWad(), position.size < 0);
        (,, equityWad) = _equity(position, exitNotional);
        maintenanceWad = Math.mulDiv(exitNotional, maintenanceMarginBps, BPS);
    }

    function _open(Position storage position, int128 sizeDelta, int128 balanceDelta) private {
        if (opensPaused) revert OpensPaused();
        if (sizeDelta == 0 || balanceDelta <= 0) revert InvalidTradeShape();
        uint256 balance = uint256(int256(balanceDelta));
        if (_abs(sizeDelta) > maxPositionSizeWad) revert PositionTooLarge();
        if (balance > maxMarginWad) revert MarginTooLarge();
        (uint256 fillPrice, uint256 entryNotional, uint256 fee) = _quoteOpen(sizeDelta);
        if (entryNotional == 0) revert InvalidTradeShape();
        if (fee >= balance || balance - fee < Math.mulDiv(entryNotional, initialMarginBps, BPS, Math.Rounding.Ceil)) {
            revert InsufficientInitialMargin();
        }
        _debitMargin(balance, fee);

        position.balance = int256(balance - fee).toInt128();
        position.size = sizeDelta;
        position.entryNotional = entryNotional.toUint128();
        position.entryFundingIndex = fundingIndex.toInt128();
        emit PositionOpened(
            msg.sender, sizeDelta, position.balance, position.entryNotional, fillPrice, fee, position.entryFundingIndex
        );
    }

    function _quoteOpen(int128 sizeDelta) private view returns (uint256 fillPrice, uint256 entryNotional, uint256 fee) {
        uint256 sizeAbs = _abs(sizeDelta);
        bool buy = sizeDelta > 0;
        fillPrice = _fillPrice(oraclePriceWad(), sizeAbs, buy);
        entryNotional = _notional(sizeAbs, fillPrice, buy);
        fee = _feeWad(entryNotional, takerFeeBps);
    }

    /// @dev Moves the whole balance out of the trader's reserve: the fee to the fee recipient's reserve,
    /// the rest into position margin.
    function _debitMargin(uint256 balance, uint256 fee) private {
        if (balance % collateralScale != 0) revert InvalidAmount();
        uint256 balanceAtoms = balance / collateralScale;
        uint256 reserve = _reserves[msg.sender];
        if (reserve < balanceAtoms) revert InsufficientReserve();
        uint256 feeAtoms = fee / collateralScale;
        _reserves[msg.sender] = reserve - balanceAtoms;
        _reserves[feeRecipient] += feeAtoms;
        totalReserveAtoms = totalReserveAtoms - balanceAtoms + feeAtoms;
        totalMarginWad += balance - fee;
    }

    function _close(Position storage stored, int128 sizeDelta, int128 balanceDelta) private {
        Position memory position = stored;
        if (sizeDelta != -position.size || balanceDelta != 0) revert InvalidTradeShape();
        uint256 sizeAbs = _abs(position.size);
        bool buy = sizeDelta > 0;
        uint256 exitNotional = _notional(sizeAbs, _fillPrice(oraclePriceWad(), sizeAbs, buy), buy);
        (int256 realizedPnl, int256 funding, int256 equity) = _equity(position, exitNotional);
        Settlement memory settlement = _settle(
            msg.sender, position, exitNotional, realizedPnl, funding, equity, _feeWad(exitNotional, takerFeeBps)
        );
        emit PositionClosed(
            msg.sender,
            position.size,
            exitNotional,
            realizedPnl,
            funding,
            settlement.charged,
            settlement.payout,
            settlement.badDebt
        );
    }

    /// @dev The charge is collected only from positive equity and the payout is floored at zero; a loss
    /// beyond the margin is recorded as bad debt. The trader's margin moves to the insurance balance,
    /// which pays out the charge and the payout and reverts the settlement rather than going negative.
    function _settle(
        address trader,
        Position memory position,
        uint256 exitNotional,
        int256 realizedPnl,
        int256 funding,
        int256 equity,
        uint256 charge
    ) private returns (Settlement memory settlement) {
        settlement.exitNotional = exitNotional;
        settlement.realizedPnl = realizedPnl;
        settlement.funding = funding;
        if (equity > 0) {
            uint256 positive = uint256(equity);
            settlement.charged = Math.min(charge, _floorToAtom(positive));
            settlement.payout = _floorToAtom(positive - settlement.charged);
        } else {
            settlement.badDebt = uint256(-equity);
        }
        uint256 margin = uint256(int256(position.balance));
        uint256 available = insuranceWad + margin;
        if (available < settlement.payout + settlement.charged) revert InsuranceInsufficient();
        insuranceWad = available - settlement.payout - settlement.charged;
        totalMarginWad -= margin;
        badDebtWad += settlement.badDebt;
        uint256 payoutAtoms = settlement.payout / collateralScale;
        uint256 chargedAtoms = settlement.charged / collateralScale;
        _reserves[trader] += payoutAtoms;
        _reserves[feeRecipient] += chargedAtoms;
        totalReserveAtoms += payoutAtoms + chargedAtoms;
        delete _positions[trader];
    }

    function _equity(Position memory position, uint256 exitNotional)
        private
        view
        returns (int256 realizedPnl, int256 funding, int256 equity)
    {
        int256 entryNotional = int256(uint256(position.entryNotional));
        realizedPnl = position.size < 0 ? entryNotional - int256(exitNotional) : int256(exitNotional) - entryNotional;
        int256 accrued = -int256(position.size) * (currentFundingIndex() - position.entryFundingIndex);
        // Funding rounds against the trader.
        funding = accrued >= 0 ? accrued / int256(WAD) : -int256(Math.ceilDiv(uint256(-accrued), WAD));
        equity = int256(position.balance) + realizedPnl + funding;
    }

    function _accrueFunding() private {
        if (block.timestamp == lastFundingUpdate) return;
        fundingIndex = currentFundingIndex();
        lastFundingUpdate = uint64(block.timestamp);
    }

    function _pull(uint256 amount) private {
        uint256 balanceBefore = collateral.balanceOf(address(this));
        collateral.safeTransferFrom(msg.sender, address(this), amount);
        if (collateral.balanceOf(address(this)) != balanceBefore + amount) revert TransferMismatch();
    }

    /// @dev The fill moves away from the oracle by the half spread plus size-linear impact: up for a buy,
    /// down for a sell, and the notional rounds against the taker.
    function _fillPrice(uint256 oraclePrice, uint256 sizeAbs, bool buy) private view returns (uint256) {
        uint256 slippage = _slippage(halfSpreadBps, impactBps, impactSizeWad, sizeAbs);
        return buy
            ? Math.mulDiv(oraclePrice, BPS * WAD + slippage, BPS * WAD, Math.Rounding.Ceil)
            : Math.mulDiv(oraclePrice, BPS * WAD - slippage, BPS * WAD);
    }

    function _notional(uint256 sizeAbs, uint256 price, bool buy) private pure returns (uint256) {
        return Math.mulDiv(sizeAbs, price, WAD, buy ? Math.Rounding.Ceil : Math.Rounding.Floor);
    }

    /// @dev Rounded up to a whole collateral atom so every charge settles exactly.
    function _feeWad(uint256 notional, uint256 rateBps) private view returns (uint256) {
        uint256 fee = Math.mulDiv(notional, rateBps, BPS, Math.Rounding.Ceil);
        return Math.ceilDiv(fee, collateralScale) * collateralScale;
    }

    function _floorToAtom(uint256 amount) private view returns (uint256) {
        return amount - amount % collateralScale;
    }

    function _slippage(uint256 halfSpread, uint256 impact, uint256 impactSize, uint256 sizeAbs)
        private
        pure
        returns (uint256)
    {
        return halfSpread * WAD + Math.mulDiv(impact * WAD, sizeAbs, impactSize, Math.Rounding.Ceil);
    }

    function _abs(int256 value) private pure returns (uint256) {
        return value < 0 ? uint256(-value) : uint256(value);
    }

    function _onlyOwner() private view {
        _requireDeploymentChain();
        if (msg.sender != owner) revert UnauthorizedCaller();
    }

    function _requireDeploymentChain() private view {
        if (block.chainid != deploymentChainId) revert InvalidChain();
    }
}

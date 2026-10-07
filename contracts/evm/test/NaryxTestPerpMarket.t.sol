// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "openzeppelin-contracts/token/ERC20/ERC20.sol";
import {IERC20} from "openzeppelin-contracts/token/ERC20/IERC20.sol";
import {NaryxTestPerpMarket} from "../src/conformance/NaryxTestPerpMarket.sol";
import {AggregatorV3Interface} from "../src/interfaces/IAggregatorV3.sol";
import {ISynFuturesInstrument} from "../src/interfaces/ISynFuturesInstrument.sol";
import {ISynFuturesPositionObserver} from "../src/interfaces/ISynFuturesPositionObserver.sol";

contract PerpMarketUsdc is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address recipient, uint256 amount) external {
        _mint(recipient, amount);
    }
}

contract PerpMarketAggregator is AggregatorV3Interface {
    uint80 public roundId;
    int256 public answer;
    uint256 public updatedAt;
    uint80 public answeredInRound;

    function decimals() external pure returns (uint8) {
        return 8;
    }

    function setPrice(int256 answer_) external {
        roundId += 1;
        answer = answer_;
        updatedAt = block.timestamp;
        answeredInRound = roundId;
    }

    function setRound(uint80 roundId_, int256 answer_, uint256 updatedAt_, uint80 answeredInRound_) external {
        roundId = roundId_;
        answer = answer_;
        updatedAt = updatedAt_;
        answeredInRound = answeredInRound_;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (roundId, answer, updatedAt, updatedAt, answeredInRound);
    }
}

contract NaryxTestPerpMarketTest is Test {
    uint32 private constant EXPIRY = type(uint32).max;
    int128 private constant ONE = 1e18;

    address private owner = makeAddr("owner");
    address private keeper = makeAddr("keeper");
    address private feeRecipient = makeAddr("feeRecipient");
    address private alice = makeAddr("alice");
    address private bob = makeAddr("bob");
    PerpMarketUsdc private usdc;
    PerpMarketAggregator private oracle;
    NaryxTestPerpMarket private market;

    function setUp() public {
        vm.chainId(31_338);
        vm.warp(1_000_000);
        usdc = new PerpMarketUsdc();
        oracle = new PerpMarketAggregator();
        oracle.setPrice(2_000e8);
        market = new NaryxTestPerpMarket(_parameters());
        _deposit(alice, 1_000e6);
        _deposit(bob, 1_000e6);
    }

    function testShortRoundTripChargesFeesAndSettlesPnlAndFundingAgainstInsurance() public {
        // Sell fill: 2000 * (1 - (2 bps + 1 bps * 1/10)) = 1999.58; fee 5 bps of notional.
        (uint256 fill, uint256 notional, uint256 fee, uint256 margin) = market.previewOpen(-ONE, 400e18);
        assertEq(fill, 1_999.58e18);
        assertEq(notional, 1_999.58e18);
        assertEq(fee, 0.99979e18);
        assertEq(margin, 399.00021e18);

        vm.prank(alice);
        ISynFuturesInstrument.PositionCache memory opened = market.trade(_args(-ONE, 400e18));
        assertEq(opened.balance, 399.00021e18);
        assertEq(opened.size, -ONE);
        assertEq(opened.entryNotional, 1_999.58e18);
        assertEq(market.reserveOf(alice), 600e6);
        assertEq(market.reserveOf(feeRecipient), 999_790);

        vm.prank(keeper);
        market.setFundingRatePerSecond(1e13);
        vm.warp(block.timestamp + 1 hours);
        oracle.setPrice(1_900e8);

        // The profit is the market's liability, so the close waits for counterparty capital.
        vm.prank(alice);
        vm.expectRevert(NaryxTestPerpMarket.InsuranceInsufficient.selector);
        market.trade(_args(ONE, 0));
        _fundInsurance(1_000e6);

        NaryxTestPerpMarket.Settlement memory preview = market.previewClose(alice);
        assertEq(preview.exitNotional, 1_900.399e18);
        assertEq(preview.realizedPnl, 99.181e18);
        assertEq(preview.funding, 0.036e18);
        assertEq(preview.charged, 0.9502e18);
        assertEq(preview.payout, 497.26701e18);

        // Buy fill 1900.399; PnL 99.181; funding 1 * 1e13 * 3600 = 0.036; fee 0.9501995 rounded up to 0.9502.
        vm.prank(alice);
        ISynFuturesInstrument.PositionCache memory closed = market.trade(_args(ONE, 0));
        assertEq(closed.size, 0);
        assertEq(closed.balance, 0);
        assertEq(closed.entryNotional, 0);
        assertEq(market.getPosition(address(market), EXPIRY, alice).size, 0);
        assertEq(market.reserveOf(alice), 600e6 + 497_267_010);
        assertEq(market.reserveOf(feeRecipient), 999_790 + 950_200);
        assertEq(market.insuranceWad(), 900.783e18);
        _assertConserved();

        uint256 reserve = market.reserveOf(alice);
        vm.prank(alice);
        market.withdraw(reserve);
        assertEq(usdc.balanceOf(alice), reserve);
        assertEq(market.reserveOf(alice), 0);
        _assertConserved();
    }

    function testFundingFlowsFromLongsToShortsAndAccountsStayIsolated() public {
        vm.prank(alice);
        market.trade(_args(-ONE, 400e18));
        vm.prank(bob);
        market.trade(_args(ONE, 400e18));
        (int256 aliceBefore,) = market.health(alice);
        (int256 bobBefore,) = market.health(bob);

        vm.prank(keeper);
        market.setFundingRatePerSecond(1e13);
        vm.warp(block.timestamp + 1 hours);
        oracle.setPrice(2_000e8);
        (int256 aliceAfter,) = market.health(alice);
        (int256 bobAfter,) = market.health(bob);
        assertEq(aliceAfter - aliceBefore, 0.036e18);
        assertEq(bobAfter - bobBefore, -0.036e18);

        _fundInsurance(1_000e6);
        vm.prank(bob);
        market.trade(_args(-ONE, 0));
        ISynFuturesPositionObserver.Position memory alicePosition = market.getPosition(address(market), EXPIRY, alice);
        assertEq(alicePosition.size, -ONE);
        assertEq(alicePosition.balance, 399.00021e18);
        assertEq(market.reserveOf(alice), 600e6);
        _assertConserved();
    }

    function testIncreasesAndPartiallyDecreasesWithoutChangingDirection() public {
        vm.prank(alice);
        market.trade(_args(-ONE, 400e18));

        vm.prank(keeper);
        market.setFundingRatePerSecond(1e13);
        vm.warp(block.timestamp + 100);
        oracle.setPrice(2_000e8);
        vm.prank(alice);
        ISynFuturesInstrument.PositionCache memory increased = market.trade(_args(-0.5e18, 200e18));
        assertEq(increased.size, -1.5e18);
        assertEq(increased.balance, 598.500312e18);
        assertEq(increased.entryNotional, 2_999.375e18);
        assertEq(increased.entryFundingIndex, 333_333_333_333_333);
        assertEq(market.reserveOf(alice), 400e6);

        oracle.setPrice(1_900e8);
        _fundInsurance(1_000e6);
        vm.prank(alice);
        ISynFuturesInstrument.PositionCache memory decreased = market.trade(_args(0.5e18, 0));
        assertEq(decreased.size, -ONE);
        assertEq(decreased.balance, 399.000208e18);
        assertEq(decreased.entryNotional, 1_999.583333333333333334e18);
        assertGt(market.reserveOf(alice), 400e6);
        _assertConserved();

        vm.startPrank(alice);
        vm.expectRevert(NaryxTestPerpMarket.InvalidTradeShape.selector);
        market.trade(_args(2e18, 0));
        vm.expectRevert(NaryxTestPerpMarket.InvalidTradeShape.selector);
        market.trade(_args(-0.5e18, 0));
        vm.stopPrank();
    }

    function testRejectsUndermarginedOversizedUnfundedAndMisshapedTrades() public {
        // Initial margin is 10% of 1999.58 = 199.958 after the 0.99979 fee.
        vm.startPrank(alice);
        vm.expectRevert(NaryxTestPerpMarket.InsufficientInitialMargin.selector);
        market.trade(_args(-ONE, 200e18));
        vm.expectRevert(NaryxTestPerpMarket.PositionTooLarge.selector);
        market.trade(_args(-11e18, 400e18));
        vm.expectRevert(NaryxTestPerpMarket.InsufficientReserve.selector);
        market.trade(_args(-ONE, 1_001e18));
        market.trade(_args(-ONE, 201e18));
        vm.expectRevert(NaryxTestPerpMarket.InvalidTradeShape.selector);
        market.trade(_args(2e18, 0));
        vm.expectRevert(NaryxTestPerpMarket.InvalidTradeShape.selector);
        market.trade(_args(ONE, -201e18));
        bytes32[2] memory expired = _args(ONE, 0);
        expired[0] = bytes32(uint256(block.timestamp) << 56 | uint256(EXPIRY));
        vm.expectRevert(NaryxTestPerpMarket.InvalidTradeHeader.selector);
        market.trade(expired);
        vm.stopPrank();

        vm.prank(alice);
        vm.expectRevert(NaryxTestPerpMarket.UnauthorizedCaller.selector);
        market.setOpensPaused(true);
        vm.prank(owner);
        market.setOpensPaused(true);
        vm.prank(bob);
        vm.expectRevert(NaryxTestPerpMarket.OpensPaused.selector);
        market.trade(_args(ONE, 400e18));
        // A pause never traps an open position.
        vm.prank(alice);
        market.trade(_args(ONE, 0));
        assertEq(market.getPosition(address(market), EXPIRY, alice).size, 0);
    }

    function testRejectsStaleNonPositiveAndIncompleteOracleRounds() public {
        vm.warp(block.timestamp + 1 hours + 1);
        vm.expectRevert(NaryxTestPerpMarket.StaleOraclePrice.selector);
        market.oraclePriceWad();
        vm.prank(alice);
        vm.expectRevert(NaryxTestPerpMarket.StaleOraclePrice.selector);
        market.trade(_args(-ONE, 400e18));

        oracle.setRound(5, 2_000e8, block.timestamp + 1, 5);
        vm.expectRevert(NaryxTestPerpMarket.StaleOraclePrice.selector);
        market.oraclePriceWad();
        oracle.setRound(5, 0, block.timestamp, 5);
        vm.expectRevert(NaryxTestPerpMarket.InvalidOraclePrice.selector);
        market.oraclePriceWad();
        oracle.setRound(5, -1, block.timestamp, 5);
        vm.expectRevert(NaryxTestPerpMarket.InvalidOraclePrice.selector);
        market.oraclePriceWad();
        oracle.setRound(5, 2_000e8, block.timestamp, 4);
        vm.expectRevert(NaryxTestPerpMarket.IncompleteOracleRound.selector);
        market.oraclePriceWad();
        oracle.setRound(5, 2_000e8, block.timestamp - 1 hours, 5);
        assertEq(market.oraclePriceWad(), 2_000e18);
    }

    function testLiquidatesOnlyBelowMaintenanceAndFloorsBadDebt() public {
        vm.prank(alice);
        market.trade(_args(-ONE, 250e18));
        vm.prank(bob);
        market.trade(_args(-ONE, 250e18));

        vm.expectRevert(NaryxTestPerpMarket.PositionHealthy.selector);
        market.liquidate(alice);

        // At 2150: equity 249.00021 - 150.42 = 98.58021 < 5% of 2150 = 107.5; penalty 0.5% = 10.75.
        oracle.setPrice(2_150e8);
        address liquidator = makeAddr("liquidator");
        vm.prank(liquidator);
        assertEq(market.liquidate(alice), 87.83021e18);
        assertEq(market.reserveOf(alice), 750e6 + 87_830_210);
        assertEq(market.reserveOf(feeRecipient), 2 * 999_790 + 10_750_000);
        assertEq(market.getPosition(address(market), EXPIRY, alice).size, 0);

        // At 2300 the loss exceeds bob's margin: no payout, no penalty, the shortfall is bad debt.
        oracle.setPrice(2_300e8);
        vm.prank(liquidator);
        assertEq(market.liquidate(bob), 0);
        assertEq(market.reserveOf(bob), 750e6);
        assertEq(market.badDebtWad(), 51.41979e18);
        assertEq(market.reserveOf(feeRecipient), 2 * 999_790 + 10_750_000);
        _assertConserved();

        vm.expectRevert(NaryxTestPerpMarket.NoPosition.selector);
        market.liquidate(bob);
    }

    function testValidatesParametersChainAndFundingAuthority() public {
        NaryxTestPerpMarket.Parameters memory invalid = _parameters();
        invalid.maintenanceMarginBps = invalid.initialMarginBps;
        vm.expectRevert(NaryxTestPerpMarket.InvalidConfiguration.selector);
        new NaryxTestPerpMarket(invalid);
        invalid = _parameters();
        invalid.maxOracleAgeSeconds = 0;
        vm.expectRevert(NaryxTestPerpMarket.InvalidConfiguration.selector);
        new NaryxTestPerpMarket(invalid);

        vm.prank(alice);
        vm.expectRevert(NaryxTestPerpMarket.UnauthorizedCaller.selector);
        market.setFundingRatePerSecond(1);
        vm.prank(keeper);
        vm.expectRevert(NaryxTestPerpMarket.FundingRateTooLarge.selector);
        market.setFundingRatePerSecond(-1e15 - 1);
        address nextKeeper = makeAddr("nextKeeper");
        vm.prank(owner);
        market.setFundingKeeper(nextKeeper);
        vm.prank(keeper);
        vm.expectRevert(NaryxTestPerpMarket.UnauthorizedCaller.selector);
        market.setFundingRatePerSecond(1);
        vm.prank(nextKeeper);
        market.setFundingRatePerSecond(-1e15);

        vm.chainId(31_339);
        vm.expectRevert(NaryxTestPerpMarket.InvalidChain.selector);
        new NaryxTestPerpMarket(_parameters());
        vm.expectRevert(NaryxTestPerpMarket.InvalidChain.selector);
        market.getPosition(address(market), EXPIRY, alice);
    }

    function _parameters() private view returns (NaryxTestPerpMarket.Parameters memory) {
        return NaryxTestPerpMarket.Parameters({
            owner: owner,
            fundingKeeper: keeper,
            feeRecipient: feeRecipient,
            collateral: IERC20(address(usdc)),
            oracle: AggregatorV3Interface(address(oracle)),
            expiry: EXPIRY,
            maxOracleAgeSeconds: 1 hours,
            takerFeeBps: 5,
            halfSpreadBps: 2,
            impactBps: 1,
            impactSizeWad: 10e18,
            initialMarginBps: 1_000,
            maintenanceMarginBps: 500,
            liquidationPenaltyBps: 50,
            maxPositionSizeWad: 10e18,
            maxMarginWad: 100_000e18,
            maxAbsFundingRatePerSecond: 1e15
        });
    }

    function _deposit(address trader, uint256 amount) private {
        usdc.mint(trader, amount);
        vm.startPrank(trader);
        usdc.approve(address(market), amount);
        market.deposit(amount);
        vm.stopPrank();
    }

    function _fundInsurance(uint256 amount) private {
        usdc.mint(owner, amount);
        vm.startPrank(owner);
        usdc.approve(address(market), amount);
        market.fundInsurance(amount);
        vm.stopPrank();
    }

    function _assertConserved() private view {
        assertEq(
            usdc.balanceOf(address(market)) * 1e12,
            market.totalReserveAtoms() * 1e12 + market.totalMarginWad() + market.insuranceWad()
        );
    }

    function _args(int128 sizeDelta, int128 balanceDelta) private view returns (bytes32[2] memory args) {
        args[0] = bytes32(uint256(block.timestamp + 1 hours) << 56 | uint256(EXPIRY));
        args[1] = bytes32(uint256(uint128(sizeDelta)) << 128 | uint256(uint128(balanceDelta)));
    }
}

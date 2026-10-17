// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "openzeppelin-contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "openzeppelin-contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Math} from "openzeppelin-contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/utils/ReentrancyGuard.sol";
import {AggregatorV3Interface} from "./interfaces/IAggregatorV3.sol";
import {NativePackageClearingHouse} from "./NativePackageClearingHouse.sol";

contract NativeCashRangeMarket is ReentrancyGuard {
    struct ReferenceConfiguration {
        uint256 chainId;
        address oracle;
        address sequencerFeed;
        address markUpdater;
        uint128 lowerBound;
        uint128 upperBound;
        uint128 underlyingAtomsPerPackage;
        uint64 maximumOracleAgeSeconds;
        uint64 sequencerGracePeriodSeconds;
        uint8 oracleDecimals;
        uint8 underlyingDecimals;
        bool allowMissingSequencer;
    }

    error InvalidConfiguration();
    error InvalidReference();
    error Unauthorized();
    error ReferenceChanged();

    event ReferenceMarked(
        bytes32 indexed observationHash, uint80 indexed oracleRound, uint128 priceTicks, uint64 oracleUpdatedAt
    );

    NativePackageClearingHouse public immutable clearingHouse;
    AggregatorV3Interface public immutable oracle;
    AggregatorV3Interface public immutable sequencerFeed;
    address public immutable markUpdater;
    uint128 public immutable lowerBound;
    uint128 public immutable upperBound;
    uint128 public immutable maximumPriceTicks;
    uint64 public immutable maximumOracleAgeSeconds;
    uint64 public immutable sequencerGracePeriodSeconds;
    uint8 public immutable oracleDecimals;
    uint256 public immutable quoteScaleNumerator;
    uint256 public immutable quoteScaleDenominator;

    constructor(
        IERC20 collateral,
        NativePackageClearingHouse.Configuration memory configuration,
        ReferenceConfiguration memory source
    ) {
        uint8 quoteDecimals = IERC20Metadata(address(collateral)).decimals();
        if (
            source.chainId != block.chainid || source.oracle.code.length == 0 || source.markUpdater == address(0)
                || source.lowerBound == 0 || source.upperBound <= source.lowerBound
                || source.underlyingAtomsPerPackage == 0 || source.maximumOracleAgeSeconds == 0
                || source.oracleDecimals > 18 || source.underlyingDecimals > 18 || quoteDecimals > 18
                || (source.sequencerFeed == address(0) && !source.allowMissingSequencer)
                || (source.sequencerFeed != address(0)
                    && (source.sequencerFeed.code.length == 0 || source.sequencerGracePeriodSeconds == 0))
                || AggregatorV3Interface(source.oracle).decimals() != source.oracleDecimals
                || configuration.markAuthority != address(0) || configuration.packageQuantityIncrementAtoms != 1
                || configuration.priceTickQuoteAtoms != 1
        ) revert InvalidConfiguration();
        uint256 numerator = uint256(source.underlyingAtomsPerPackage) * (10 ** quoteDecimals);
        uint256 denominator = 10 ** (uint256(source.oracleDecimals) + source.underlyingDecimals);
        uint256 maximum = Math.mulDiv(source.upperBound - source.lowerBound, numerator, denominator) + 1;
        if (
            maximum <= 1 || maximum > type(uint128).max || configuration.initialMarginQuoteAtomsPerIncrement < maximum
                || configuration.maintenanceMarginQuoteAtomsPerIncrement < maximum
        ) revert InvalidConfiguration();
        oracle = AggregatorV3Interface(source.oracle);
        sequencerFeed = AggregatorV3Interface(source.sequencerFeed);
        markUpdater = source.markUpdater;
        lowerBound = source.lowerBound;
        upperBound = source.upperBound;
        maximumPriceTicks = uint128(maximum);
        maximumOracleAgeSeconds = source.maximumOracleAgeSeconds;
        sequencerGracePeriodSeconds = source.sequencerGracePeriodSeconds;
        oracleDecimals = source.oracleDecimals;
        quoteScaleNumerator = numerator;
        quoteScaleDenominator = denominator;
        configuration.markAuthority = address(this);
        clearingHouse = new NativePackageClearingHouse(collateral, configuration);
    }

    function previewMark()
        public
        view
        returns (uint128 priceTicks, uint80 sourceRound, uint64 sourceUpdatedAt, uint64 maximumValidUntil)
    {
        if (oracle.decimals() != oracleDecimals) revert InvalidReference();
        if (address(sequencerFeed) != address(0)) {
            (, int256 status, uint256 startedAt,,) = sequencerFeed.latestRoundData();
            if (
                status != 0 || startedAt == 0 || startedAt > block.timestamp
                    || block.timestamp - startedAt <= sequencerGracePeriodSeconds
            ) revert InvalidReference();
        }
        (uint80 round, int256 answer,, uint256 updatedAt, uint80 answeredInRound) = oracle.latestRoundData();
        if (
            round == 0 || answer <= 0 || uint256(answer) > type(uint128).max || answeredInRound < round
                || updatedAt == 0 || updatedAt > block.timestamp || updatedAt > type(uint64).max
                || block.timestamp - updatedAt >= maximumOracleAgeSeconds
        ) revert InvalidReference();
        uint256 value = uint256(answer);
        uint256 distance = value <= lowerBound ? 0 : value >= upperBound ? upperBound - lowerBound : value - lowerBound;
        // One quote atom keeps the bounded range compatible with the clearing house's positive mark lattice.
        priceTicks = uint128(Math.mulDiv(distance, quoteScaleNumerator, quoteScaleDenominator) + 1);
        sourceRound = round;
        sourceUpdatedAt = uint64(updatedAt);
        uint256 until = updatedAt + maximumOracleAgeSeconds;
        uint256 houseUntil = block.timestamp + clearingHouse.markMaximumStalenessSeconds();
        maximumValidUntil = uint64(until < houseUntil ? until : houseUntil);
    }

    function refreshMark(bytes32 observationHash, uint128 expectedPriceTicks, uint64 sourceSequence, uint64 validUntil)
        external
        nonReentrant
    {
        if (msg.sender != markUpdater) revert Unauthorized();
        (uint128 priceTicks, uint80 sourceRound, uint64 updatedAt, uint64 maximumValidUntil) = previewMark();
        if (expectedPriceTicks != priceTicks || validUntil > maximumValidUntil) revert ReferenceChanged();
        clearingHouse.publishMark(observationHash, priceTicks, sourceSequence, validUntil);
        emit ReferenceMarked(observationHash, sourceRound, priceTicks, updatedAt);
    }
}

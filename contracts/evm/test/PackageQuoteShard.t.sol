// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {PackageQuoteShard} from "../src/PackageQuoteShard.sol";
import {ProtocolConfig} from "../src/ProtocolConfig.sol";

contract PackageQuoteConsumer {
    error ForcedRevert();

    PackageQuoteShard public shard;

    function setShard(PackageQuoteShard shard_) external {
        require(address(shard) == address(0));
        shard = shard_;
    }

    function consume(PackageQuoteShard.ConsumeRequest calldata request) external returns (bytes32) {
        return shard.consumeCapacity(request);
    }

    function consumeThenRevert(PackageQuoteShard.ConsumeRequest calldata request) external {
        shard.consumeCapacity(request);
        revert ForcedRevert();
    }
}

contract PackageQuoteShardTest is Test {
    uint8 private constant EXECUTION_COMMITMENT = 1;
    uint8 private constant FIRM_ONCHAIN = 2;
    bytes32 private constant DOMAIN_MANIFEST_HASH = keccak256("domain-manifest");
    bytes32 private constant SERIES_MANIFEST_HASH = keccak256("series-manifest");
    bytes32 private constant EXECUTION_CLASS_MANIFEST_HASH = keccak256("execution-class-manifest");
    bytes32 private constant REFERENCE_HASH = keccak256("reference");
    bytes32 private constant EXECUTION_LEVEL_ID = keccak256("execution-level");
    bytes32 private constant FIRM_LEVEL_ID = keccak256("firm-level");
    bytes32 private constant SETTLEMENT_CLASS_HASH = keccak256("atomic-settlement");
    bytes32 private constant RESERVATION_POLICY_HASH = keccak256("reservation-policy");
    bytes32 private constant ORDER_HASH = keccak256("order");
    bytes32 private constant QUOTE_HASH = keccak256("quote");
    bytes32 private constant ROUTE_HASH = keccak256("route");
    bytes32 private constant RESERVATION_ID = keccak256("reservation");

    address private constant SOLVER = address(0x501);
    address private constant OUTSIDER = address(0x502);
    address private constant PROPOSER = address(0x601);
    address private constant CANCELLER = address(0x602);
    address private constant EXECUTOR = address(0x603);
    address private constant PAUSER = address(0x604);

    ProtocolConfig private config;
    PackageQuoteConsumer private consumer;
    PackageQuoteShard private shard;

    function setUp() public {
        vm.warp(1_000);
        config = new ProtocolConfig("eip155:31337", 1, DOMAIN_MANIFEST_HASH, 60, PROPOSER, CANCELLER, EXECUTOR, PAUSER);
        consumer = new PackageQuoteConsumer();
        shard = new PackageQuoteShard(
            PackageQuoteShard.Deployment({
                chainId: block.chainid,
                config: address(config),
                configCodeHash: address(config).codehash,
                solver: SOLVER,
                consumer: address(consumer),
                consumerCodeHash: address(consumer).codehash,
                seriesManifestHash: SERIES_MANIFEST_HASH,
                executionClassManifestHash: EXECUTION_CLASS_MANIFEST_HASH
            }),
            PackageQuoteShard.Limits({maxHeartbeatSeconds: 120, maxBatchSize: 8, maxLevelCount: 32})
        );
        consumer.setShard(shard);
        _updateReference(1_000, REFERENCE_HASH, 1, 1_060, 0);
    }

    function testSolverAndConsumerAreIsolatedAndCodePinned() public {
        vm.prank(OUTSIDER);
        vm.expectRevert(abi.encodeWithSelector(PackageQuoteShard.UnauthorizedSolver.selector, OUTSIDER));
        shard.updateReference(1_100, keccak256("next"), 2, 1_070, 1);

        _upsert(_level(EXECUTION_LEVEL_ID, EXECUTION_COMMITMENT, -25, 100), 1);
        PackageQuoteShard.ConsumeRequest memory request = _request(EXECUTION_LEVEL_ID, 20, 1);

        vm.prank(OUTSIDER);
        vm.expectRevert(abi.encodeWithSelector(PackageQuoteShard.UnauthorizedConsumer.selector, OUTSIDER));
        shard.consumeCapacity(request);

        vm.etch(address(consumer), hex"60006000fd");
        vm.prank(address(consumer));
        vm.expectRevert(PackageQuoteShard.DeploymentChanged.selector);
        shard.consumeCapacity(request);
    }

    function testReferenceUpdateRepricesEveryLevelWithoutRewrite() public {
        _upsert(_level(EXECUTION_LEVEL_ID, EXECUTION_COMMITMENT, -25, 100), 1);
        PackageQuoteShard.ExecutableQuote memory beforeQuote = shard.getExecutableQuote(EXECUTION_LEVEL_ID, 20);
        assertEq(beforeQuote.packagePrice, 975);
        assertEq(beforeQuote.levelSequence, 2);
        assertEq(beforeQuote.referenceSequence, 1);
        assertEq(beforeQuote.shardSequence, 2);

        _updateReference(1_200, keccak256("reference-2"), 2, 1_080, 2);
        PackageQuoteShard.ExecutableQuote memory afterQuote = shard.getExecutableQuote(EXECUTION_LEVEL_ID, 20);
        assertEq(afterQuote.packagePrice, 1_175);
        assertEq(afterQuote.levelSequence, 2);
        assertEq(afterQuote.referenceSequence, 2);
        assertEq(afterQuote.shardSequence, 3);
        assertEq(shard.activeLevelCount(), 1);
    }

    function testStaleHeartbeatKillSwitchAndSequencesRejectExecution() public {
        _upsert(_level(EXECUTION_LEVEL_ID, EXECUTION_COMMITMENT, -25, 100), 1);
        vm.warp(1_060);
        vm.expectRevert(PackageQuoteShard.QuoteExpired.selector);
        shard.getExecutableQuote(EXECUTION_LEVEL_ID, 20);

        _updateReference(1_100, keccak256("reference-2"), 2, 1_120, 2);
        PackageQuoteShard.ConsumeRequest memory request = _request(EXECUTION_LEVEL_ID, 20, 1);

        vm.prank(SOLVER);
        vm.expectRevert(abi.encodeWithSelector(PackageQuoteShard.SequenceMismatch.selector, uint64(2), uint64(3)));
        shard.setKilled(true, 2);

        vm.prank(SOLVER);
        shard.setKilled(true, 3);
        request.expectedShardSequence = 4;
        vm.expectRevert(PackageQuoteShard.ShardKilled.selector);
        consumer.consume(request);

        vm.prank(SOLVER);
        shard.setKilled(false, 4);
        vm.prank(SOLVER);
        vm.expectRevert(abi.encodeWithSelector(PackageQuoteShard.SequenceNotIncreasing.selector, uint64(2), uint64(2)));
        shard.updateReference(1_100, keccak256("reference-replay"), 2, 1_130, 5);
    }

    function testCapacityAndQuoteModeReservationRules() public {
        PackageQuoteShard.QuoteLevelInput[] memory levels = new PackageQuoteShard.QuoteLevelInput[](2);
        levels[0] = _level(EXECUTION_LEVEL_ID, EXECUTION_COMMITMENT, -25, 100);
        levels[1] = _level(FIRM_LEVEL_ID, FIRM_ONCHAIN, 25, 100);
        vm.prank(SOLVER);
        shard.upsertQuoteLevels(levels, 1);

        PackageQuoteShard.ConsumeRequest memory execution = _request(EXECUTION_LEVEL_ID, 50, 1);
        bytes32 fillCommitment = consumer.consume(execution);
        assertTrue(fillCommitment != bytes32(0));
        assertEq(shard.shardSequence(), 3);
        assertEq(shard.quoteLevel(EXECUTION_LEVEL_ID).remainingCapacityUnits, 50);

        execution.expectedShardSequence = 3;
        execution.sizeUnits = 60;
        vm.expectRevert(PackageQuoteShard.InvalidSize.selector);
        consumer.consume(execution);

        execution.sizeUnits = 10;
        execution.reservationId = RESERVATION_ID;
        vm.expectRevert(PackageQuoteShard.InvalidReservation.selector);
        consumer.consume(execution);

        PackageQuoteShard.ConsumeRequest memory firm = _request(FIRM_LEVEL_ID, 40, 1);
        vm.expectRevert(PackageQuoteShard.InvalidReservation.selector);
        consumer.consume(firm);

        firm.reservationId = RESERVATION_ID;
        consumer.consume(firm);
        assertEq(shard.quoteLevel(FIRM_LEVEL_ID).remainingCapacityUnits, 60);
        assertEq(shard.shardSequence(), 4);
    }

    function testCancelAllInvalidatesInConstantTimeAndDownstreamRevertRollsBack() public {
        _upsert(_level(EXECUTION_LEVEL_ID, EXECUTION_COMMITMENT, -25, 100), 1);
        vm.prank(SOLVER);
        shard.cancelAllQuoteLevels(2);
        assertEq(shard.shardEpoch(), 2);
        assertEq(shard.activeLevelCount(), 0);
        vm.expectRevert(PackageQuoteShard.LevelNotActive.selector);
        shard.getExecutableQuote(EXECUTION_LEVEL_ID, 20);

        _upsert(_level(EXECUTION_LEVEL_ID, EXECUTION_COMMITMENT, 50, 100), 3);
        PackageQuoteShard.ConsumeRequest memory request = _request(EXECUTION_LEVEL_ID, 30, 2);
        uint64 sequenceBefore = shard.shardSequence();
        uint128 capacityBefore = shard.quoteLevel(EXECUTION_LEVEL_ID).remainingCapacityUnits;
        vm.expectRevert(PackageQuoteConsumer.ForcedRevert.selector);
        consumer.consumeThenRevert(request);
        assertEq(shard.shardSequence(), sequenceBefore);
        assertEq(shard.quoteLevel(EXECUTION_LEVEL_ID).remainingCapacityUnits, capacityBefore);

        vm.prank(SOLVER);
        shard.cancelQuoteLevel(EXECUTION_LEVEL_ID, sequenceBefore);
        vm.expectRevert(PackageQuoteShard.LevelNotActive.selector);
        shard.getExecutableQuote(EXECUTION_LEVEL_ID, 20);
    }

    function _level(bytes32 levelId, uint8 quoteMode, int256 offset, uint128 capacity)
        private
        view
        returns (PackageQuoteShard.QuoteLevelInput memory)
    {
        return PackageQuoteShard.QuoteLevelInput({
            levelId: levelId,
            direction: PackageQuoteShard.Direction.ASK,
            minSizeUnits: 10,
            maxSizeUnits: 100,
            referenceOffset: offset,
            maxFeeAtoms: 5,
            settlementClassIdentityHash: SETTLEMENT_CLASS_HASH,
            quoteMode: quoteMode,
            reservationPolicyHash: quoteMode == FIRM_ONCHAIN ? RESERVATION_POLICY_HASH : bytes32(0),
            expiresAt: uint64(block.timestamp + 120),
            capacityUnits: capacity
        });
    }

    function _upsert(PackageQuoteShard.QuoteLevelInput memory level, uint64 expectedShardSequence) private {
        PackageQuoteShard.QuoteLevelInput[] memory levels = new PackageQuoteShard.QuoteLevelInput[](1);
        levels[0] = level;
        vm.prank(SOLVER);
        shard.upsertQuoteLevels(levels, expectedShardSequence);
    }

    function _updateReference(
        int256 price,
        bytes32 referenceHash,
        uint64 referenceSequence,
        uint64 expiresAt,
        uint64 expectedShardSequence
    ) private {
        vm.prank(SOLVER);
        shard.updateReference(price, referenceHash, referenceSequence, expiresAt, expectedShardSequence);
    }

    function _request(bytes32 levelId, uint128 sizeUnits, uint128 feeAtoms)
        private
        view
        returns (PackageQuoteShard.ConsumeRequest memory request)
    {
        PackageQuoteShard.ExecutableQuote memory quote = shard.getExecutableQuote(levelId, sizeUnits);
        request = PackageQuoteShard.ConsumeRequest({
            levelId: levelId,
            expectedEpoch: quote.epoch,
            expectedLevelSequence: quote.levelSequence,
            expectedReferenceSequence: quote.referenceSequence,
            expectedShardSequence: quote.shardSequence,
            expectedExpiry: quote.expiresAt,
            sizeUnits: sizeUnits,
            feeAtoms: feeAtoms,
            expectedPackagePrice: quote.packagePrice,
            orderHash: ORDER_HASH,
            quoteHash: QUOTE_HASH,
            routeHash: ROUTE_HASH,
            reservationId: bytes32(0)
        });
    }
}

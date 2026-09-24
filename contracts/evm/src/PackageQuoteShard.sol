// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

contract PackageQuoteShard {
    uint8 public constant EXECUTION_COMMITMENT = 1;
    uint8 public constant FIRM_ONCHAIN = 2;
    uint16 public constant HARD_MAX_BATCH_SIZE = 128;
    uint32 public constant HARD_MAX_LEVEL_COUNT = 4096;

    bytes32 private constant FILL_COMMITMENT_PREFIX = keccak256("NARYX_PACKAGE_QUOTE_FILL_V1");

    enum Direction {
        NONE,
        BID,
        ASK
    }

    struct Deployment {
        uint256 chainId;
        address config;
        bytes32 configCodeHash;
        address solver;
        address consumer;
        bytes32 consumerCodeHash;
        bytes32 seriesManifestHash;
        bytes32 executionClassManifestHash;
    }

    struct Limits {
        uint64 maxHeartbeatSeconds;
        uint16 maxBatchSize;
        uint32 maxLevelCount;
    }

    struct ReferenceState {
        int256 packagePrice;
        bytes32 referenceHash;
        uint64 sequence;
        uint64 expiresAt;
    }

    struct QuoteLevelInput {
        bytes32 levelId;
        Direction direction;
        uint128 minSizeUnits;
        uint128 maxSizeUnits;
        int256 referenceOffset;
        uint128 maxFeeAtoms;
        bytes32 settlementClassIdentityHash;
        uint8 quoteMode;
        bytes32 reservationPolicyHash;
        uint64 expiresAt;
        uint128 capacityUnits;
    }

    struct QuoteLevel {
        Direction direction;
        uint8 quoteMode;
        bool active;
        uint64 epoch;
        uint64 sequence;
        uint64 expiresAt;
        uint128 minSizeUnits;
        uint128 maxSizeUnits;
        uint128 maxFeeAtoms;
        uint128 remainingCapacityUnits;
        int256 referenceOffset;
        bytes32 settlementClassIdentityHash;
        bytes32 reservationPolicyHash;
    }

    struct ExecutableQuote {
        bytes32 levelId;
        Direction direction;
        uint8 quoteMode;
        uint64 epoch;
        uint64 levelSequence;
        uint64 referenceSequence;
        uint64 shardSequence;
        uint64 expiresAt;
        uint128 sizeUnits;
        uint128 maxFeeAtoms;
        uint128 remainingCapacityUnits;
        int256 packagePrice;
        bytes32 referenceHash;
        bytes32 settlementClassIdentityHash;
        bytes32 reservationPolicyHash;
    }

    struct ConsumeRequest {
        bytes32 levelId;
        uint64 expectedEpoch;
        uint64 expectedLevelSequence;
        uint64 expectedReferenceSequence;
        uint64 expectedShardSequence;
        uint64 expectedExpiry;
        uint128 sizeUnits;
        uint128 feeAtoms;
        int256 expectedPackagePrice;
        bytes32 orderHash;
        bytes32 quoteHash;
        bytes32 routeHash;
        bytes32 reservationId;
    }

    struct FillBinding {
        uint256 chainId;
        bytes32 configCodeHash;
        address consumer;
        bytes32 consumerCodeHash;
        address solver;
        bytes32 seriesManifestHash;
        bytes32 executionClassManifestHash;
        bytes32 levelId;
        Direction direction;
        uint8 quoteMode;
        uint64 epoch;
        uint64 levelSequence;
        uint64 referenceSequence;
        uint64 quotedShardSequence;
        uint64 resultingShardSequence;
        uint64 expiresAt;
        uint128 sizeUnits;
        uint128 feeAtoms;
        int256 packagePrice;
        bytes32 referenceHash;
        bytes32 settlementClassIdentityHash;
        bytes32 reservationPolicyHash;
        bytes32 orderHash;
        bytes32 quoteHash;
        bytes32 routeHash;
        bytes32 reservationId;
    }

    error InvalidConfiguration();
    error UnauthorizedSolver(address caller);
    error UnauthorizedConsumer(address caller);
    error DeploymentChanged();
    error SequenceMismatch(uint64 expected, uint64 actual);
    error SequenceNotIncreasing(uint64 current, uint64 proposed);
    error SequenceExhausted();
    error InvalidHeartbeat();
    error InvalidBatchSize();
    error InvalidLevel();
    error LevelLimitExceeded();
    error LevelNotActive();
    error ShardKilled();
    error InvalidKillState();
    error QuoteExpired();
    error InvalidSize();
    error InvalidCommitment();
    error InvalidReservation();
    error InvalidPrice();
    error InvalidFee();

    event ReferenceUpdated(
        int256 packagePrice,
        bytes32 indexed referenceHash,
        uint64 indexed referenceSequence,
        uint64 shardSequence,
        uint64 expiresAt
    );
    event QuoteLevelUpserted(
        bytes32 indexed levelId,
        Direction direction,
        uint8 quoteMode,
        uint64 indexed epoch,
        uint64 levelSequence,
        uint64 expiresAt,
        uint128 minSizeUnits,
        uint128 maxSizeUnits,
        uint128 maxFeeAtoms,
        uint128 capacityUnits,
        int256 referenceOffset,
        bytes32 settlementClassIdentityHash,
        bytes32 reservationPolicyHash
    );
    event QuoteLevelCancelled(bytes32 indexed levelId, uint64 indexed epoch, uint64 shardSequence);
    event AllQuoteLevelsCancelled(uint64 indexed previousEpoch, uint64 indexed newEpoch, uint64 shardSequence);
    event KillSwitchSet(bool killed, uint64 shardSequence);
    event CapacityConsumed(
        bytes32 indexed fillCommitment,
        bytes32 indexed levelId,
        bytes32 indexed orderHash,
        uint128 sizeUnits,
        uint128 feeAtoms,
        int256 packagePrice,
        uint128 remainingCapacityUnits,
        uint64 quotedShardSequence,
        uint64 resultingShardSequence
    );

    uint256 public immutable deploymentChainId;
    address public immutable config;
    bytes32 public immutable configCodeHash;
    address public immutable solver;
    address public immutable consumer;
    bytes32 public immutable consumerCodeHash;
    bytes32 public immutable seriesManifestHash;
    bytes32 public immutable executionClassManifestHash;
    uint64 public immutable maxHeartbeatSeconds;
    uint16 public immutable maxBatchSize;
    uint32 public immutable maxLevelCount;

    ReferenceState public referenceState;
    uint64 public shardSequence;
    uint64 public shardEpoch = 1;
    uint32 public activeLevelCount;
    bool public killed;

    mapping(bytes32 levelId => QuoteLevel level) private _levels;

    modifier onlySolver() {
        if (msg.sender != solver) revert UnauthorizedSolver(msg.sender);
        _;
    }

    modifier onlyConsumer() {
        if (msg.sender != consumer) revert UnauthorizedConsumer(msg.sender);
        _;
    }

    constructor(Deployment memory deployment, Limits memory limits) {
        if (
            deployment.chainId != block.chainid || deployment.config.code.length == 0
                || deployment.config.codehash != deployment.configCodeHash || deployment.solver == address(0)
                || deployment.consumer.code.length == 0 || deployment.consumer.codehash != deployment.consumerCodeHash
                || deployment.seriesManifestHash == bytes32(0) || deployment.executionClassManifestHash == bytes32(0)
                || limits.maxHeartbeatSeconds == 0 || limits.maxBatchSize == 0
                || limits.maxBatchSize > HARD_MAX_BATCH_SIZE || limits.maxLevelCount == 0
                || limits.maxLevelCount > HARD_MAX_LEVEL_COUNT || limits.maxBatchSize > limits.maxLevelCount
        ) revert InvalidConfiguration();

        deploymentChainId = deployment.chainId;
        config = deployment.config;
        configCodeHash = deployment.configCodeHash;
        solver = deployment.solver;
        consumer = deployment.consumer;
        consumerCodeHash = deployment.consumerCodeHash;
        seriesManifestHash = deployment.seriesManifestHash;
        executionClassManifestHash = deployment.executionClassManifestHash;
        maxHeartbeatSeconds = limits.maxHeartbeatSeconds;
        maxBatchSize = limits.maxBatchSize;
        maxLevelCount = limits.maxLevelCount;
    }

    function updateReference(
        int256 packagePrice,
        bytes32 referenceHash,
        uint64 referenceSequence,
        uint64 expiresAt,
        uint64 expectedShardSequence
    ) external onlySolver {
        _assertDeployment();
        _checkShardSequence(expectedShardSequence);
        ReferenceState memory current = referenceState;
        if (referenceSequence <= current.sequence) {
            revert SequenceNotIncreasing(current.sequence, referenceSequence);
        }
        if (
            referenceHash == bytes32(0) || expiresAt <= block.timestamp
                || uint256(expiresAt) - block.timestamp > maxHeartbeatSeconds
        ) revert InvalidHeartbeat();

        uint64 nextShardSequence = _advanceShardSequence();
        referenceState = ReferenceState({
            packagePrice: packagePrice, referenceHash: referenceHash, sequence: referenceSequence, expiresAt: expiresAt
        });
        emit ReferenceUpdated(packagePrice, referenceHash, referenceSequence, nextShardSequence, expiresAt);
    }

    function upsertQuoteLevels(QuoteLevelInput[] calldata inputs, uint64 expectedShardSequence) external onlySolver {
        _assertDeployment();
        _checkShardSequence(expectedShardSequence);
        uint256 length = inputs.length;
        if (length == 0 || length > maxBatchSize) revert InvalidBatchSize();

        uint64 nextShardSequence = _advanceShardSequence();
        uint64 epoch = shardEpoch;
        uint32 levelCount = activeLevelCount;

        for (uint256 i; i < length; ++i) {
            QuoteLevelInput calldata input = inputs[i];
            _validateLevelInput(input);
            QuoteLevel storage existing = _levels[input.levelId];
            if (!existing.active || existing.epoch != epoch) {
                if (levelCount == maxLevelCount) revert LevelLimitExceeded();
                ++levelCount;
            }
            _levels[input.levelId] = QuoteLevel({
                direction: input.direction,
                quoteMode: input.quoteMode,
                active: true,
                epoch: epoch,
                sequence: nextShardSequence,
                expiresAt: input.expiresAt,
                minSizeUnits: input.minSizeUnits,
                maxSizeUnits: input.maxSizeUnits,
                maxFeeAtoms: input.maxFeeAtoms,
                remainingCapacityUnits: input.capacityUnits,
                referenceOffset: input.referenceOffset,
                settlementClassIdentityHash: input.settlementClassIdentityHash,
                reservationPolicyHash: input.reservationPolicyHash
            });
            emit QuoteLevelUpserted(
                input.levelId,
                input.direction,
                input.quoteMode,
                epoch,
                nextShardSequence,
                input.expiresAt,
                input.minSizeUnits,
                input.maxSizeUnits,
                input.maxFeeAtoms,
                input.capacityUnits,
                input.referenceOffset,
                input.settlementClassIdentityHash,
                input.reservationPolicyHash
            );
        }
        activeLevelCount = levelCount;
    }

    function cancelQuoteLevel(bytes32 levelId, uint64 expectedShardSequence) external onlySolver {
        _assertDeployment();
        _checkShardSequence(expectedShardSequence);
        QuoteLevel storage level = _levels[levelId];
        if (!level.active || level.epoch != shardEpoch) revert LevelNotActive();

        uint64 nextShardSequence = _advanceShardSequence();
        level.active = false;
        level.remainingCapacityUnits = 0;
        level.sequence = nextShardSequence;
        --activeLevelCount;
        emit QuoteLevelCancelled(levelId, shardEpoch, nextShardSequence);
    }

    function cancelAllQuoteLevels(uint64 expectedShardSequence) external onlySolver {
        _assertDeployment();
        _checkShardSequence(expectedShardSequence);
        if (shardEpoch == type(uint64).max) revert SequenceExhausted();

        uint64 previousEpoch = shardEpoch;
        uint64 nextShardSequence = _advanceShardSequence();
        shardEpoch = previousEpoch + 1;
        activeLevelCount = 0;
        emit AllQuoteLevelsCancelled(previousEpoch, shardEpoch, nextShardSequence);
    }

    function setKilled(bool killed_, uint64 expectedShardSequence) external onlySolver {
        _assertDeployment();
        _checkShardSequence(expectedShardSequence);
        if (killed_ == killed) revert InvalidKillState();

        killed = killed_;
        emit KillSwitchSet(killed_, _advanceShardSequence());
    }

    function getExecutableQuote(bytes32 levelId, uint128 sizeUnits)
        external
        view
        returns (ExecutableQuote memory quote)
    {
        _assertDeployment();
        return _executableQuote(levelId, sizeUnits);
    }

    function quoteLevel(bytes32 levelId) external view returns (QuoteLevel memory) {
        return _levels[levelId];
    }

    function consumeCapacity(ConsumeRequest calldata request) external onlyConsumer returns (bytes32 fillCommitment) {
        _assertDeployment();
        _checkShardSequence(request.expectedShardSequence);
        if (request.orderHash == bytes32(0) || request.quoteHash == bytes32(0) || request.routeHash == bytes32(0)) {
            revert InvalidCommitment();
        }

        ExecutableQuote memory quote = _executableQuote(request.levelId, request.sizeUnits);
        if (
            request.expectedEpoch != quote.epoch || request.expectedLevelSequence != quote.levelSequence
                || request.expectedReferenceSequence != quote.referenceSequence
        ) revert SequenceMismatch(request.expectedLevelSequence, quote.levelSequence);
        if (request.expectedExpiry != quote.expiresAt) revert QuoteExpired();
        if (request.expectedPackagePrice != quote.packagePrice) revert InvalidPrice();
        if (request.feeAtoms > quote.maxFeeAtoms) revert InvalidFee();
        if (
            (quote.quoteMode == EXECUTION_COMMITMENT && request.reservationId != bytes32(0))
                || (quote.quoteMode == FIRM_ONCHAIN && request.reservationId == bytes32(0))
        ) revert InvalidReservation();

        QuoteLevel storage level = _levels[request.levelId];
        level.remainingCapacityUnits -= request.sizeUnits;
        uint64 resultingShardSequence = _advanceShardSequence();

        FillBinding memory binding = FillBinding({
            chainId: block.chainid,
            configCodeHash: configCodeHash,
            consumer: consumer,
            consumerCodeHash: consumerCodeHash,
            solver: solver,
            seriesManifestHash: seriesManifestHash,
            executionClassManifestHash: executionClassManifestHash,
            levelId: request.levelId,
            direction: quote.direction,
            quoteMode: quote.quoteMode,
            epoch: quote.epoch,
            levelSequence: quote.levelSequence,
            referenceSequence: quote.referenceSequence,
            quotedShardSequence: quote.shardSequence,
            resultingShardSequence: resultingShardSequence,
            expiresAt: quote.expiresAt,
            sizeUnits: request.sizeUnits,
            feeAtoms: request.feeAtoms,
            packagePrice: quote.packagePrice,
            referenceHash: quote.referenceHash,
            settlementClassIdentityHash: quote.settlementClassIdentityHash,
            reservationPolicyHash: quote.reservationPolicyHash,
            orderHash: request.orderHash,
            quoteHash: request.quoteHash,
            routeHash: request.routeHash,
            reservationId: request.reservationId
        });
        fillCommitment = keccak256(abi.encode(FILL_COMMITMENT_PREFIX, binding));
        emit CapacityConsumed(
            fillCommitment,
            request.levelId,
            request.orderHash,
            request.sizeUnits,
            request.feeAtoms,
            quote.packagePrice,
            level.remainingCapacityUnits,
            quote.shardSequence,
            resultingShardSequence
        );
    }

    function assertDeployment() external view {
        _assertDeployment();
    }

    function _validateLevelInput(QuoteLevelInput calldata input) private view {
        if (
            input.levelId == bytes32(0) || input.direction == Direction.NONE || input.minSizeUnits == 0
                || input.maxSizeUnits < input.minSizeUnits || input.capacityUnits < input.maxSizeUnits
                || input.settlementClassIdentityHash == bytes32(0) || input.expiresAt <= block.timestamp
                || (input.quoteMode != EXECUTION_COMMITMENT && input.quoteMode != FIRM_ONCHAIN)
                || (input.quoteMode == EXECUTION_COMMITMENT && input.reservationPolicyHash != bytes32(0))
                || (input.quoteMode == FIRM_ONCHAIN && input.reservationPolicyHash == bytes32(0))
        ) revert InvalidLevel();
    }

    function _executableQuote(bytes32 levelId, uint128 sizeUnits) private view returns (ExecutableQuote memory quote) {
        if (killed) revert ShardKilled();
        ReferenceState memory currentReference = referenceState;
        if (currentReference.sequence == 0 || currentReference.expiresAt <= block.timestamp) revert QuoteExpired();
        QuoteLevel memory level = _levels[levelId];
        if (!level.active || level.epoch != shardEpoch) revert LevelNotActive();
        if (level.expiresAt <= block.timestamp) revert QuoteExpired();
        if (
            sizeUnits < level.minSizeUnits || sizeUnits > level.maxSizeUnits || sizeUnits > level.remainingCapacityUnits
        ) revert InvalidSize();

        uint64 expiresAt = currentReference.expiresAt < level.expiresAt ? currentReference.expiresAt : level.expiresAt;
        quote = ExecutableQuote({
            levelId: levelId,
            direction: level.direction,
            quoteMode: level.quoteMode,
            epoch: level.epoch,
            levelSequence: level.sequence,
            referenceSequence: currentReference.sequence,
            shardSequence: shardSequence,
            expiresAt: expiresAt,
            sizeUnits: sizeUnits,
            maxFeeAtoms: level.maxFeeAtoms,
            remainingCapacityUnits: level.remainingCapacityUnits,
            packagePrice: _addPrice(currentReference.packagePrice, level.referenceOffset),
            referenceHash: currentReference.referenceHash,
            settlementClassIdentityHash: level.settlementClassIdentityHash,
            reservationPolicyHash: level.reservationPolicyHash
        });
    }

    function _addPrice(int256 referencePrice, int256 offset) private pure returns (int256 price) {
        unchecked {
            price = referencePrice + offset;
        }
        if ((offset > 0 && price < referencePrice) || (offset < 0 && price > referencePrice)) {
            revert InvalidPrice();
        }
    }

    function _advanceShardSequence() private returns (uint64 nextSequence) {
        uint64 current = shardSequence;
        if (current == type(uint64).max) revert SequenceExhausted();
        nextSequence = current + 1;
        shardSequence = nextSequence;
    }

    function _checkShardSequence(uint64 expectedShardSequence) private view {
        uint64 current = shardSequence;
        if (expectedShardSequence != current) revert SequenceMismatch(expectedShardSequence, current);
    }

    function _assertDeployment() private view {
        if (
            block.chainid != deploymentChainId || config.codehash != configCodeHash
                || consumer.codehash != consumerCodeHash
        ) revert DeploymentChanged();
    }
}

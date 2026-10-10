// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "openzeppelin-contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/utils/ReentrancyGuard.sol";
import {OwnerSignature} from "./libraries/OwnerSignature.sol";

contract NativePackageClearingHouse is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 private constant BPS = 10_000;
    bytes32 private constant MATCH_TYPEHASH = keccak256(
        "NativeMatch(bytes32 policyHash,bytes32 authorizationHash,bytes32 longAccountId,bytes32 shortAccountId,bytes32 feePayerAccountId,uint64 longSequence,uint64 shortSequence,uint128 quantityAtoms,uint128 priceTicks,uint64 expiry)"
    );

    struct Account {
        address owner;
        uint256 collateralQuoteAtoms;
        int256 cashBalanceQuoteAtoms;
        int128 positionAtoms;
        uint64 sequence;
    }

    struct NativeMatch {
        bytes32 authorizationHash;
        bytes32 longAccountId;
        bytes32 shortAccountId;
        bytes32 feePayerAccountId;
        uint64 longSequence;
        uint64 shortSequence;
        uint128 quantityAtoms;
        uint128 priceTicks;
        uint64 expiry;
    }

    struct Mark {
        bytes32 observationHash;
        uint128 priceTicks;
        uint64 sourceSequence;
        uint64 observedAt;
        uint64 validUntil;
    }

    struct FeeUpdate {
        uint16 feeBps;
        address recipient;
        uint64 activateAt;
    }

    struct Configuration {
        bytes32 policyHash;
        address governor;
        address pauser;
        address markAuthority;
        uint128 packageQuantityIncrementAtoms;
        uint128 priceTickQuoteAtoms;
        uint128 initialMarginQuoteAtomsPerIncrement;
        uint128 maintenanceMarginQuoteAtomsPerIncrement;
        uint128 maximumPositionAtoms;
        uint128 maximumOpenInterestAtoms;
        uint16 maximumDefaultTransferDiscountBps;
        uint64 markMaximumStalenessSeconds;
        uint64 defaultAuctionDurationSeconds;
        uint64 feeUpdateDelaySeconds;
        uint16 maximumFeeBps;
    }

    struct DefaultAuction {
        bytes32 defaultedAccountId;
        bytes32 defaultedAccountHash;
        bytes32 markObservationHash;
        int128 positionAtoms;
        uint128 markPriceTicks;
        uint128 minimumPriceTicks;
        uint128 maximumPriceTicks;
        uint64 closeAt;
        bytes32 bestBackstopAccountId;
        bytes32 bestBackstopAccountHash;
        uint128 bestPriceTicks;
        uint64 bestBidValidUntil;
        bool settled;
    }

    error InvalidConfiguration();
    error Unauthorized();
    error EntryPaused();
    error InvalidAccount();
    error AccountLocked();
    error InvalidMark();
    error StaleMark();
    error InvalidMatch();
    error InvalidSignature();
    error Replay();
    error MarginViolation();
    error PositionLimit();
    error OpenInterestLimit();
    error FeeUpdateUnavailable();
    error InvalidAuction();
    error AuctionUnavailable();
    error PostconditionFailed();

    event AccountOpened(bytes32 indexed accountId, address indexed owner);
    event CollateralDeposited(bytes32 indexed accountId, uint256 amount, uint64 sequence);
    event CollateralWithdrawn(bytes32 indexed accountId, uint256 amount, uint64 sequence);
    event MarkPublished(bytes32 indexed observationHash, uint64 indexed sourceSequence, uint128 priceTicks);
    event PackageMatched(
        bytes32 indexed authorizationHash,
        bytes32 indexed longAccountId,
        bytes32 indexed shortAccountId,
        uint128 quantityAtoms,
        uint128 priceTicks,
        uint256 feeAtoms
    );
    event DefaultAuctionOpened(bytes32 indexed auctionId, bytes32 indexed accountId, uint64 closeAt);
    event DefaultBidAccepted(bytes32 indexed auctionId, bytes32 indexed backstopAccountId, uint128 priceTicks);
    event DefaultAuctionSettled(
        bytes32 indexed auctionId,
        bytes32 indexed defaultedAccountId,
        bytes32 indexed backstopAccountId,
        uint256 reserveConsumed,
        uint256 uncoveredDeficit
    );
    event DefaultAuctionCancelled(bytes32 indexed auctionId, bytes32 indexed defaultedAccountId);
    event RecoveryReserveFunded(address indexed funder, uint256 amount);
    event FeeUpdateScheduled(uint16 feeBps, address indexed recipient, uint64 activateAt);
    event FeeUpdateActivated(uint16 feeBps, address indexed recipient);
    event EntryPauseSet(bool paused);

    IERC20 public immutable collateralToken;
    bytes32 public immutable policyHash;
    address public immutable governor;
    address public immutable pauser;
    address public immutable markAuthority;
    uint128 public immutable packageQuantityIncrementAtoms;
    uint128 public immutable priceTickQuoteAtoms;
    uint128 public immutable initialMarginQuoteAtomsPerIncrement;
    uint128 public immutable maintenanceMarginQuoteAtomsPerIncrement;
    uint128 public immutable maximumPositionAtoms;
    uint128 public immutable maximumOpenInterestAtoms;
    uint16 public immutable maximumDefaultTransferDiscountBps;
    uint64 public immutable markMaximumStalenessSeconds;
    uint64 public immutable defaultAuctionDurationSeconds;
    uint64 public immutable feeUpdateDelaySeconds;
    uint16 public immutable maximumFeeBps;
    bytes32 public immutable DOMAIN_SEPARATOR;

    uint128 public openInterestAtoms;
    uint256 public recoveryReserveQuoteAtoms;
    uint256 public accruedProtocolFees;
    uint16 public feeBps;
    address public feeRecipient;
    bool public entryPaused = true;
    Mark public currentMark;
    FeeUpdate public pendingFeeUpdate;

    mapping(bytes32 accountId => Account account) private _accounts;
    mapping(bytes32 authorizationHash => bool consumed) public consumedAuthorization;
    mapping(bytes32 accountId => bytes32 auctionId) public accountLock;
    mapping(bytes32 auctionId => DefaultAuction auction) private _auctions;

    constructor(IERC20 collateralToken_, Configuration memory configuration) {
        if (
            address(collateralToken_).code.length == 0 || configuration.policyHash == bytes32(0)
                || configuration.governor == address(0) || configuration.pauser == address(0)
                || configuration.markAuthority == address(0) || configuration.packageQuantityIncrementAtoms == 0
                || configuration.priceTickQuoteAtoms == 0 || configuration.initialMarginQuoteAtomsPerIncrement == 0
                || configuration.maintenanceMarginQuoteAtomsPerIncrement == 0
                || configuration.maintenanceMarginQuoteAtomsPerIncrement
                    > configuration.initialMarginQuoteAtomsPerIncrement
                || configuration.maximumPositionAtoms == 0
                || configuration.maximumPositionAtoms > uint128(type(int128).max)
                || configuration.maximumPositionAtoms % configuration.packageQuantityIncrementAtoms != 0
                || configuration.maximumOpenInterestAtoms == 0
                || configuration.maximumOpenInterestAtoms % configuration.packageQuantityIncrementAtoms != 0
                || configuration.maximumDefaultTransferDiscountBps > BPS
                || configuration.markMaximumStalenessSeconds == 0 || configuration.defaultAuctionDurationSeconds == 0
                || configuration.defaultAuctionDurationSeconds > configuration.markMaximumStalenessSeconds
                || configuration.feeUpdateDelaySeconds == 0 || configuration.maximumFeeBps > BPS
        ) revert InvalidConfiguration();
        collateralToken = collateralToken_;
        policyHash = configuration.policyHash;
        governor = configuration.governor;
        pauser = configuration.pauser;
        markAuthority = configuration.markAuthority;
        packageQuantityIncrementAtoms = configuration.packageQuantityIncrementAtoms;
        priceTickQuoteAtoms = configuration.priceTickQuoteAtoms;
        initialMarginQuoteAtomsPerIncrement = configuration.initialMarginQuoteAtomsPerIncrement;
        maintenanceMarginQuoteAtomsPerIncrement = configuration.maintenanceMarginQuoteAtomsPerIncrement;
        maximumPositionAtoms = configuration.maximumPositionAtoms;
        maximumOpenInterestAtoms = configuration.maximumOpenInterestAtoms;
        maximumDefaultTransferDiscountBps = configuration.maximumDefaultTransferDiscountBps;
        markMaximumStalenessSeconds = configuration.markMaximumStalenessSeconds;
        defaultAuctionDurationSeconds = configuration.defaultAuctionDurationSeconds;
        feeUpdateDelaySeconds = configuration.feeUpdateDelaySeconds;
        maximumFeeBps = configuration.maximumFeeBps;
        feeRecipient = configuration.governor;
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Naryx Native Package Clearing"),
                keccak256("1"),
                block.chainid,
                address(this)
            )
        );
    }

    function account(bytes32 accountId) external view returns (Account memory) {
        return _accounts[accountId];
    }

    function auction(bytes32 auctionId) external view returns (DefaultAuction memory) {
        return _auctions[auctionId];
    }

    function openAccount(bytes32 accountId) external {
        if (accountId == bytes32(0) || _accounts[accountId].owner != address(0)) revert InvalidAccount();
        _accounts[accountId].owner = msg.sender;
        emit AccountOpened(accountId, msg.sender);
    }

    function deposit(bytes32 accountId, uint256 amount) external nonReentrant {
        Account storage account_ = _ownedAccount(accountId);
        _requireUnlocked(accountId);
        if (amount == 0) revert InvalidAccount();
        uint256 beforeBalance = collateralToken.balanceOf(address(this));
        collateralToken.safeTransferFrom(msg.sender, address(this), amount);
        if (collateralToken.balanceOf(address(this)) != beforeBalance + amount) revert PostconditionFailed();
        account_.collateralQuoteAtoms += amount;
        account_.sequence += 1;
        emit CollateralDeposited(accountId, amount, account_.sequence);
    }

    function withdraw(bytes32 accountId, uint256 amount) external nonReentrant {
        Account storage account_ = _ownedAccount(accountId);
        _requireUnlocked(accountId);
        _requireLiveMark();
        if (amount == 0 || amount > account_.collateralQuoteAtoms) revert InvalidAccount();
        account_.collateralQuoteAtoms -= amount;
        account_.sequence += 1;
        if (account_.positionAtoms != 0 && _status(account_, currentMark.priceTicks) != 1) revert MarginViolation();
        uint256 beforeBalance = collateralToken.balanceOf(address(this));
        collateralToken.safeTransfer(msg.sender, amount);
        if (collateralToken.balanceOf(address(this)) != beforeBalance - amount) revert PostconditionFailed();
        emit CollateralWithdrawn(accountId, amount, account_.sequence);
    }

    function normalizeFlatAccount(bytes32 accountId) external {
        Account storage account_ = _ownedAccount(accountId);
        _requireUnlocked(accountId);
        if (account_.positionAtoms != 0) revert InvalidAccount();
        int256 equity = _equity(account_, currentMark.priceTicks);
        if (equity < 0) revert MarginViolation();
        account_.collateralQuoteAtoms = uint256(equity);
        account_.cashBalanceQuoteAtoms = 0;
        account_.sequence += 1;
    }

    function publishMark(bytes32 observationHash, uint128 priceTicks, uint64 sourceSequence, uint64 validUntil) external {
        if (msg.sender != markAuthority) revert Unauthorized();
        if (
            observationHash == bytes32(0) || priceTicks == 0 || sourceSequence <= currentMark.sourceSequence
                || validUntil <= block.timestamp || validUntil - block.timestamp > markMaximumStalenessSeconds
        ) revert InvalidMark();
        currentMark = Mark({
            observationHash: observationHash,
            priceTicks: priceTicks,
            sourceSequence: sourceSequence,
            observedAt: uint64(block.timestamp),
            validUntil: validUntil
        });
        emit MarkPublished(observationHash, sourceSequence, priceTicks);
    }

    function matchDigest(NativeMatch calldata match_) public view returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                "\x19\x01",
                DOMAIN_SEPARATOR,
                keccak256(
                    abi.encode(
                        MATCH_TYPEHASH,
                        policyHash,
                        match_.authorizationHash,
                        match_.longAccountId,
                        match_.shortAccountId,
                        match_.feePayerAccountId,
                        match_.longSequence,
                        match_.shortSequence,
                        match_.quantityAtoms,
                        match_.priceTicks,
                        match_.expiry
                    )
                )
            )
        );
    }

    function executeMatch(NativeMatch calldata match_, bytes calldata longSignature, bytes calldata shortSignature)
        external
        nonReentrant
    {
        _validateMatch(match_, longSignature, shortSignature);
        consumedAuthorization[match_.authorizationHash] = true;
        uint256 fee = _applyMatch(match_);
        emit PackageMatched(
            match_.authorizationHash,
            match_.longAccountId,
            match_.shortAccountId,
            match_.quantityAtoms,
            match_.priceTicks,
            fee
        );
    }

    function _validateMatch(NativeMatch calldata match_, bytes calldata longSignature, bytes calldata shortSignature)
        private
        view
    {
        if (entryPaused) revert EntryPaused();
        _requireLiveMark();
        if (consumedAuthorization[match_.authorizationHash]) revert Replay();
        if (
            match_.authorizationHash == bytes32(0) || match_.longAccountId == match_.shortAccountId
                || match_.quantityAtoms == 0
                || match_.quantityAtoms > uint128(type(int128).max)
                || match_.quantityAtoms % packageQuantityIncrementAtoms != 0 || match_.priceTicks == 0
                || block.timestamp >= match_.expiry
                || (match_.feePayerAccountId != match_.longAccountId && match_.feePayerAccountId != match_.shortAccountId)
        ) revert InvalidMatch();
        _requireUnlocked(match_.longAccountId);
        _requireUnlocked(match_.shortAccountId);
        Account storage long = _accounts[match_.longAccountId];
        Account storage short = _accounts[match_.shortAccountId];
        if (
            long.owner == address(0) || short.owner == address(0) || long.owner == short.owner
                || long.sequence != match_.longSequence || short.sequence != match_.shortSequence
        ) revert InvalidMatch();
        bytes32 digest = matchDigest(match_);
        if (!OwnerSignature.isValidNow(long.owner, digest, longSignature)) revert InvalidSignature();
        if (!OwnerSignature.isValidNow(short.owner, digest, shortSignature)) revert InvalidSignature();
    }

    function _applyMatch(NativeMatch calldata match_) private returns (uint256 fee) {
        Account storage long = _accounts[match_.longAccountId];
        Account storage short = _accounts[match_.shortAccountId];
        int128 longBefore = long.positionAtoms;
        int128 shortBefore = short.positionAtoms;
        int128 quantity = int128(match_.quantityAtoms);
        long.positionAtoms = longBefore + quantity;
        short.positionAtoms = shortBefore - quantity;
        int256 quote = int256(_quoteValue(match_.quantityAtoms, match_.priceTicks));
        long.cashBalanceQuoteAtoms -= quote;
        short.cashBalanceQuoteAtoms += quote;
        fee = _ceilDiv(_quoteValue(match_.quantityAtoms, match_.priceTicks) * feeBps, BPS);
        Account storage payer = _accounts[match_.feePayerAccountId];
        if (fee > payer.collateralQuoteAtoms) revert MarginViolation();
        payer.collateralQuoteAtoms -= fee;
        accruedProtocolFees += fee;
        long.sequence += 1;
        short.sequence += 1;

        if (_abs(long.positionAtoms) > maximumPositionAtoms || _abs(short.positionAtoms) > maximumPositionAtoms) {
            revert PositionLimit();
        }
        _requirePostMatchMargin(long, longBefore);
        _requirePostMatchMargin(short, shortBefore);
        _updateOpenInterest(longBefore, long.positionAtoms, shortBefore, short.positionAtoms);
    }

    function fundRecoveryReserve(uint256 amount) external nonReentrant {
        if (amount == 0) revert InvalidAccount();
        uint256 beforeBalance = collateralToken.balanceOf(address(this));
        collateralToken.safeTransferFrom(msg.sender, address(this), amount);
        if (collateralToken.balanceOf(address(this)) != beforeBalance + amount) revert PostconditionFailed();
        recoveryReserveQuoteAtoms += amount;
        emit RecoveryReserveFunded(msg.sender, amount);
    }

    function openDefaultAuction(bytes32 auctionId, bytes32 accountId) external {
        _requireLiveMark();
        if (auctionId == bytes32(0) || _auctions[auctionId].defaultedAccountId != bytes32(0)) revert InvalidAuction();
        _requireUnlocked(accountId);
        Account storage defaulted = _accounts[accountId];
        if (defaulted.owner == address(0) || defaulted.positionAtoms == 0 || _status(defaulted, currentMark.priceTicks) != 4) {
            revert InvalidAuction();
        }
        uint64 closeAt = uint64(block.timestamp) + defaultAuctionDurationSeconds;
        if (closeAt > currentMark.validUntil) revert StaleMark();
        uint128 minimumPrice = uint128(
            _ceilDiv(uint256(currentMark.priceTicks) * (BPS - maximumDefaultTransferDiscountBps), BPS)
        );
        uint128 maximumPrice = uint128(
            uint256(currentMark.priceTicks) * (BPS + maximumDefaultTransferDiscountBps) / BPS
        );
        _auctions[auctionId] = DefaultAuction({
            defaultedAccountId: accountId,
            defaultedAccountHash: accountHash(accountId),
            markObservationHash: currentMark.observationHash,
            positionAtoms: defaulted.positionAtoms,
            markPriceTicks: currentMark.priceTicks,
            minimumPriceTicks: minimumPrice,
            maximumPriceTicks: maximumPrice,
            closeAt: closeAt,
            bestBackstopAccountId: bytes32(0),
            bestBackstopAccountHash: bytes32(0),
            bestPriceTicks: 0,
            bestBidValidUntil: 0,
            settled: false
        });
        accountLock[accountId] = auctionId;
        emit DefaultAuctionOpened(auctionId, accountId, closeAt);
    }

    function bidDefaultAuction(bytes32 auctionId, bytes32 backstopAccountId, uint128 priceTicks, uint64 validUntil)
        external
    {
        DefaultAuction storage auction_ = _auctions[auctionId];
        if (auction_.defaultedAccountId == bytes32(0) || auction_.settled || block.timestamp >= auction_.closeAt) {
            revert AuctionUnavailable();
        }
        Account storage backstop = _ownedAccount(backstopAccountId);
        _requireUnlocked(backstopAccountId);
        if (
            backstopAccountId == auction_.defaultedAccountId || validUntil < auction_.closeAt
                || priceTicks < auction_.minimumPriceTicks || priceTicks > auction_.maximumPriceTicks
        ) revert InvalidAuction();
        if (auction_.bestBackstopAccountId != bytes32(0)) {
            bool improves = auction_.positionAtoms > 0 ? priceTicks > auction_.bestPriceTicks : priceTicks < auction_.bestPriceTicks;
            if (!improves) revert InvalidAuction();
            delete accountLock[auction_.bestBackstopAccountId];
        }
        Account memory projected = backstop;
        int256 value = _signedQuoteValue(auction_.positionAtoms, priceTicks);
        projected.cashBalanceQuoteAtoms -= value;
        projected.positionAtoms += auction_.positionAtoms;
        if (_abs(projected.positionAtoms) > maximumPositionAtoms || _statusMemory(projected, auction_.markPriceTicks) != 1) {
            revert MarginViolation();
        }
        auction_.bestBackstopAccountId = backstopAccountId;
        auction_.bestBackstopAccountHash = accountHash(backstopAccountId);
        auction_.bestPriceTicks = priceTicks;
        auction_.bestBidValidUntil = validUntil;
        accountLock[backstopAccountId] = auctionId;
        emit DefaultBidAccepted(auctionId, backstopAccountId, priceTicks);
    }

    function settleDefaultAuction(bytes32 auctionId) external {
        DefaultAuction storage auction_ = _auctions[auctionId];
        if (
            auction_.defaultedAccountId == bytes32(0) || auction_.settled || block.timestamp < auction_.closeAt
                || block.timestamp > auction_.bestBidValidUntil || currentMark.observationHash != auction_.markObservationHash
                || block.timestamp > currentMark.validUntil || auction_.bestBackstopAccountId == bytes32(0)
        ) revert AuctionUnavailable();
        if (accountHash(auction_.defaultedAccountId) != auction_.defaultedAccountHash
            || accountHash(auction_.bestBackstopAccountId) != auction_.bestBackstopAccountHash) revert InvalidAuction();
        Account storage defaulted = _accounts[auction_.defaultedAccountId];
        Account storage backstop = _accounts[auction_.bestBackstopAccountId];
        int128 transferred = defaulted.positionAtoms;
        int256 transferValue = _signedQuoteValue(transferred, auction_.bestPriceTicks);
        int128 backstopBefore = backstop.positionAtoms;
        backstop.positionAtoms += transferred;
        backstop.cashBalanceQuoteAtoms -= transferValue;
        backstop.sequence += 1;
        if (_status(backstop, auction_.markPriceTicks) != 1) revert MarginViolation();

        int256 closedEquity = int256(defaulted.collateralQuoteAtoms) + defaulted.cashBalanceQuoteAtoms + transferValue;
        uint256 deficit = closedEquity < 0 ? uint256(-closedEquity) : 0;
        uint256 reserveConsumed = deficit < recoveryReserveQuoteAtoms ? deficit : recoveryReserveQuoteAtoms;
        uint256 uncovered = deficit - reserveConsumed;
        recoveryReserveQuoteAtoms -= reserveConsumed;
        defaulted.collateralQuoteAtoms = closedEquity > 0 ? uint256(closedEquity) : 0;
        defaulted.cashBalanceQuoteAtoms = -int256(uncovered);
        defaulted.positionAtoms = 0;
        defaulted.sequence += 1;
        _updateOpenInterest(transferred, 0, backstopBefore, backstop.positionAtoms);
        auction_.settled = true;
        delete accountLock[auction_.defaultedAccountId];
        delete accountLock[auction_.bestBackstopAccountId];
        emit DefaultAuctionSettled(
            auctionId,
            auction_.defaultedAccountId,
            auction_.bestBackstopAccountId,
            reserveConsumed,
            uncovered
        );
    }

    function cancelExpiredDefaultAuction(bytes32 auctionId) external {
        DefaultAuction storage auction_ = _auctions[auctionId];
        if (
            auction_.defaultedAccountId == bytes32(0) || auction_.settled
                || block.timestamp <= currentMark.validUntil
        ) revert AuctionUnavailable();
        auction_.settled = true;
        delete accountLock[auction_.defaultedAccountId];
        if (auction_.bestBackstopAccountId != bytes32(0)) delete accountLock[auction_.bestBackstopAccountId];
        emit DefaultAuctionCancelled(auctionId, auction_.defaultedAccountId);
    }

    function accountHash(bytes32 accountId) public view returns (bytes32) {
        Account storage account_ = _accounts[accountId];
        return keccak256(
            abi.encode(
                policyHash,
                accountId,
                account_.owner,
                account_.collateralQuoteAtoms,
                account_.cashBalanceQuoteAtoms,
                account_.positionAtoms,
                account_.sequence
            )
        );
    }

    function accountStatus(bytes32 accountId) external view returns (uint8) {
        Account storage account_ = _accounts[accountId];
        if (account_.owner == address(0)) revert InvalidAccount();
        if (account_.positionAtoms != 0) _requireLiveMark();
        return _status(account_, currentMark.priceTicks);
    }

    function scheduleFeeUpdate(uint16 nextFeeBps, address nextRecipient) external {
        if (msg.sender != governor) revert Unauthorized();
        if (nextFeeBps > maximumFeeBps || nextRecipient == address(0)) revert InvalidConfiguration();
        uint64 activateAt = uint64(block.timestamp) + feeUpdateDelaySeconds;
        pendingFeeUpdate = FeeUpdate({feeBps: nextFeeBps, recipient: nextRecipient, activateAt: activateAt});
        emit FeeUpdateScheduled(nextFeeBps, nextRecipient, activateAt);
    }

    function activateFeeUpdate() external {
        FeeUpdate memory pending = pendingFeeUpdate;
        if (pending.activateAt == 0 || block.timestamp < pending.activateAt) revert FeeUpdateUnavailable();
        feeBps = pending.feeBps;
        feeRecipient = pending.recipient;
        delete pendingFeeUpdate;
        emit FeeUpdateActivated(feeBps, feeRecipient);
    }

    function withdrawProtocolFees() external nonReentrant {
        if (msg.sender != feeRecipient) revert Unauthorized();
        uint256 amount = accruedProtocolFees;
        accruedProtocolFees = 0;
        collateralToken.safeTransfer(msg.sender, amount);
    }

    function setEntryPaused(bool paused) external {
        if (msg.sender != pauser && msg.sender != governor) revert Unauthorized();
        if (!paused && msg.sender != governor) revert Unauthorized();
        entryPaused = paused;
        emit EntryPauseSet(paused);
    }

    function _ownedAccount(bytes32 accountId) private view returns (Account storage account_) {
        account_ = _accounts[accountId];
        if (account_.owner != msg.sender) revert Unauthorized();
    }

    function _requireUnlocked(bytes32 accountId) private view {
        if (accountLock[accountId] != bytes32(0)) revert AccountLocked();
    }

    function _requireLiveMark() private view {
        Mark memory mark = currentMark;
        if (
            mark.observationHash == bytes32(0) || block.timestamp < mark.observedAt || block.timestamp > mark.validUntil
                || block.timestamp - mark.observedAt > markMaximumStalenessSeconds
        ) revert StaleMark();
    }

    function _quoteValue(uint256 quantityAtoms, uint256 priceTicks) private view returns (uint256) {
        return quantityAtoms / packageQuantityIncrementAtoms * priceTicks * priceTickQuoteAtoms;
    }

    function _signedQuoteValue(int128 positionAtoms, uint128 priceTicks) private view returns (int256) {
        return int256(positionAtoms) / int256(uint256(packageQuantityIncrementAtoms)) * int256(uint256(priceTicks))
            * int256(uint256(priceTickQuoteAtoms));
    }

    function _equity(Account storage account_, uint128 markPriceTicks) private view returns (int256) {
        return int256(account_.collateralQuoteAtoms) + account_.cashBalanceQuoteAtoms
            + _signedQuoteValue(account_.positionAtoms, markPriceTicks);
    }

    function _equityMemory(Account memory account_, uint128 markPriceTicks) private view returns (int256) {
        return int256(account_.collateralQuoteAtoms) + account_.cashBalanceQuoteAtoms
            + _signedQuoteValue(account_.positionAtoms, markPriceTicks);
    }

    function _status(Account storage account_, uint128 markPriceTicks) private view returns (uint8) {
        Account memory copy = account_;
        return _statusMemory(copy, markPriceTicks);
    }

    function _statusMemory(Account memory account_, uint128 markPriceTicks) private view returns (uint8) {
        if (account_.positionAtoms == 0) return _equityMemory(account_, markPriceTicks) < 0 ? 4 : 5;
        int256 equity = _equityMemory(account_, markPriceTicks);
        if (equity < 0) return 4;
        uint256 increments = _ceilDiv(_abs(account_.positionAtoms), packageQuantityIncrementAtoms);
        uint256 maintenance = increments * maintenanceMarginQuoteAtomsPerIncrement;
        if (uint256(equity) < maintenance) return 3;
        uint256 initial = increments * initialMarginQuoteAtomsPerIncrement;
        return uint256(equity) < initial ? 2 : 1;
    }

    function _requirePostMatchMargin(Account storage account_, int128 positionBefore) private view {
        uint256 beforeAbs = _abs(positionBefore);
        uint256 afterAbs = _abs(account_.positionAtoms);
        bool crossed = positionBefore != 0 && account_.positionAtoms != 0
            && (positionBefore > 0) != (account_.positionAtoms > 0);
        uint8 status = _status(account_, currentMark.priceTicks);
        if (afterAbs > beforeAbs || crossed) {
            if (status != 1) revert MarginViolation();
        } else if (status == 4) {
            revert MarginViolation();
        }
    }

    function _updateOpenInterest(int128 beforeA, int128 afterA, int128 beforeB, int128 afterB) private {
        int256 grossDelta = int256(_abs(afterA)) + int256(_abs(afterB)) - int256(_abs(beforeA)) - int256(_abs(beforeB));
        if (grossDelta % 2 != 0) revert InvalidMatch();
        int256 next = int256(uint256(openInterestAtoms)) + grossDelta / 2;
        if (next < 0 || uint256(next) > maximumOpenInterestAtoms) revert OpenInterestLimit();
        openInterestAtoms = uint128(uint256(next));
    }

    function _abs(int128 value) private pure returns (uint256) {
        int256 wide = int256(value);
        return uint256(wide < 0 ? -wide : wide);
    }

    function _ceilDiv(uint256 numerator, uint256 denominator) private pure returns (uint256) {
        return numerator == 0 ? 0 : (numerator - 1) / denominator + 1;
    }
}

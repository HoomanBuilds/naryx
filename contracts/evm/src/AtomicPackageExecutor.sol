// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "openzeppelin-contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "openzeppelin-contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "openzeppelin-contracts/utils/cryptography/EIP712.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/utils/ReentrancyGuard.sol";
import {ProtocolConfig} from "./ProtocolConfig.sol";
import {LocalCashCarryVenue} from "./LocalCashCarryVenue.sol";

contract AtomicPackageExecutor is EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint8 public constant ENTRY = 1;
    uint8 public constant EXIT = 2;
    uint256 public constant LOCAL_CHAIN_ID = 31337;
    uint256 public constant BASE_SEPOLIA_CHAIN_ID = 84532;

    bytes32 private constant TRADER_PERMIT_TYPEHASH = keccak256(
        "TraderPermit(bytes32 packageHash,bytes32 accountsHash,bytes32 limitsHash,uint256 nonce,uint256 deadline)"
    );
    bytes32 private constant SOLVER_AUTH_TYPEHASH = keccak256(
        "SolverAuthorization(bytes32 packageHash,bytes32 accountsHash,bytes32 limitsHash,uint256 nonce,uint256 deadline)"
    );
    bytes32 private constant RECEIPT_TYPEHASH = keccak256(
        "PackageReceiptCommitment(bytes32 packageHash,bytes32 accountsHash,bytes32 limitsHash,uint256 nonce,uint256 deadline)"
    );

    struct Execution {
        bytes32 domainIdHash;
        uint32 domainManifestVersion;
        bytes32 domainManifestHash;
        bytes32 orderHash;
        bytes32 quoteHash;
        bytes32 routeHash;
        uint8 action;
        uint256 quantity;
        uint256 limitQuote;
        uint256 collateral;
        address trader;
        address recipient;
        address solver;
        address venue;
        address executor;
        uint256 chainId;
        bytes32 entryReceiptHash;
        uint256 nonce;
        uint256 deadline;
    }

    struct Position {
        uint256 quantity;
        uint256 collateral;
        bytes32 entryReceiptHash;
    }

    struct Snapshot {
        uint256 executorBaseBalance;
        uint256 executorQuoteBalance;
        uint256 shortQuantity;
        uint256 shortCollateral;
    }

    struct Receipt {
        bytes32 domainIdHash;
        uint32 domainManifestVersion;
        bytes32 domainManifestHash;
        bytes32 orderHash;
        bytes32 quoteHash;
        bytes32 routeHash;
        uint8 action;
        address trader;
        address recipient;
        uint256 quantity;
        uint256 quoteAmount;
        uint256 collateral;
        bytes32 entryReceiptHash;
        uint256 nonce;
        Snapshot pre;
        Snapshot post;
    }

    error UnsupportedChain();
    error InvalidConfiguration();
    error InvalidExecution();
    error DomainMismatch();
    error EntryPaused();
    error Expired();
    error InvalidNonce();
    error InvalidTraderSignature();
    error InvalidSolverSignature();
    error PositionExists();
    error PositionMismatch();
    error PostconditionFailed();

    event PackageExecuted(
        bytes32 indexed receiptHash, address indexed trader, uint8 indexed action, uint256 quantity, uint256 quoteAmount
    );

    ProtocolConfig public immutable config;
    LocalCashCarryVenue public immutable venue;
    IERC20 public immutable baseToken;
    IERC20 public immutable quoteToken;
    address public immutable solver;
    uint256 public immutable deploymentChainId;
    bytes32 public immutable venueCodeHash;

    mapping(address => uint256) public nextNonce;
    mapping(address => Position) public positions;
    mapping(bytes32 => Receipt) private _receipts;

    constructor(ProtocolConfig config_, LocalCashCarryVenue venue_, address solver_)
        EIP712("Naryx Atomic Package", "1")
    {
        if (block.chainid != LOCAL_CHAIN_ID && block.chainid != BASE_SEPOLIA_CHAIN_ID) revert UnsupportedChain();
        if (
            address(config_).code.length == 0 || address(venue_).code.length == 0 || solver_ == address(0)
                || venue_.executor() != address(this)
        ) revert InvalidConfiguration();
        config = config_;
        venue = venue_;
        baseToken = venue_.baseToken();
        quoteToken = venue_.quoteToken();
        solver = solver_;
        deploymentChainId = block.chainid;
        venueCodeHash = address(venue_).codehash;
    }

    function traderPermitDigest(Execution calldata execution) external view returns (bytes32) {
        return _hashTypedDataV4(_executionHash(TRADER_PERMIT_TYPEHASH, execution));
    }

    function solverAuthorizationDigest(Execution calldata execution) external view returns (bytes32) {
        return _hashTypedDataV4(_executionHash(SOLVER_AUTH_TYPEHASH, execution));
    }

    function receipt(bytes32 receiptHash) external view returns (Receipt memory) {
        return _receipts[receiptHash];
    }

    function execute(Execution calldata execution, bytes calldata traderSignature, bytes calldata solverSignature)
        external
        nonReentrant
        returns (bytes32 receiptHash)
    {
        _validate(execution, traderSignature, solverSignature);
        Snapshot memory pre = _snapshot(execution.trader);
        nextNonce[execution.trader] = execution.nonce + 1;

        uint256 quoteAmount;
        if (execution.action == ENTRY) {
            quoteAmount = _enter(execution);
        } else {
            quoteAmount = _exit(execution);
        }

        Snapshot memory post = _snapshot(execution.trader);
        receiptHash = keccak256(
            abi.encode(_hashTypedDataV4(_executionHash(RECEIPT_TYPEHASH, execution)), quoteAmount, pre, post)
        );
        _receipts[receiptHash] = Receipt({
            domainIdHash: execution.domainIdHash,
            domainManifestVersion: execution.domainManifestVersion,
            domainManifestHash: execution.domainManifestHash,
            orderHash: execution.orderHash,
            quoteHash: execution.quoteHash,
            routeHash: execution.routeHash,
            action: execution.action,
            trader: execution.trader,
            recipient: execution.recipient,
            quantity: execution.quantity,
            quoteAmount: quoteAmount,
            collateral: execution.collateral,
            entryReceiptHash: execution.entryReceiptHash,
            nonce: execution.nonce,
            pre: pre,
            post: post
        });
        if (execution.action == ENTRY) {
            positions[execution.trader].entryReceiptHash = receiptHash;
        }
        emit PackageExecuted(receiptHash, execution.trader, execution.action, execution.quantity, quoteAmount);
    }

    function _validate(Execution calldata execution, bytes calldata traderSignature, bytes calldata solverSignature)
        private
        view
    {
        if (block.chainid != deploymentChainId || address(venue).codehash != venueCodeHash) {
            revert InvalidConfiguration();
        }
        if (
            execution.trader == address(0) || execution.trader == address(this) || execution.recipient == address(0)
                || execution.recipient == address(this) || execution.solver != solver
                || execution.venue != address(venue) || execution.executor != address(this)
                || execution.chainId != block.chainid || execution.quantity == 0 || execution.collateral == 0
                || execution.orderHash == bytes32(0) || execution.quoteHash == bytes32(0)
                || execution.routeHash == bytes32(0) || (execution.action != ENTRY && execution.action != EXIT)
        ) revert InvalidExecution();
        if (block.timestamp >= execution.deadline) revert Expired();
        if (execution.nonce != nextNonce[execution.trader]) revert InvalidNonce();
        (string memory domainId, uint32 version, bytes32 manifestHash) = config.domain();
        if (
            execution.domainIdHash != keccak256(bytes(domainId)) || execution.domainManifestVersion != version
                || execution.domainManifestHash != manifestHash
        ) revert DomainMismatch();
        if (execution.action == ENTRY && config.entryPaused()) revert EntryPaused();

        bytes32 traderDigest = _hashTypedDataV4(_executionHash(TRADER_PERMIT_TYPEHASH, execution));
        if (ECDSA.recover(traderDigest, traderSignature) != execution.trader) revert InvalidTraderSignature();
        bytes32 solverDigest = _hashTypedDataV4(_executionHash(SOLVER_AUTH_TYPEHASH, execution));
        if (ECDSA.recover(solverDigest, solverSignature) != solver) revert InvalidSolverSignature();
    }

    function _enter(Execution calldata execution) private returns (uint256 quoteSpent) {
        if (execution.entryReceiptHash != bytes32(0) || positions[execution.trader].quantity != 0) {
            revert PositionExists();
        }
        (uint256 venueQuantity,) = venue.shortPositions(execution.trader);
        if (venueQuantity != 0) revert PositionExists();

        uint256 baseBefore = baseToken.balanceOf(address(this));
        uint256 quoteBefore = quoteToken.balanceOf(address(this));
        uint256 traderQuoteBefore = quoteToken.balanceOf(execution.trader);
        uint256 requiredQuote = execution.limitQuote + execution.collateral;
        quoteToken.safeTransferFrom(execution.trader, address(this), requiredQuote);
        if (
            quoteToken.balanceOf(address(this)) != quoteBefore + requiredQuote
                || quoteToken.balanceOf(execution.trader) != traderQuoteBefore - requiredQuote
        ) revert PostconditionFailed();

        quoteToken.forceApprove(address(venue), execution.limitQuote);
        quoteSpent = venue.buyExactOutput(execution.quantity, execution.limitQuote);
        quoteToken.forceApprove(address(venue), 0);
        if (
            baseToken.balanceOf(address(this)) != baseBefore + execution.quantity
                || quoteToken.balanceOf(address(this)) != quoteBefore + requiredQuote - quoteSpent
        ) revert PostconditionFailed();

        quoteToken.forceApprove(address(venue), execution.collateral);
        venue.openShort(execution.trader, execution.quantity, execution.collateral);
        quoteToken.forceApprove(address(venue), 0);
        (uint256 openedQuantity, uint256 openedCollateral) = venue.shortPositions(execution.trader);
        if (openedQuantity != execution.quantity || openedCollateral != execution.collateral) {
            revert PostconditionFailed();
        }

        quoteToken.safeTransfer(execution.trader, execution.limitQuote - quoteSpent);
        if (quoteToken.balanceOf(address(this)) != quoteBefore) revert PostconditionFailed();
        positions[execution.trader] = Position(execution.quantity, execution.collateral, bytes32(0));
    }

    function _exit(Execution calldata execution) private returns (uint256 quoteOut) {
        Position memory position = positions[execution.trader];
        if (
            position.quantity != execution.quantity || position.collateral != execution.collateral
                || position.entryReceiptHash == bytes32(0) || position.entryReceiptHash != execution.entryReceiptHash
        ) revert PositionMismatch();
        (uint256 venueQuantity, uint256 venueCollateral) = venue.shortPositions(execution.trader);
        if (venueQuantity != position.quantity || venueCollateral != position.collateral) revert PositionMismatch();

        uint256 baseBefore = baseToken.balanceOf(address(this));
        uint256 quoteBefore = quoteToken.balanceOf(address(this));
        uint256 recipientBefore = quoteToken.balanceOf(execution.recipient);
        baseToken.forceApprove(address(venue), execution.quantity);
        quoteOut = venue.sellExactInput(execution.quantity, execution.limitQuote);
        baseToken.forceApprove(address(venue), 0);
        if (
            baseToken.balanceOf(address(this)) != baseBefore - execution.quantity
                || quoteToken.balanceOf(address(this)) != quoteBefore + quoteOut
        ) revert PostconditionFailed();

        venue.closeShort(execution.trader, execution.quantity, execution.collateral);
        (venueQuantity, venueCollateral) = venue.shortPositions(execution.trader);
        if (venueQuantity != 0 || venueCollateral != 0) revert PostconditionFailed();
        if (quoteToken.balanceOf(address(this)) != quoteBefore + quoteOut + execution.collateral) {
            revert PostconditionFailed();
        }
        quoteToken.safeTransfer(execution.recipient, quoteOut + execution.collateral);
        if (
            quoteToken.balanceOf(address(this)) != quoteBefore
                || quoteToken.balanceOf(execution.recipient) != recipientBefore + quoteOut + execution.collateral
        ) revert PostconditionFailed();
        delete positions[execution.trader];
    }

    function _executionHash(bytes32 typeHash, Execution calldata execution) private pure returns (bytes32) {
        bytes32 packageHash = keccak256(
            abi.encode(
                execution.domainIdHash,
                execution.domainManifestVersion,
                execution.domainManifestHash,
                execution.orderHash,
                execution.quoteHash,
                execution.routeHash,
                execution.action,
                execution.quantity,
                execution.entryReceiptHash
            )
        );
        bytes32 accountsHash = keccak256(
            abi.encode(
                execution.trader,
                execution.recipient,
                execution.solver,
                execution.venue,
                execution.executor,
                execution.chainId
            )
        );
        bytes32 limitsHash = keccak256(abi.encode(execution.limitQuote, execution.collateral));
        return
            keccak256(abi.encode(typeHash, packageHash, accountsHash, limitsHash, execution.nonce, execution.deadline));
    }

    function _snapshot(address trader) private view returns (Snapshot memory state) {
        state.executorBaseBalance = baseToken.balanceOf(address(this));
        state.executorQuoteBalance = quoteToken.balanceOf(address(this));
        (state.shortQuantity, state.shortCollateral) = venue.shortPositions(trader);
    }
}

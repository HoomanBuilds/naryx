// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "openzeppelin-contracts/token/ERC20/ERC20.sol";
import {IERC20} from "openzeppelin-contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/token/ERC20/utils/SafeERC20.sol";
import {DirectInventorySpotPort} from "../src/DirectInventorySpotPort.sol";
import {CashCarrySeriesRegistry} from "../src/CashCarrySeriesRegistry.sol";
import {FirmInventoryReservationBook} from "../src/FirmInventoryReservationBook.sol";
import {NaryxStrategyAccount} from "../src/NaryxStrategyAccount.sol";
import {PackageQuoteShard} from "../src/PackageQuoteShard.sol";
import {PolicyRegistry} from "../src/PolicyRegistry.sol";
import {PackageVerifier, PackageVerifierValidation} from "../src/PackageVerifier.sol";
import {PackageQuoteShardRegistry} from "../src/PackageQuoteShardRegistry.sol";
import {ProtocolConfig} from "../src/ProtocolConfig.sol";
import {ResourceRegistry} from "../src/ResourceRegistry.sol";
import {SolverRegistry} from "../src/SolverRegistry.sol";
import {IExactSpotPort} from "../src/interfaces/IExactSpotPort.sol";
import {ISpotFillRecorder} from "../src/interfaces/ISpotFillRecorder.sol";
import {ISynFuturesInstrument} from "../src/interfaces/ISynFuturesInstrument.sol";
import {ISynFuturesPositionObserver} from "../src/interfaces/ISynFuturesPositionObserver.sol";

contract StrategyAccountToken is ERC20 {
    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

    function mint(address recipient, uint256 amount) external {
        _mint(recipient, amount);
    }
}

contract StrategyAccountSpotPort is IExactSpotPort {
    using SafeERC20 for IERC20;

    uint8 private constant ENTRY = 1;
    uint8 private constant EXIT = 2;

    address public immutable verifier;
    bytes32 public immutable verifierCodeHash;
    IERC20 public immutable baseToken;
    IERC20 public immutable quoteToken;

    constructor(address verifier_, IERC20 baseToken_, IERC20 quoteToken_) {
        verifier = verifier_;
        verifierCodeHash = verifier_.codehash;
        baseToken = baseToken_;
        quoteToken = quoteToken_;
    }

    function buyExactOutput(
        uint256 packageNonce,
        bytes32 spotFillCommitment,
        bytes32 orderHash,
        bytes32 quoteHash,
        bytes32 routeHash,
        uint256 quantity,
        uint256 maxQuote
    ) external returns (uint256 quoteIn) {
        quoteIn = quantity * 2;
        require(quoteIn <= maxQuote, "quote bound");
        quoteToken.safeTransferFrom(msg.sender, address(this), quoteIn);
        baseToken.safeTransfer(msg.sender, quantity);
        ISpotFillRecorder(verifier)
            .recordSpotFill(
                msg.sender,
                packageNonce,
                spotFillCommitment,
                orderHash,
                quoteHash,
                routeHash,
                ENTRY,
                address(baseToken),
                address(quoteToken),
                quantity,
                quoteIn
            );
    }

    function sellExactInput(
        uint256 packageNonce,
        bytes32 spotFillCommitment,
        bytes32 orderHash,
        bytes32 quoteHash,
        bytes32 routeHash,
        uint256 quantity,
        uint256 minQuote
    ) external returns (uint256 quoteOut) {
        quoteOut = quantity * 2;
        require(quoteOut >= minQuote, "quote bound");
        baseToken.safeTransferFrom(msg.sender, address(this), quantity);
        quoteToken.safeTransfer(msg.sender, quoteOut);
        ISpotFillRecorder(verifier)
            .recordSpotFill(
                msg.sender,
                packageNonce,
                spotFillCommitment,
                orderHash,
                quoteHash,
                routeHash,
                EXIT,
                address(baseToken),
                address(quoteToken),
                quantity,
                quoteOut
            );
    }

    function assertDeployment() external view {}
}

contract StrategyAccountPerp is ISynFuturesInstrument, ISynFuturesPositionObserver {
    mapping(address trader => Position position) private _positions;

    function trade(bytes32[2] calldata args) external returns (PositionCache memory result) {
        uint256 packed = uint256(args[1]);
        int128 sizeDelta = int128(uint128(packed >> 128));
        int128 balanceDelta = int128(uint128(packed));
        Position storage position = _positions[msg.sender];
        position.size += sizeDelta;
        position.balance += balanceDelta;
        position.entryNotional = uint128(uint256(uint128(position.size < 0 ? -position.size : position.size)) * 2);
        result.balance = position.balance;
        result.size = position.size;
        result.entryNotional = position.entryNotional;
    }

    function getPosition(address instrument, uint32, address target) external view returns (Position memory position) {
        require(instrument == address(this), "wrong instrument");
        return _positions[target];
    }
}

contract StrategyAccountAdmissionRegistry {
    ProtocolConfig public immutable config;
    bytes32 public expectedAdmissionHash;

    constructor(ProtocolConfig config_) {
        config = config_;
    }

    function setExpectedAdmissionHash(bytes32 expectedAdmissionHash_) external {
        expectedAdmissionHash = expectedAdmissionHash_;
    }

    function validateCashCarry(ResourceRegistry.CashCarryAdmission calldata admission) external view returns (uint256) {
        require(keccak256(abi.encode(admission)) == expectedAdmissionHash, "unadmitted route");
        return type(uint256).max;
    }
}

contract StrategyAccountSeriesRegistry {
    ProtocolConfig public immutable config;
    ResourceRegistry public immutable resources;
    CashCarrySeriesRegistry.CashCarrySeriesBindingV1 private _binding;
    bytes32 private _identityKey;
    bytes32 private _bindingHash;
    bool private _entryAllowed = true;

    constructor(ProtocolConfig config_, ResourceRegistry resources_) {
        config = config_;
        resources = resources_;
    }

    function configure(
        CashCarrySeriesRegistry.CashCarrySeriesBindingV1 calldata binding_,
        bytes32 identityKey_,
        bytes32 bindingHash_
    ) external {
        _binding = binding_;
        _identityKey = identityKey_;
        _bindingHash = bindingHash_;
    }

    function setEntryAllowed(bool entryAllowed_) external {
        _entryAllowed = entryAllowed_;
    }

    function validateEntry(CashCarrySeriesRegistry.BindingReference calldata exactRef)
        external
        view
        returns (CashCarrySeriesRegistry.CashCarrySeriesBindingV1 memory)
    {
        require(_entryAllowed, "series paused");
        require(
            exactRef.identityKey == _identityKey && exactRef.bindingVersion == _binding.bindingVersion
                && exactRef.bindingHash == _bindingHash,
            "series mismatch"
        );
        return _binding;
    }

    function bindingRecord(bytes32 identityKey_, uint32 bindingVersion_)
        external
        view
        returns (
            CashCarrySeriesRegistry.CashCarrySeriesBindingV1 memory,
            bytes32,
            CashCarrySeriesRegistry.Lifecycle,
            bool
        )
    {
        require(identityKey_ == _identityKey && bindingVersion_ == _binding.bindingVersion, "series mismatch");
        return (_binding, _bindingHash, CashCarrySeriesRegistry.Lifecycle.ENTRY_PAUSED, true);
    }
}

contract NaryxStrategyAccountTest is Test {
    uint32 private constant PERP_EXPIRY = type(uint32).max;
    uint256 private constant QUANTITY = 1 ether;
    uint256 private constant MARGIN = 4 ether;
    bytes32 private constant DOMAIN_MANIFEST_HASH = keccak256("domain-manifest");
    bytes32 private constant ROUTE_HASH = keccak256("route");
    bytes32 private constant DIRECT_ROUTE_HASH = keccak256("direct-inventory-route");
    bytes32 private constant EXIT_ROUTE_HASH = keccak256("public-exit-route");
    bytes32 private constant SERIES_MANIFEST_HASH = keccak256("series-manifest");
    bytes32 private constant EXECUTION_CLASS_MANIFEST_HASH = keccak256("execution-class-manifest");
    bytes32 private constant SERIES_IDENTITY_KEY = keccak256("series-identity");
    bytes32 private constant SERIES_BINDING_HASH = keccak256("series-binding");
    bytes32 private constant BASE_ASSET_ID = keccak256("base-asset");
    bytes32 private constant QUOTE_ASSET_ID = keccak256("quote-asset");
    bytes32 private constant BASE_ASSET_MANIFEST_HASH = keccak256("base-asset-manifest");
    bytes32 private constant QUOTE_ASSET_MANIFEST_HASH = keccak256("quote-asset-manifest");
    bytes32 private constant SHARD_MANIFEST_HASH = keccak256("shard-manifest");
    bytes32 private constant LEVEL_ID = keccak256("package-level");
    bytes32 private constant REFERENCE_HASH = keccak256("package-reference");
    bytes32 private constant SETTLEMENT_CLASS_HASH = keccak256("atomic-settlement");
    bytes32 private constant RESERVATION_POLICY_HASH = keccak256("reservation-policy");
    address private constant PROPOSER = address(0x101);
    address private constant CANCELLER = address(0x102);
    address private constant GOVERNANCE_EXECUTOR = address(0x103);
    address private constant PAUSER = address(0x104);

    uint256 private ownerKey = 0xA11CE;
    uint256 private solverKey = 0xB0B;
    address private owner;
    address private solver;

    StrategyAccountToken private base;
    StrategyAccountToken private quote;
    StrategyAccountPerp private perp;
    ProtocolConfig private config;
    SolverRegistry private solverRegistry;
    StrategyAccountAdmissionRegistry private admissionRegistry;
    StrategyAccountSeriesRegistry private seriesRegistry;
    PackageVerifier private verifier;
    PolicyRegistry private policyRegistry;
    bytes32 private constant FEE_SUBJECT = keccak256("cash-carry-solver-fee");
    PackageQuoteShardRegistry private packageQuoteShardRegistry;
    PackageQuoteShard private packageQuoteShard;
    PackageQuoteShardRegistry.ShardReference private shardReference;
    StrategyAccountSpotPort private spotPort;
    FirmInventoryReservationBook private reservationBook;
    DirectInventorySpotPort private directInventorySpotPort;
    NaryxStrategyAccount private account;

    function setUp() public {
        owner = vm.addr(ownerKey);
        solver = vm.addr(solverKey);
        base = new StrategyAccountToken("Base", "BASE");
        quote = new StrategyAccountToken("Quote", "QUOTE");
        perp = new StrategyAccountPerp();
        config = new ProtocolConfig(
            "eip155:31337", 1, DOMAIN_MANIFEST_HASH, 1, PROPOSER, CANCELLER, GOVERNANCE_EXECUTOR, PAUSER
        );
        solverRegistry = new SolverRegistry(config, solver);
        admissionRegistry = new StrategyAccountAdmissionRegistry(config);
        seriesRegistry = new StrategyAccountSeriesRegistry(config, ResourceRegistry(address(admissionRegistry)));
        packageQuoteShardRegistry = new PackageQuoteShardRegistry(config);
        policyRegistry = new PolicyRegistry(config);
        verifier = new PackageVerifier(
            config,
            solverRegistry,
            ResourceRegistry(address(admissionRegistry)),
            CashCarrySeriesRegistry(address(seriesRegistry)),
            packageQuoteShardRegistry,
            policyRegistry,
            FEE_SUBJECT
        );
        seriesRegistry.configure(_seriesBinding(), SERIES_IDENTITY_KEY, SERIES_BINDING_HASH);
        packageQuoteShard = new PackageQuoteShard(
            PackageQuoteShard.Deployment({
                chainId: block.chainid,
                config: address(config),
                configCodeHash: address(config).codehash,
                solver: solver,
                consumer: address(verifier),
                consumerCodeHash: address(verifier).codehash,
                seriesManifestHash: SERIES_MANIFEST_HASH,
                executionClassManifestHash: EXECUTION_CLASS_MANIFEST_HASH
            }),
            PackageQuoteShard.Limits({maxHeartbeatSeconds: 1 hours, maxBatchSize: 8, maxLevelCount: 32})
        );
        _activateQuoteShard();
        spotPort = new StrategyAccountSpotPort(address(verifier), IERC20(address(base)), IERC20(address(quote)));
        account = new NaryxStrategyAccount(owner, verifier);
        reservationBook = new FirmInventoryReservationBook(config, base, quote, 1 hours, 10 ether, 20 ether);
        directInventorySpotPort = new DirectInventorySpotPort(
            DirectInventorySpotPort.Deployment({
                chainId: block.chainid,
                config: config,
                verifier: address(verifier),
                reservationBook: reservationBook,
                baseToken: base,
                quoteToken: quote,
                domainIdHash: keccak256("eip155:31337"),
                domainManifestVersion: 1,
                domainManifestHash: DOMAIN_MANIFEST_HASH,
                configCodeHash: address(config).codehash,
                verifierCodeHash: address(verifier).codehash,
                reservationBookCodeHash: address(reservationBook).codehash,
                baseTokenCodeHash: address(base).codehash,
                quoteTokenCodeHash: address(quote).codehash
            })
        );

        base.mint(address(spotPort), 100 ether);
        quote.mint(address(spotPort), 200 ether);
        base.mint(solver, 10 ether);
        quote.mint(address(account), 20 ether);
        vm.prank(PROPOSER);
        config.scheduleUnpause();
        vm.warp(block.timestamp + 1);
        vm.prank(GOVERNANCE_EXECUTOR);
        config.activateUnpause();
    }

    function testExecutePackageEntersWithExactAllowancesAndReceipt() public {
        (PackageVerifier.Execution memory execution, ResourceRegistry.CashCarryAdmission memory admission) = _entry();
        _admit(admission);
        (bytes memory traderSignature, bytes memory solverSignature) = _sign(execution, admission);

        bytes32 receiptHash = account.executePackage(
            execution, admission, traderSignature, solverSignature, _tradeArgs(-int128(int256(QUANTITY)), 4 ether)
        );

        assertEq(base.balanceOf(address(account)), QUANTITY);
        assertEq(quote.balanceOf(address(account)), 18 ether);
        assertEq(quote.allowance(address(account), address(spotPort)), 0);
        assertEq(verifier.nextNonce(address(account)), 1);
        PackageVerifier.Receipt memory receipt_ = verifier.receipt(receiptHash);
        assertEq(receipt_.strategyAccount, address(account));
        assertEq(receipt_.postPerpSizeWad, -int128(int256(QUANTITY)));
        assertFalse(receipt_.recovery);
    }

    function testOwnerRecoveryExitClosesPerpBeforeSellingSpot() public {
        bytes32 entryReceiptHash = _enter();
        (PackageVerifier.Execution memory execution, ResourceRegistry.CashCarryAdmission memory admission) =
            _exit(entryReceiptHash, address(0));
        _admit(admission);
        bytes memory traderSignature = _signature(ownerKey, verifier.traderPermitDigest(execution, admission));

        vm.prank(owner);
        bytes32 receiptHash = account.executeRecoveryExit(
            execution, admission, traderSignature, _tradeArgs(int128(int256(QUANTITY)), -int128(int256(MARGIN)))
        );

        assertEq(base.balanceOf(address(account)), 0);
        assertEq(quote.balanceOf(address(account)), 20 ether);
        assertEq(base.allowance(address(account), address(spotPort)), 0);
        assertEq(verifier.nextNonce(address(account)), 2);
        PackageVerifier.Receipt memory receipt_ = verifier.receipt(receiptHash);
        assertTrue(receipt_.recovery);
        assertEq(receipt_.postPerpSizeWad, 0);
    }

    function testFirmDirectInventoryEntryExitsThroughFreshPublicRoute() public {
        (
            PackageVerifier.Execution memory entry,
            ResourceRegistry.CashCarryAdmission memory entryAdmission,
            PackageVerifier.QuoteIntent memory intent,
            bytes32 reservationId
        ) = _firmDirectEntry();
        _admit(entryAdmission);
        (bytes memory traderSignature, bytes memory solverSignature) = _sign(entry, entryAdmission);

        bytes32 entryReceiptHash = account.executeQuotedPackage(
            entry,
            entryAdmission,
            intent,
            traderSignature,
            solverSignature,
            _tradeArgs(-int128(int256(QUANTITY)), int128(int256(MARGIN)))
        );

        assertEq(
            uint8(reservationBook.reservation(reservationId).state),
            uint8(FirmInventoryReservationBook.ReservationState.CONSUMED)
        );
        assertEq(base.balanceOf(address(account)), QUANTITY);
        assertEq(quote.balanceOf(address(account)), 18 ether);
        assertEq(quote.allowance(address(account), address(reservationBook)), 0);
        PackageVerifier.Receipt memory entryReceipt = verifier.receipt(entryReceiptHash);
        assertEq(entryReceipt.routeHash, DIRECT_ROUTE_HASH);

        (PackageVerifier.Execution memory exit, ResourceRegistry.CashCarryAdmission memory exitAdmission) =
            _exit(entryReceiptHash, solver);
        _admit(exitAdmission);
        (traderSignature, solverSignature) = _sign(exit, exitAdmission);
        bytes32 exitReceiptHash = account.executePackage(
            exit,
            exitAdmission,
            traderSignature,
            solverSignature,
            _tradeArgs(int128(int256(QUANTITY)), -int128(int256(MARGIN)))
        );

        assertEq(verifier.receipt(exitReceiptHash).routeHash, EXIT_ROUTE_HASH);
        assertEq(base.balanceOf(address(account)), 0);
        assertEq(quote.balanceOf(address(account)), 20 ether);
        assertEq(perp.getPosition(address(perp), PERP_EXPIRY, address(account)).size, 0);
        assertFalse(verifier.hasOpenPackage(address(account)));
    }

    function testDelegateSubmitsOnlyAnOwnerSignedRecoveryExitUntilExpiry() public {
        address keeper = makeAddr("keeper");
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(NaryxStrategyAccount.UnauthorizedOwner.selector, keeper));
        account.setDelegation(keeper, 1, uint64(block.timestamp + 1 hours));
        vm.startPrank(owner);
        vm.expectRevert(NaryxStrategyAccount.InvalidDelegation.selector);
        account.setDelegation(keeper, 3, uint64(block.timestamp + 1 hours));
        vm.expectRevert(NaryxStrategyAccount.InvalidDelegation.selector);
        account.setDelegation(keeper, 1, uint64(block.timestamp + 31 days));
        account.setDelegation(keeper, 1, uint64(block.timestamp + 1 hours));
        vm.stopPrank();

        bytes32 entryReceiptHash = _enter();
        (PackageVerifier.Execution memory execution, ResourceRegistry.CashCarryAdmission memory admission) =
            _exit(entryReceiptHash, address(0));
        _admit(admission);
        bytes memory traderSignature = _signature(ownerKey, verifier.traderPermitDigest(execution, admission));
        // A delegate may not withdraw.
        vm.prank(keeper);
        vm.expectRevert(NaryxStrategyAccount.UnauthorizedWithdrawal.selector);
        account.withdrawIdleToken(IERC20(address(quote)), keeper, 1);
        vm.prank(keeper);
        account.executeRecoveryExit(
            execution, admission, traderSignature, _tradeArgs(int128(int256(QUANTITY)), -int128(int256(MARGIN)))
        );
        assertEq(base.balanceOf(address(account)), 0);
        vm.warp(block.timestamp + 2 hours);
        assertFalse(account.hasAuthority(keeper, 1));
    }

    function testNovationNeedsTheNewOwnersAcceptanceAndVoidsOldSignaturesAndDelegations() public {
        address successor = vm.addr(0xB0B0);
        address keeper = makeAddr("keeper");
        vm.startPrank(owner);
        account.setDelegation(keeper, 1, uint64(block.timestamp + 1 hours));
        vm.expectRevert(NaryxStrategyAccount.InvalidTransfer.selector);
        account.proposeOwnerTransfer(successor, uint64(block.timestamp + 8 days));
        account.proposeOwnerTransfer(successor, uint64(block.timestamp + 1 days));
        vm.stopPrank();
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(NaryxStrategyAccount.UnauthorizedOwner.selector, keeper));
        account.acceptOwnerTransfer();

        bytes32 digest = keccak256("strategy-intent");
        assertEq(account.isValidSignature(digest, _signature(ownerKey, digest)), bytes4(0x1626ba7e));
        vm.prank(successor);
        account.acceptOwnerTransfer();
        assertEq(account.owner(), successor);
        assertEq(account.pendingOwner(), address(0));
        assertEq(account.isValidSignature(digest, _signature(ownerKey, digest)), bytes4(0xffffffff));
        assertEq(account.isValidSignature(digest, _signature(0xB0B0, digest)), bytes4(0x1626ba7e));
        assertFalse(account.hasAuthority(keeper, 1), "a transfer ends every earlier delegation");
        vm.prank(owner);
        vm.expectRevert(NaryxStrategyAccount.UnauthorizedWithdrawal.selector);
        account.withdrawIdleToken(IERC20(address(quote)), owner, 1);

        vm.prank(successor);
        account.proposeOwnerTransfer(owner, uint64(block.timestamp + 1 hours));
        vm.warp(block.timestamp + 1 hours);
        vm.prank(owner);
        vm.expectRevert(NaryxStrategyAccount.TransferExpired.selector);
        account.acceptOwnerTransfer();
    }

    function testExitRejectsZeroEntryReceipt() public {
        _enter();
        (PackageVerifier.Execution memory execution, ResourceRegistry.CashCarryAdmission memory admission) =
            _exit(bytes32(0), solver);
        _admit(admission);
        (bytes memory traderSignature, bytes memory solverSignature) = _sign(execution, admission);

        vm.expectRevert(PackageVerifier.PositionMismatch.selector);
        account.executePackage(
            execution,
            admission,
            traderSignature,
            solverSignature,
            _tradeArgs(int128(int256(QUANTITY)), -int128(int256(MARGIN)))
        );
    }

    function testExitRejectsWrongEntryReceipt() public {
        _enter();
        (PackageVerifier.Execution memory execution, ResourceRegistry.CashCarryAdmission memory admission) =
            _exit(keccak256("wrong-entry-receipt"), solver);
        _admit(admission);
        (bytes memory traderSignature, bytes memory solverSignature) = _sign(execution, admission);

        vm.expectRevert(PackageVerifier.PositionMismatch.selector);
        account.executePackage(
            execution,
            admission,
            traderSignature,
            solverSignature,
            _tradeArgs(int128(int256(QUANTITY)), -int128(int256(MARGIN)))
        );
    }

    function testExitRejectsMismatchedPackageSize() public {
        bytes32 entryReceiptHash = _enter();
        (PackageVerifier.Execution memory execution, ResourceRegistry.CashCarryAdmission memory admission) =
            _exit(entryReceiptHash, solver);
        execution.packageSizeUnits += 1;
        _admit(admission);
        (bytes memory traderSignature, bytes memory solverSignature) = _sign(execution, admission);

        vm.expectRevert(PackageVerifier.PositionMismatch.selector);
        account.executePackage(
            execution,
            admission,
            traderSignature,
            solverSignature,
            _tradeArgs(int128(int256(QUANTITY)), -int128(int256(MARGIN)))
        );
    }

    function testFinalizeFailureRollsBackSpotPerpAllowanceAndNonce() public {
        (PackageVerifier.Execution memory execution, ResourceRegistry.CashCarryAdmission memory admission) = _entry();
        _admit(admission);
        (bytes memory traderSignature, bytes memory solverSignature) = _sign(execution, admission);
        uint256 accountQuoteBefore = quote.balanceOf(address(account));
        uint256 portBaseBefore = base.balanceOf(address(spotPort));

        vm.expectRevert(PackageVerifier.PostconditionFailed.selector);
        account.executePackage(
            execution, admission, traderSignature, solverSignature, _tradeArgs(-int128(int256(2 ether)), 4 ether)
        );

        assertEq(base.balanceOf(address(account)), 0);
        assertEq(quote.balanceOf(address(account)), accountQuoteBefore);
        assertEq(base.balanceOf(address(spotPort)), portBaseBefore);
        assertEq(quote.allowance(address(account), address(spotPort)), 0);
        assertEq(perp.getPosition(address(perp), PERP_EXPIRY, address(account)).size, 0);
        assertEq(verifier.nextNonce(address(account)), 0);
    }

    function testRejectsExecutionForAnotherStrategyAccount() public {
        (PackageVerifier.Execution memory execution, ResourceRegistry.CashCarryAdmission memory admission) = _entry();
        execution.strategyAccount = address(0xBEEF);

        vm.expectRevert(NaryxStrategyAccount.InvalidExecution.selector);
        account.executePackage(execution, admission, bytes(""), bytes(""), _tradeArgs(0, 0));
    }

    function testRejectsIdleWithdrawalWhilePackageOpen() public {
        _enter();

        vm.prank(owner);
        vm.expectRevert(NaryxStrategyAccount.OpenPackageExists.selector);
        account.withdrawIdleToken(IERC20(address(quote)), owner, 1 ether);
    }

    function testOwnerWithdrawsExactIdleTokensAfterVerifiedExit() public {
        bytes32 entryReceiptHash = _enter();
        (PackageVerifier.Execution memory execution, ResourceRegistry.CashCarryAdmission memory admission) =
            _exit(entryReceiptHash, solver);
        _admit(admission);
        (bytes memory traderSignature, bytes memory solverSignature) = _sign(execution, admission);
        account.executePackage(
            execution,
            admission,
            traderSignature,
            solverSignature,
            _tradeArgs(int128(int256(QUANTITY)), -int128(int256(MARGIN)))
        );

        address recipient = address(0xBEEF);
        uint256 accountBalanceBefore = quote.balanceOf(address(account));
        uint256 recipientBalanceBefore = quote.balanceOf(recipient);
        vm.prank(owner);
        account.withdrawIdleToken(IERC20(address(quote)), recipient, 5 ether);

        assertEq(quote.balanceOf(address(account)), accountBalanceBefore - 5 ether);
        assertEq(quote.balanceOf(recipient), recipientBalanceBefore + 5 ether);
    }

    function testRejectsUnauthorizedIdleWithdrawal() public {
        vm.expectRevert(NaryxStrategyAccount.UnauthorizedWithdrawal.selector);
        account.withdrawIdleToken(IERC20(address(quote)), address(0xBEEF), 1 ether);
    }

    function testQuotedPackageConsumesCapacityAndBindsReceipt() public {
        (
            PackageVerifier.Execution memory execution,
            ResourceRegistry.CashCarryAdmission memory admission,
            PackageVerifier.QuoteIntent memory intent
        ) = _quotedEntry(packageQuoteShard.EXECUTION_COMMITMENT(), 0, bytes32(0));
        _admit(admission);
        (bytes memory traderSignature, bytes memory solverSignature) = _sign(execution, admission);

        bytes32 receiptHash = account.executeQuotedPackage(
            execution,
            admission,
            intent,
            traderSignature,
            solverSignature,
            _tradeArgs(-int128(int256(QUANTITY)), int128(int256(MARGIN)))
        );

        PackageVerifier.Receipt memory receipt_ = verifier.receipt(receiptHash);
        assertEq(receipt_.packageQuoteIntentHash, execution.packageQuoteIntentHash);
        assertTrue(receipt_.packageQuoteFillCommitment != bytes32(0));
        assertEq(receipt_.packageSizeUnits, uint128(QUANTITY));
        assertEq(packageQuoteShard.quoteLevel(LEVEL_ID).remainingCapacityUnits, uint128(9 * QUANTITY));
    }

    function testFirmQuoteRequiresReservationMatchingSpotFill() public {
        (
            PackageVerifier.Execution memory execution,
            ResourceRegistry.CashCarryAdmission memory admission,
            PackageVerifier.QuoteIntent memory intent
        ) = _quotedEntry(packageQuoteShard.FIRM_ONCHAIN(), 0, keccak256("wrong-reservation"));
        _admit(admission);
        (bytes memory traderSignature, bytes memory solverSignature) = _sign(execution, admission);

        vm.expectRevert(PackageVerifier.InvalidPackageQuote.selector);
        account.executeQuotedPackage(
            execution,
            admission,
            intent,
            traderSignature,
            solverSignature,
            _tradeArgs(-int128(int256(QUANTITY)), int128(int256(MARGIN)))
        );
        assertEq(packageQuoteShard.quoteLevel(LEVEL_ID).remainingCapacityUnits, uint128(10 * QUANTITY));
    }

    function testQuotedPackageRejectsStaleRegistryReference() public {
        (
            PackageVerifier.Execution memory execution,
            ResourceRegistry.CashCarryAdmission memory admission,
            PackageVerifier.QuoteIntent memory intent
        ) = _quotedEntry(packageQuoteShard.EXECUTION_COMMITMENT(), 0, bytes32(0));
        intent.shardReference.manifestHash = keccak256("stale-manifest");
        execution.packageQuoteIntentHash = verifier.packageQuoteIntentHash(intent);
        _admit(admission);
        (bytes memory traderSignature, bytes memory solverSignature) = _sign(execution, admission);

        vm.expectRevert(PackageVerifier.InvalidPackageQuote.selector);
        account.executeQuotedPackage(
            execution,
            admission,
            intent,
            traderSignature,
            solverSignature,
            _tradeArgs(-int128(int256(QUANTITY)), int128(int256(MARGIN)))
        );
    }

    function testQuotedPackageRejectsChangedSequenceAndModifiedIntent() public {
        (
            PackageVerifier.Execution memory execution,
            ResourceRegistry.CashCarryAdmission memory admission,
            PackageVerifier.QuoteIntent memory intent
        ) = _quotedEntry(packageQuoteShard.EXECUTION_COMMITMENT(), 0, bytes32(0));
        intent.consumeRequest.expectedShardSequence = 1;
        execution.packageQuoteIntentHash = verifier.packageQuoteIntentHash(intent);
        _admit(admission);
        (bytes memory traderSignature, bytes memory solverSignature) = _sign(execution, admission);

        vm.expectRevert(PackageVerifier.InvalidPackageQuote.selector);
        account.executeQuotedPackage(
            execution,
            admission,
            intent,
            traderSignature,
            solverSignature,
            _tradeArgs(-int128(int256(QUANTITY)), int128(int256(MARGIN)))
        );

        intent.consumeRequest.expectedShardSequence = 2;
        execution.packageQuoteIntentHash = verifier.packageQuoteIntentHash(intent);
        (traderSignature, solverSignature) = _sign(execution, admission);
        intent.consumeRequest.expectedPackagePrice += 1;
        vm.expectRevert(PackageVerifier.InvalidPackageQuote.selector);
        account.executeQuotedPackage(
            execution,
            admission,
            intent,
            traderSignature,
            solverSignature,
            _tradeArgs(-int128(int256(QUANTITY)), int128(int256(MARGIN)))
        );
        assertEq(packageQuoteShard.quoteLevel(LEVEL_ID).remainingCapacityUnits, uint128(10 * QUANTITY));
    }

    function testQuotedPackageRejectsNonzeroFeeWithoutAnActiveFeePolicy() public {
        _expectFeeRevert(1);
    }

    function testQuotedPackageFeeMustSitWithinTheActiveFeePolicyCap() public {
        _activateFeePolicy(25);
        // The notional is 2 ether, so 25 bps caps the fee at 0.005 ether.
        (
            PackageVerifier.Execution memory execution,
            ResourceRegistry.CashCarryAdmission memory admission,
            PackageVerifier.QuoteIntent memory intent
        ) = _quotedEntry(packageQuoteShard.EXECUTION_COMMITMENT(), 0.005 ether, bytes32(0));
        _admit(admission);
        (bytes memory traderSignature, bytes memory solverSignature) = _sign(execution, admission);
        bytes32 receiptHash = account.executeQuotedPackage(
            execution,
            admission,
            intent,
            traderSignature,
            solverSignature,
            _tradeArgs(-int128(int256(QUANTITY)), int128(int256(MARGIN)))
        );
        assertTrue(verifier.receipt(receiptHash).packageQuoteFillCommitment != bytes32(0));
    }

    function testQuotedPackageFeeAboveTheActiveFeePolicyCapReverts() public {
        _activateFeePolicy(25);
        _expectFeeRevert(0.005 ether + 1);
    }

    function testPausedFeePolicyRejectsEveryFee() public {
        _activateFeePolicy(25);
        vm.prank(PAUSER);
        policyRegistry.pause(PolicyRegistry.PolicyKind.FEE_POLICY, FEE_SUBJECT);
        _expectFeeRevert(1);
    }

    function testVerifierFeeBindingMustBeCoherent() public {
        ProtocolConfig other = new ProtocolConfig(
            "eip155:31337", 1, DOMAIN_MANIFEST_HASH, 1, PROPOSER, CANCELLER, GOVERNANCE_EXECUTOR, PAUSER
        );
        PolicyRegistry foreign = new PolicyRegistry(other);
        ResourceRegistry resources = ResourceRegistry(address(admissionRegistry));
        CashCarrySeriesRegistry series = CashCarrySeriesRegistry(address(seriesRegistry));
        vm.expectRevert(PackageVerifierValidation.InvalidConfiguration.selector);
        new PackageVerifier(
            config,
            solverRegistry,
            resources,
            series,
            packageQuoteShardRegistry,
            PolicyRegistry(address(0)),
            FEE_SUBJECT
        );
        vm.expectRevert(PackageVerifierValidation.InvalidConfiguration.selector);
        new PackageVerifier(config, solverRegistry, resources, series, packageQuoteShardRegistry, foreign, FEE_SUBJECT);
        vm.expectRevert(PackageVerifierValidation.InvalidConfiguration.selector);
        new PackageVerifier(
            config, solverRegistry, resources, series, packageQuoteShardRegistry, policyRegistry, bytes32(0)
        );
    }

    function _activateFeePolicy(uint16 maximumFeeBps) private {
        vm.prank(PROPOSER);
        policyRegistry.proposeActivation(
            PolicyRegistry.PolicyKind.FEE_POLICY, FEE_SUBJECT, 1, keccak256("fee-policy-v1"), maximumFeeBps
        );
        vm.warp(block.timestamp + config.configDelaySeconds());
        vm.prank(GOVERNANCE_EXECUTOR);
        policyRegistry.activate(PolicyRegistry.PolicyKind.FEE_POLICY, FEE_SUBJECT);
    }

    function _expectFeeRevert(uint128 feeAtoms) private {
        (
            PackageVerifier.Execution memory execution,
            ResourceRegistry.CashCarryAdmission memory admission,
            PackageVerifier.QuoteIntent memory intent
        ) = _quotedEntry(packageQuoteShard.EXECUTION_COMMITMENT(), feeAtoms, bytes32(0));
        _admit(admission);
        (bytes memory traderSignature, bytes memory solverSignature) = _sign(execution, admission);
        vm.expectRevert(PackageVerifierValidation.FeeNotPermitted.selector);
        account.executeQuotedPackage(
            execution,
            admission,
            intent,
            traderSignature,
            solverSignature,
            _tradeArgs(-int128(int256(QUANTITY)), int128(int256(MARGIN)))
        );
    }

    function testQuotedCapacityRollsBackWhenDownstreamExecutionFails() public {
        (
            PackageVerifier.Execution memory execution,
            ResourceRegistry.CashCarryAdmission memory admission,
            PackageVerifier.QuoteIntent memory intent
        ) = _quotedEntry(packageQuoteShard.EXECUTION_COMMITMENT(), 0, bytes32(0));
        _admit(admission);
        (bytes memory traderSignature, bytes memory solverSignature) = _sign(execution, admission);

        vm.expectRevert(PackageVerifier.PostconditionFailed.selector);
        account.executeQuotedPackage(
            execution,
            admission,
            intent,
            traderSignature,
            solverSignature,
            _tradeArgs(-int128(int256(2 ether)), int128(int256(MARGIN)))
        );
        assertEq(packageQuoteShard.quoteLevel(LEVEL_ID).remainingCapacityUnits, uint128(10 * QUANTITY));
        assertEq(packageQuoteShard.shardSequence(), 2);
    }

    function testEntryRejectsNondivisibleSpotQuantity() public {
        CashCarrySeriesRegistry.CashCarrySeriesBindingV1 memory binding = _seriesBinding();
        binding.spotBaseAtomsPerPackageUnit = 3;
        seriesRegistry.configure(binding, SERIES_IDENTITY_KEY, SERIES_BINDING_HASH);
        _expectPackageUnitsRevert();
    }

    function testEntryRejectsNondivisiblePerpQuantity() public {
        CashCarrySeriesRegistry.CashCarrySeriesBindingV1 memory binding = _seriesBinding();
        binding.perpQuantityAtomsPerPackageUnit = 3;
        seriesRegistry.configure(binding, SERIES_IDENTITY_KEY, SERIES_BINDING_HASH);
        _expectPackageUnitsRevert();
    }

    function testEntryRejectsUnequalDerivedUnits() public {
        CashCarrySeriesRegistry.CashCarrySeriesBindingV1 memory binding = _seriesBinding();
        binding.spotBaseAtomsPerPackageUnit = 2;
        seriesRegistry.configure(binding, SERIES_IDENTITY_KEY, SERIES_BINDING_HASH);
        _expectPackageUnitsRevert();
    }

    function testQuotedPackageRejectsWrongDirection() public {
        (
            PackageVerifier.Execution memory execution,
            ResourceRegistry.CashCarryAdmission memory admission,
            PackageVerifier.QuoteIntent memory intent
        ) = _quotedEntry(packageQuoteShard.EXECUTION_COMMITMENT(), 0, bytes32(0));
        intent.consumeRequest.expectedDirection = PackageQuoteShard.Direction.BID;
        execution.packageQuoteIntentHash = verifier.packageQuoteIntentHash(intent);
        _expectQuotedPackageRevert(execution, admission, intent);
    }

    function testQuotedPackageRejectsWrongSettlement() public {
        (
            PackageVerifier.Execution memory execution,
            ResourceRegistry.CashCarryAdmission memory admission,
            PackageVerifier.QuoteIntent memory intent
        ) = _quotedEntry(packageQuoteShard.EXECUTION_COMMITMENT(), 0, bytes32(0));
        intent.consumeRequest.expectedSettlementClassIdentityHash = keccak256("wrong-settlement");
        execution.packageQuoteIntentHash = verifier.packageQuoteIntentHash(intent);
        _expectQuotedPackageRevert(execution, admission, intent);
    }

    function testQuotedPackageRejectsWrongSeriesManifest() public {
        (
            PackageVerifier.Execution memory execution,
            ResourceRegistry.CashCarryAdmission memory admission,
            PackageVerifier.QuoteIntent memory intent
        ) = _quotedEntry(packageQuoteShard.EXECUTION_COMMITMENT(), 0, bytes32(0));
        CashCarrySeriesRegistry.CashCarrySeriesBindingV1 memory binding = _seriesBinding();
        binding.seriesManifestHash = keccak256("wrong-series");
        seriesRegistry.configure(binding, SERIES_IDENTITY_KEY, SERIES_BINDING_HASH);
        _expectQuotedPackageRevert(execution, admission, intent);
    }

    function testQuotedPackageRejectsWrongExecutionClass() public {
        (
            PackageVerifier.Execution memory execution,
            ResourceRegistry.CashCarryAdmission memory admission,
            PackageVerifier.QuoteIntent memory intent
        ) = _quotedEntry(packageQuoteShard.EXECUTION_COMMITMENT(), 0, bytes32(0));
        CashCarrySeriesRegistry.CashCarrySeriesBindingV1 memory binding = _seriesBinding();
        binding.executionClassManifestHash = keccak256("wrong-execution-class");
        seriesRegistry.configure(binding, SERIES_IDENTITY_KEY, SERIES_BINDING_HASH);
        _expectQuotedPackageRevert(execution, admission, intent);
    }

    function testExitSurvivesSeriesPauseAndAssetManifestRotation() public {
        bytes32 entryReceiptHash = _enter();
        seriesRegistry.setEntryAllowed(false);
        (PackageVerifier.Execution memory execution, ResourceRegistry.CashCarryAdmission memory admission) =
            _exit(entryReceiptHash, solver);
        admission.baseAsset.manifest.manifestVersion = 2;
        admission.baseAsset.manifest.manifestHash = keccak256("rotated-base-manifest");
        admission.quoteAsset.manifest.manifestVersion = 2;
        admission.quoteAsset.manifest.manifestHash = keccak256("rotated-quote-manifest");
        _admit(admission);
        (bytes memory traderSignature, bytes memory solverSignature) = _sign(execution, admission);

        account.executePackage(
            execution,
            admission,
            traderSignature,
            solverSignature,
            _tradeArgs(int128(int256(QUANTITY)), -int128(int256(MARGIN)))
        );

        assertFalse(verifier.hasOpenPackage(address(account)));
    }

    function testExitSurvivesDomainManifestRotation() public {
        bytes32 entryReceiptHash = _enter();
        bytes32 nextDomainManifestHash = keccak256("next-domain-manifest");
        vm.prank(PROPOSER);
        config.proposeDomain(2, nextDomainManifestHash);
        vm.warp(block.timestamp + 1);
        vm.prank(GOVERNANCE_EXECUTOR);
        config.activateDomain();

        (PackageVerifier.Execution memory execution,) = _exit(entryReceiptHash, solver);
        execution.domainManifestVersion = 2;
        execution.domainManifestHash = nextDomainManifestHash;
        ResourceRegistry.CashCarryAdmission memory admission = _admission(execution);
        _admit(admission);
        (bytes memory traderSignature, bytes memory solverSignature) = _sign(execution, admission);

        account.executePackage(
            execution,
            admission,
            traderSignature,
            solverSignature,
            _tradeArgs(int128(int256(QUANTITY)), -int128(int256(MARGIN)))
        );

        assertFalse(verifier.hasOpenPackage(address(account)));
    }

    function _expectPackageUnitsRevert() private {
        (PackageVerifier.Execution memory execution, ResourceRegistry.CashCarryAdmission memory admission) = _entry();
        _admit(admission);
        (bytes memory traderSignature, bytes memory solverSignature) = _sign(execution, admission);
        vm.expectRevert(PackageVerifier.InvalidPackageUnits.selector);
        account.executePackage(execution, admission, traderSignature, solverSignature, _tradeArgs(0, 0));
    }

    function _expectQuotedPackageRevert(
        PackageVerifier.Execution memory execution,
        ResourceRegistry.CashCarryAdmission memory admission,
        PackageVerifier.QuoteIntent memory intent
    ) private {
        _admit(admission);
        (bytes memory traderSignature, bytes memory solverSignature) = _sign(execution, admission);
        vm.expectRevert(PackageVerifier.InvalidPackageQuote.selector);
        account.executeQuotedPackage(execution, admission, intent, traderSignature, solverSignature, _tradeArgs(0, 0));
    }

    function _activateQuoteShard() private {
        PackageQuoteShardRegistry.ShardIdentity memory identity = PackageQuoteShardRegistry.ShardIdentity({
            seriesManifestHash: SERIES_MANIFEST_HASH,
            executionClassManifestHash: EXECUTION_CLASS_MANIFEST_HASH,
            solver: solver
        });
        bytes32 identityKey = packageQuoteShardRegistry.identityKey(identity);
        vm.prank(PROPOSER);
        packageQuoteShardRegistry.proposeRegistration(
            identity,
            1,
            SHARD_MANIFEST_HASH,
            address(packageQuoteShard),
            address(packageQuoteShard).codehash,
            address(verifier),
            address(verifier).codehash
        );
        vm.warp(block.timestamp + 1);
        vm.prank(GOVERNANCE_EXECUTOR);
        packageQuoteShardRegistry.activateRegistration(identityKey);
        shardReference = PackageQuoteShardRegistry.ShardReference({
            identityKey: identityKey,
            manifestVersion: 1,
            manifestHash: SHARD_MANIFEST_HASH,
            shard: address(packageQuoteShard),
            shardCodeHash: address(packageQuoteShard).codehash,
            consumer: address(verifier),
            consumerCodeHash: address(verifier).codehash
        });
    }

    function _quotedEntry(uint8 quoteMode, uint128 feeAtoms, bytes32 reservationId)
        private
        returns (
            PackageVerifier.Execution memory execution,
            ResourceRegistry.CashCarryAdmission memory admission,
            PackageVerifier.QuoteIntent memory intent
        )
    {
        _configureQuote(quoteMode, feeAtoms);
        (execution, admission) = _entry();
        intent.shardReference = shardReference;
        intent.consumeRequest = PackageQuoteShard.ConsumeRequest({
            levelId: LEVEL_ID,
            expectedDirection: PackageQuoteShard.Direction.ASK,
            expectedSettlementClassIdentityHash: SETTLEMENT_CLASS_HASH,
            expectedEpoch: 1,
            expectedLevelSequence: 2,
            expectedReferenceSequence: 1,
            expectedShardSequence: 2,
            expectedExpiry: uint64(block.timestamp + 10 minutes),
            sizeUnits: uint128(QUANTITY),
            feeAtoms: feeAtoms,
            expectedPackagePrice: 105,
            orderHash: execution.orderHash,
            quoteHash: execution.quoteHash,
            routeHash: execution.routeHash,
            reservationId: reservationId
        });
        execution.packageQuoteIntentHash = verifier.packageQuoteIntentHash(intent);
    }

    function _firmDirectEntry()
        private
        returns (
            PackageVerifier.Execution memory execution,
            ResourceRegistry.CashCarryAdmission memory admission,
            PackageVerifier.QuoteIntent memory intent,
            bytes32 reservationId
        )
    {
        execution = _execution(verifier.ENTRY(), solver, 0);
        execution.routeHash = DIRECT_ROUTE_HASH;
        execution.spotPort = address(directInventorySpotPort);
        execution.spotQuoteBoundAtoms = 2 ether;
        execution.expectedPostPerpSizeWad = -int128(int256(QUANTITY));
        execution.minimumPostPerpBalanceWad = int128(int256(MARGIN));
        execution.maximumPostPerpBalanceWad = int128(int256(MARGIN));
        execution.maximumPostPerpEntryNotionalWad = uint128(3 ether);

        FirmInventoryReservationBook.ReservationTerms memory terms = FirmInventoryReservationBook.ReservationTerms({
            domain: FirmInventoryReservationBook.DomainRef({
                domainIdHash: execution.domainIdHash,
                manifestVersion: execution.domainManifestVersion,
                manifestHash: execution.domainManifestHash
            }),
            solverId: "solver:base:test",
            solver: solver,
            reclaimOwner: solver,
            strategyAccount: address(account),
            packageNonce: execution.nonce,
            orderHash: execution.orderHash,
            reservationNonce: 1,
            baseAtoms: execution.baseQuantityAtoms,
            quoteAtoms: execution.spotQuoteBoundAtoms,
            expiry: uint64(block.timestamp + 30 minutes),
            consumer: address(directInventorySpotPort),
            consumerCodeHash: address(directInventorySpotPort).codehash
        });
        vm.startPrank(solver);
        base.approve(address(reservationBook), execution.baseQuantityAtoms);
        reservationId = reservationBook.reserve(terms);
        reservationBook.finalizeReservation(reservationId, execution.quoteHash, execution.routeHash);
        vm.stopPrank();
        execution.spotFillCommitment = reservationId;

        _configureQuote(packageQuoteShard.FIRM_ONCHAIN(), 0);
        intent.shardReference = shardReference;
        intent.consumeRequest = PackageQuoteShard.ConsumeRequest({
            levelId: LEVEL_ID,
            expectedDirection: PackageQuoteShard.Direction.ASK,
            expectedSettlementClassIdentityHash: SETTLEMENT_CLASS_HASH,
            expectedEpoch: 1,
            expectedLevelSequence: 2,
            expectedReferenceSequence: 1,
            expectedShardSequence: 2,
            expectedExpiry: uint64(block.timestamp + 10 minutes),
            sizeUnits: execution.packageSizeUnits,
            feeAtoms: 0,
            expectedPackagePrice: 105,
            orderHash: execution.orderHash,
            quoteHash: execution.quoteHash,
            routeHash: execution.routeHash,
            reservationId: reservationId
        });
        execution.packageQuoteIntentHash = verifier.packageQuoteIntentHash(intent);
        admission = _admission(execution);
    }

    function _configureQuote(uint8 quoteMode, uint128 maxFeeAtoms) private {
        uint64 expiresAt = uint64(block.timestamp + 10 minutes);
        vm.prank(solver);
        packageQuoteShard.updateReference(100, REFERENCE_HASH, 1, expiresAt, 0);
        PackageQuoteShard.QuoteLevelInput[] memory levels = new PackageQuoteShard.QuoteLevelInput[](1);
        levels[0] = PackageQuoteShard.QuoteLevelInput({
            levelId: LEVEL_ID,
            direction: PackageQuoteShard.Direction.ASK,
            minSizeUnits: uint128(QUANTITY),
            maxSizeUnits: uint128(QUANTITY),
            referenceOffset: 5,
            maxFeeAtoms: maxFeeAtoms,
            settlementClassIdentityHash: SETTLEMENT_CLASS_HASH,
            quoteMode: quoteMode,
            reservationPolicyHash: quoteMode == packageQuoteShard.FIRM_ONCHAIN() ? RESERVATION_POLICY_HASH : bytes32(0),
            expiresAt: expiresAt,
            capacityUnits: uint128(10 * QUANTITY)
        });
        vm.prank(solver);
        packageQuoteShard.upsertQuoteLevels(levels, 1);
    }

    function _enter() private returns (bytes32 receiptHash) {
        (PackageVerifier.Execution memory execution, ResourceRegistry.CashCarryAdmission memory admission) = _entry();
        _admit(admission);
        (bytes memory traderSignature, bytes memory solverSignature) = _sign(execution, admission);
        return account.executePackage(
            execution, admission, traderSignature, solverSignature, _tradeArgs(-int128(int256(QUANTITY)), 4 ether)
        );
    }

    function _entry()
        private
        view
        returns (PackageVerifier.Execution memory execution, ResourceRegistry.CashCarryAdmission memory admission)
    {
        execution = _execution(verifier.ENTRY(), solver, 0);
        execution.expectedPostPerpSizeWad = -int128(int256(QUANTITY));
        execution.minimumPostPerpBalanceWad = int128(int256(MARGIN));
        execution.maximumPostPerpBalanceWad = int128(int256(MARGIN));
        execution.maximumPostPerpEntryNotionalWad = uint128(3 ether);
        admission = _admission(execution);
    }

    function _exit(bytes32 entryReceiptHash, address executionSolver)
        private
        view
        returns (PackageVerifier.Execution memory execution, ResourceRegistry.CashCarryAdmission memory admission)
    {
        execution = _execution(verifier.EXIT(), executionSolver, 1);
        execution.spotFillCommitment = keccak256("exit-spot-fill");
        execution.orderHash = keccak256("exit-order");
        execution.quoteHash = keccak256("exit-quote");
        execution.routeHash = EXIT_ROUTE_HASH;
        execution.spotQuoteBoundAtoms = 2 ether;
        execution.expectedPrePerpBalanceWad = int128(int256(MARGIN));
        execution.expectedPrePerpSizeWad = -int128(int256(QUANTITY));
        execution.expectedPrePerpEntryNotionalWad = uint128(2 ether);
        execution.expectedPostPerpSizeWad = 0;
        execution.minimumPostPerpBalanceWad = 0;
        execution.maximumPostPerpBalanceWad = 0;
        execution.maximumPostPerpEntryNotionalWad = 0;
        execution.entryReceiptHash = entryReceiptHash;
        admission = _admission(execution);
    }

    function _execution(uint8 action, address executionSolver, uint256 nonce)
        private
        view
        returns (PackageVerifier.Execution memory execution)
    {
        execution.domainIdHash = keccak256("eip155:31337");
        execution.domainManifestVersion = 1;
        execution.domainManifestHash = DOMAIN_MANIFEST_HASH;
        execution.orderHash = keccak256("entry-order");
        execution.quoteHash = keccak256("entry-quote");
        execution.routeHash = ROUTE_HASH;
        execution.spotFillCommitment = keccak256("entry-spot-fill");
        execution.packageQuoteIntentHash = bytes32(0);
        execution.seriesIdentityKey = SERIES_IDENTITY_KEY;
        execution.seriesBindingVersion = 1;
        execution.seriesBindingHash = SERIES_BINDING_HASH;
        execution.action = action;
        execution.strategyAccount = address(account);
        execution.solver = executionSolver;
        execution.spotPort = address(spotPort);
        execution.perpObserver = address(perp);
        execution.perpInstrument = address(perp);
        execution.perpExpiry = PERP_EXPIRY;
        execution.baseToken = address(base);
        execution.quoteToken = address(quote);
        execution.baseQuantityAtoms = QUANTITY;
        execution.perpQuantityWad = QUANTITY;
        execution.spotQuoteBoundAtoms = 3 ether;
        execution.packageNotionalQuoteAtoms = 2 ether;
        execution.packageSizeUnits = uint128(QUANTITY);
        execution.nonce = nonce;
        execution.deadline = block.timestamp + 1 hours;
    }

    function _admission(PackageVerifier.Execution memory execution)
        private
        view
        returns (ResourceRegistry.CashCarryAdmission memory admission)
    {
        admission.domain = ResourceRegistry.DomainRef({
            domainIdHash: execution.domainIdHash,
            manifestVersion: execution.domainManifestVersion,
            manifestHash: execution.domainManifestHash
        });
        admission.action = execution.action;
        admission.packageNotionalQuoteAtoms = execution.packageNotionalQuoteAtoms;
        admission.spot.adapter.localAddress = execution.spotPort;
        admission.perpetual.adapter.localAddress = address(verifier);
        admission.perpetual.venue.localAddress = address(perp);
        admission.perpetual.market.localAddress = address(perp);
        admission.baseAsset.localAddress = address(base);
        admission.quoteAsset.localAddress = address(quote);
        admission.baseAsset.manifest = ResourceRegistry.ManifestRef({
            subjectId: BASE_ASSET_ID, manifestVersion: 1, manifestHash: BASE_ASSET_MANIFEST_HASH
        });
        admission.quoteAsset.manifest = ResourceRegistry.ManifestRef({
            subjectId: QUOTE_ASSET_ID, manifestVersion: 1, manifestHash: QUOTE_ASSET_MANIFEST_HASH
        });
        admission.spot.quantityAtoms = QUANTITY;
        admission.perpetual.quantityAtoms = QUANTITY;
    }

    function _admit(ResourceRegistry.CashCarryAdmission memory admission) private {
        admissionRegistry.setExpectedAdmissionHash(keccak256(abi.encode(admission)));
    }

    function _sign(PackageVerifier.Execution memory execution, ResourceRegistry.CashCarryAdmission memory admission)
        private
        view
        returns (bytes memory traderSignature, bytes memory solverSignature)
    {
        traderSignature = _signature(ownerKey, verifier.traderPermitDigest(execution, admission));
        solverSignature = _signature(solverKey, verifier.solverAuthorizationDigest(execution, admission));
    }

    function _signature(uint256 key, bytes32 digest) private pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _tradeArgs(int128 sizeDelta, int128 balanceDelta) private view returns (bytes32[2] memory args) {
        args[0] = bytes32(uint256(block.timestamp + 1 hours) << 56 | uint256(PERP_EXPIRY));
        args[1] = bytes32(uint256(uint128(sizeDelta)) << 128 | uint256(uint128(balanceDelta)));
    }

    function _seriesBinding() private pure returns (CashCarrySeriesRegistry.CashCarrySeriesBindingV1 memory binding) {
        binding.bindingVersion = 1;
        binding.seriesManifestHash = SERIES_MANIFEST_HASH;
        binding.executionClassManifestHash = EXECUTION_CLASS_MANIFEST_HASH;
        binding.settlementClassIdentityHash = SETTLEMENT_CLASS_HASH;
        binding.baseAsset = CashCarrySeriesRegistry.SeriesManifestRef({
            subjectIdentity: BASE_ASSET_ID, manifestVersion: 1, manifestHash: BASE_ASSET_MANIFEST_HASH
        });
        binding.quoteAsset = CashCarrySeriesRegistry.SeriesManifestRef({
            subjectIdentity: QUOTE_ASSET_ID, manifestVersion: 1, manifestHash: QUOTE_ASSET_MANIFEST_HASH
        });
        binding.entrySide = 1;
        binding.spotBaseAtomsPerPackageUnit = 1;
        binding.perpQuantityAtomsPerPackageUnit = 1;
    }
}

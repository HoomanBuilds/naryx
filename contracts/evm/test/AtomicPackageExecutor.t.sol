// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {stdError} from "forge-std/StdError.sol";
import {ERC20} from "openzeppelin-contracts/token/ERC20/ERC20.sol";
import {ProtocolConfig} from "../src/ProtocolConfig.sol";
import {LocalCashCarryVenue} from "../src/LocalCashCarryVenue.sol";
import {AtomicPackageExecutor} from "../src/AtomicPackageExecutor.sol";

contract LocalToken is ERC20 {
    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

    function mint(address recipient, uint256 quantity) external {
        _mint(recipient, quantity);
    }
}

contract AtomicPackageExecutorTest is Test {
    bytes32 private constant MANIFEST_HASH = keccak256("local-domain-manifest");
    uint8 private constant ENTRY = 1;
    uint8 private constant EXIT = 2;
    address private constant PROPOSER = address(0x101);
    address private constant CANCELLER = address(0x102);
    address private constant GOVERNANCE_EXECUTOR = address(0x103);
    address private constant PAUSER = address(0x104);

    uint256 private traderKey = 0xA11CE;
    uint256 private solverKey = 0xB0B;
    address private trader;
    address private solver;
    address private recipient = address(0x555);

    LocalToken private base;
    LocalToken private quote;
    ProtocolConfig private config;
    LocalCashCarryVenue private venue;
    AtomicPackageExecutor private executor;

    function setUp() public {
        trader = vm.addr(traderKey);
        solver = vm.addr(solverKey);
        base = new LocalToken("Base", "BASE");
        quote = new LocalToken("Quote", "QUOTE");
        config =
            new ProtocolConfig("eip155:31337", 1, MANIFEST_HASH, 1, PROPOSER, CANCELLER, GOVERNANCE_EXECUTOR, PAUSER);

        address predictedExecutor = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        venue = new LocalCashCarryVenue(base, quote, predictedExecutor, 3, 2);
        executor = new AtomicPackageExecutor(config, venue, solver);
        assertEq(address(executor), predictedExecutor);

        base.mint(address(venue), 1_000);
        quote.mint(address(venue), 1_000);
        quote.mint(trader, 100);
        vm.prank(trader);
        quote.approve(address(executor), 100);
        _unpause();
    }

    function testEntryExactOutputAndAuthoritativeReceipt() public {
        AtomicPackageExecutor.Execution memory entry = _execution(ENTRY, 5, 9, 4);
        bytes32 receiptHash = _execute(entry);

        assertEq(base.balanceOf(address(executor)), 5);
        assertEq(quote.balanceOf(trader), 88);
        assertEq(quote.balanceOf(address(executor)), 0);
        (uint256 shortQuantity, uint256 shortCollateral) = venue.shortPositions(trader);
        assertEq(shortQuantity, 5);
        assertEq(shortCollateral, 4);
        (uint256 heldQuantity, uint256 heldCollateral, bytes32 entryReceiptHash) = executor.positions(trader);
        assertEq(heldQuantity, 5);
        assertEq(heldCollateral, 4);
        assertEq(entryReceiptHash, receiptHash);
        assertEq(executor.receipt(receiptHash).quoteAmount, 8);
        assertEq(executor.nextNonce(trader), 1);
    }

    function testExitReturnsSpotProceedsAndCollateralWhileEntryPaused() public {
        bytes32 entryReceiptHash = _execute(_execution(ENTRY, 5, 9, 4));
        vm.prank(PAUSER);
        config.pauseEntry();

        AtomicPackageExecutor.Execution memory blockedEntry = _execution(ENTRY, 1, 2, 1);
        blockedEntry.nonce = 1;
        (bytes memory traderSignature, bytes memory solverSignature) = _sign(blockedEntry);
        vm.expectRevert(AtomicPackageExecutor.EntryPaused.selector);
        executor.execute(blockedEntry, traderSignature, solverSignature);

        AtomicPackageExecutor.Execution memory exit = _execution(EXIT, 5, 7, 4);
        exit.nonce = 1;
        exit.entryReceiptHash = entryReceiptHash;
        bytes32 exitReceiptHash = _execute(exit);

        assertEq(base.balanceOf(address(executor)), 0);
        assertEq(quote.balanceOf(recipient), 11);
        assertEq(quote.balanceOf(address(executor)), 0);
        (uint256 shortQuantity, uint256 shortCollateral) = venue.shortPositions(trader);
        assertEq(shortQuantity, 0);
        assertEq(shortCollateral, 0);
        (uint256 heldQuantity,,) = executor.positions(trader);
        assertEq(heldQuantity, 0);
        AtomicPackageExecutor.Receipt memory receipt_ = executor.receipt(exitReceiptHash);
        assertEq(receipt_.quoteAmount, 7);
        assertEq(receipt_.entryReceiptHash, entryReceiptHash);
    }

    function testWrongTraderAndSolverSignaturesRevert() public {
        AtomicPackageExecutor.Execution memory entry = _execution(ENTRY, 5, 9, 4);
        bytes32 traderDigest = executor.traderPermitDigest(entry);
        bytes32 solverDigest = executor.solverAuthorizationDigest(entry);
        bytes memory wrongTrader = _signature(0xBAD, traderDigest);
        bytes memory correctTrader = _signature(traderKey, traderDigest);
        bytes memory wrongSolver = _signature(0xBAD, solverDigest);
        bytes memory correctSolver = _signature(solverKey, solverDigest);

        vm.expectRevert(AtomicPackageExecutor.InvalidTraderSignature.selector);
        executor.execute(entry, wrongTrader, correctSolver);
        vm.expectRevert(AtomicPackageExecutor.InvalidSolverSignature.selector);
        executor.execute(entry, correctTrader, wrongSolver);
        assertEq(executor.nextNonce(trader), 0);
    }

    function testFieldAndAccountSubstitutionReverts() public {
        AtomicPackageExecutor.Execution memory entry = _execution(ENTRY, 5, 9, 4);
        (bytes memory traderSignature, bytes memory solverSignature) = _sign(entry);

        entry.quoteHash = keccak256("other-quote");
        vm.expectRevert(AtomicPackageExecutor.InvalidTraderSignature.selector);
        executor.execute(entry, traderSignature, solverSignature);

        entry.quoteHash = keccak256("quote");
        entry.recipient = address(0x999);
        vm.expectRevert(AtomicPackageExecutor.InvalidTraderSignature.selector);
        executor.execute(entry, traderSignature, solverSignature);

        entry.recipient = recipient;
        entry.solver = address(0x999);
        vm.expectRevert(AtomicPackageExecutor.InvalidExecution.selector);
        executor.execute(entry, traderSignature, solverSignature);

        entry.solver = solver;
        entry.routeHash = keccak256("other-route");
        vm.expectRevert(AtomicPackageExecutor.InvalidTraderSignature.selector);
        executor.execute(entry, traderSignature, solverSignature);

        entry.routeHash = keccak256("route");
        entry.chainId = 84532;
        vm.expectRevert(AtomicPackageExecutor.InvalidExecution.selector);
        executor.execute(entry, traderSignature, solverSignature);
    }

    function testSolverAuthorizationBindsLimitsAndAccountsIndependently() public {
        AtomicPackageExecutor.Execution memory entry = _execution(ENTRY, 5, 9, 4);
        (, bytes memory solverSignature) = _sign(entry);

        entry.limitQuote = 8;
        bytes memory traderSignature = _signature(traderKey, executor.traderPermitDigest(entry));
        vm.expectRevert(AtomicPackageExecutor.InvalidSolverSignature.selector);
        executor.execute(entry, traderSignature, solverSignature);

        entry.limitQuote = 9;
        entry.recipient = address(0x777);
        traderSignature = _signature(traderKey, executor.traderPermitDigest(entry));
        vm.expectRevert(AtomicPackageExecutor.InvalidSolverSignature.selector);
        executor.execute(entry, traderSignature, solverSignature);
    }

    function testPositionCannotBeOverwrittenOrClosedWithAnotherReceipt() public {
        bytes32 entryReceiptHash = _execute(_execution(ENTRY, 5, 9, 4));
        AtomicPackageExecutor.Execution memory secondEntry = _execution(ENTRY, 5, 9, 4);
        secondEntry.nonce = 1;
        (bytes memory traderSignature, bytes memory solverSignature) = _sign(secondEntry);
        vm.expectRevert(AtomicPackageExecutor.PositionExists.selector);
        executor.execute(secondEntry, traderSignature, solverSignature);

        AtomicPackageExecutor.Execution memory exit = _execution(EXIT, 5, 7, 4);
        exit.nonce = 1;
        exit.entryReceiptHash = keccak256("unrelated-entry");
        (traderSignature, solverSignature) = _sign(exit);
        vm.expectRevert(AtomicPackageExecutor.PositionMismatch.selector);
        executor.execute(exit, traderSignature, solverSignature);
        (,, bytes32 recordedEntryReceiptHash) = executor.positions(trader);
        assertEq(recordedEntryReceiptHash, entryReceiptHash);
        assertEq(executor.nextNonce(trader), 1);
    }

    function testDeadlineReplayAndDomainChangeRevert() public {
        AtomicPackageExecutor.Execution memory entry = _execution(ENTRY, 5, 9, 4);
        entry.deadline = block.timestamp;
        (bytes memory traderSignature, bytes memory solverSignature) = _sign(entry);
        vm.warp(block.timestamp + 1);
        vm.expectRevert(AtomicPackageExecutor.Expired.selector);
        executor.execute(entry, traderSignature, solverSignature);

        entry.deadline = block.timestamp + 10;
        (traderSignature, solverSignature) = _sign(entry);
        executor.execute(entry, traderSignature, solverSignature);
        vm.expectRevert(AtomicPackageExecutor.InvalidNonce.selector);
        executor.execute(entry, traderSignature, solverSignature);

        AtomicPackageExecutor.Execution memory exit = _execution(EXIT, 5, 7, 4);
        exit.nonce = 1;
        (,, exit.entryReceiptHash) = executor.positions(trader);
        exit.domainManifestHash = keccak256("other-domain");
        (traderSignature, solverSignature) = _sign(exit);
        vm.expectRevert(AtomicPackageExecutor.DomainMismatch.selector);
        executor.execute(exit, traderSignature, solverSignature);
    }

    function testBuyCeilAndSellFloorEnforceBounds() public {
        AtomicPackageExecutor.Execution memory entry = _execution(ENTRY, 5, 7, 4);
        (bytes memory traderSignature, bytes memory solverSignature) = _sign(entry);
        vm.expectRevert(LocalCashCarryVenue.QuoteBoundExceeded.selector);
        executor.execute(entry, traderSignature, solverSignature);
        assertEq(quote.balanceOf(trader), 100);
        assertEq(executor.nextNonce(trader), 0);

        entry.limitQuote = 8;
        bytes32 entryReceiptHash = _execute(entry);
        AtomicPackageExecutor.Execution memory exit = _execution(EXIT, 5, 8, 4);
        exit.nonce = 1;
        exit.entryReceiptHash = entryReceiptHash;
        (traderSignature, solverSignature) = _sign(exit);
        vm.expectRevert(LocalCashCarryVenue.QuoteBoundExceeded.selector);
        executor.execute(exit, traderSignature, solverSignature);
        assertEq(base.balanceOf(address(executor)), 5);
        assertEq(executor.nextNonce(trader), 1);
    }

    function testForcedSecondLegFailureRollsBackEntryAndExit() public {
        AtomicPackageExecutor.Execution memory entry = _execution(ENTRY, 5, 9, 4);
        (bytes memory traderSignature, bytes memory solverSignature) = _sign(entry);
        vm.mockCallRevert(address(venue), abi.encodeWithSelector(venue.openShort.selector), "short unavailable");
        vm.expectRevert(bytes("short unavailable"));
        executor.execute(entry, traderSignature, solverSignature);
        vm.clearMockedCalls();

        assertEq(base.balanceOf(address(executor)), 0);
        assertEq(base.balanceOf(address(venue)), 1_000);
        assertEq(quote.balanceOf(trader), 100);
        assertEq(executor.nextNonce(trader), 0);

        bytes32 entryReceiptHash = _execute(entry);
        AtomicPackageExecutor.Execution memory exit = _execution(EXIT, 5, 7, 4);
        exit.nonce = 1;
        exit.entryReceiptHash = entryReceiptHash;
        (traderSignature, solverSignature) = _sign(exit);
        vm.mockCallRevert(address(venue), abi.encodeWithSelector(venue.closeShort.selector), "close unavailable");
        vm.expectRevert(bytes("close unavailable"));
        executor.execute(exit, traderSignature, solverSignature);
        vm.clearMockedCalls();

        assertEq(base.balanceOf(address(executor)), 5);
        assertEq(quote.balanceOf(recipient), 0);
        assertEq(executor.nextNonce(trader), 1);
        (uint256 shortQuantity,) = venue.shortPositions(trader);
        assertEq(shortQuantity, 5);
    }

    function testChainIdentityAndVenueCodeAreFixed() public {
        AtomicPackageExecutor.Execution memory entry = _execution(ENTRY, 5, 9, 4);
        (bytes memory traderSignature, bytes memory solverSignature) = _sign(entry);
        vm.chainId(8453);
        vm.expectRevert(AtomicPackageExecutor.InvalidConfiguration.selector);
        executor.execute(entry, traderSignature, solverSignature);
        vm.expectRevert(AtomicPackageExecutor.UnsupportedChain.selector);
        new AtomicPackageExecutor(config, venue, solver);
        vm.chainId(31337);

        vm.etch(address(venue), hex"00");
        vm.expectRevert(AtomicPackageExecutor.InvalidConfiguration.selector);
        executor.execute(entry, traderSignature, solverSignature);
    }

    function testFuzzAdverseSpotRounding(uint8 rawQuantity) public {
        uint256 quantity = bound(uint256(rawQuantity), 1, 50);
        uint256 ceiling = (quantity * 3 + 1) / 2;
        uint256 floor = (quantity * 3) / 2;
        bytes32 entryReceiptHash = _execute(_execution(ENTRY, quantity, ceiling, 1));
        AtomicPackageExecutor.Execution memory exit = _execution(EXIT, quantity, floor, 1);
        exit.nonce = 1;
        exit.entryReceiptHash = entryReceiptHash;
        _execute(exit);

        assertEq(executor.receipt(entryReceiptHash).quoteAmount, ceiling);
        assertEq(quote.balanceOf(recipient), floor + 1);
        assertGe(ceiling, floor);
        assertLe(ceiling - floor, 1);
    }

    function testOverflowAndZeroQuantityDoNotConsumeNonce() public {
        AtomicPackageExecutor.Execution memory entry = _execution(ENTRY, 5, type(uint256).max, 1);
        (bytes memory traderSignature, bytes memory solverSignature) = _sign(entry);
        vm.expectRevert(stdError.arithmeticError);
        executor.execute(entry, traderSignature, solverSignature);

        entry.quantity = 0;
        (traderSignature, solverSignature) = _sign(entry);
        vm.expectRevert(AtomicPackageExecutor.InvalidExecution.selector);
        executor.execute(entry, traderSignature, solverSignature);
        assertEq(executor.nextNonce(trader), 0);
    }

    function _execution(uint8 action, uint256 quantity, uint256 limitQuote, uint256 collateral)
        private
        view
        returns (AtomicPackageExecutor.Execution memory execution)
    {
        execution.domainIdHash = keccak256(bytes("eip155:31337"));
        execution.domainManifestVersion = 1;
        execution.domainManifestHash = MANIFEST_HASH;
        execution.orderHash = keccak256("order");
        execution.quoteHash = keccak256("quote");
        execution.routeHash = keccak256("route");
        execution.action = action;
        execution.quantity = quantity;
        execution.limitQuote = limitQuote;
        execution.collateral = collateral;
        execution.trader = trader;
        execution.recipient = recipient;
        execution.solver = solver;
        execution.venue = address(venue);
        execution.executor = address(executor);
        execution.chainId = block.chainid;
        execution.deadline = block.timestamp + 100;
    }

    function _execute(AtomicPackageExecutor.Execution memory execution) private returns (bytes32) {
        (bytes memory traderSignature, bytes memory solverSignature) = _sign(execution);
        return executor.execute(execution, traderSignature, solverSignature);
    }

    function _sign(AtomicPackageExecutor.Execution memory execution)
        private
        view
        returns (bytes memory traderSignature, bytes memory solverSignature)
    {
        traderSignature = _signature(traderKey, executor.traderPermitDigest(execution));
        solverSignature = _signature(solverKey, executor.solverAuthorizationDigest(execution));
    }

    function _signature(uint256 key, bytes32 digest) private pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _unpause() private {
        vm.prank(PROPOSER);
        config.scheduleUnpause();
        vm.warp(block.timestamp + 1);
        vm.prank(GOVERNANCE_EXECUTOR);
        config.activateUnpause();
    }
}

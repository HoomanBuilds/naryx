// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {stdError} from "forge-std/StdError.sol";
import {ERC20} from "openzeppelin-contracts/token/ERC20/ERC20.sol";
import {IERC1271} from "openzeppelin-contracts/interfaces/IERC1271.sol";
import {ECDSA} from "openzeppelin-contracts/utils/cryptography/ECDSA.sol";
import {ProtocolConfig} from "../src/ProtocolConfig.sol";
import {SolverRegistry} from "../src/SolverRegistry.sol";
import {LocalCashCarryVenue} from "../src/LocalCashCarryVenue.sol";
import {AtomicPackageExecutor} from "../src/AtomicPackageExecutor.sol";

contract LocalToken is ERC20 {
    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

    function mint(address recipient, uint256 quantity) external {
        _mint(recipient, quantity);
    }
}

contract Local1271Wallet is IERC1271 {
    address private immutable owner;

    constructor(address owner_) {
        owner = owner_;
    }

    function isValidSignature(bytes32 hash, bytes memory signature) external view returns (bytes4) {
        return ECDSA.recover(hash, signature) == owner ? IERC1271.isValidSignature.selector : bytes4(0xffffffff);
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
    uint256 private nextSolverKey = 0xC0C;
    address private trader;
    address private solver;
    address private nextSolver;
    address private recipient = address(0x555);

    LocalToken private base;
    LocalToken private quote;
    ProtocolConfig private config;
    SolverRegistry private solverRegistry;
    LocalCashCarryVenue private venue;
    AtomicPackageExecutor private executor;

    function setUp() public {
        trader = vm.addr(traderKey);
        solver = vm.addr(solverKey);
        nextSolver = vm.addr(nextSolverKey);
        base = new LocalToken("Base", "BASE");
        quote = new LocalToken("Quote", "QUOTE");
        config =
            new ProtocolConfig("eip155:31337", 1, MANIFEST_HASH, 1, PROPOSER, CANCELLER, GOVERNANCE_EXECUTOR, PAUSER);
        solverRegistry = new SolverRegistry(config, solver);

        address predictedExecutor = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        venue = new LocalCashCarryVenue(base, quote, predictedExecutor, 3, 2);
        executor = new AtomicPackageExecutor(config, solverRegistry, venue);
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
        AtomicPackageExecutor.Receipt memory receipt_ = executor.receipt(receiptHash);
        assertEq(receipt_.quoteAmount, 8);
        assertEq(receipt_.solver, solver);
        assertFalse(receipt_.recovery);
        assertEq(receipt_.nonce, 0);
        assertEq(receipt_.pre.executorBaseBalance, 0);
        assertEq(receipt_.post.executorBaseBalance, 5);
        assertEq(receipt_.pre.executorQuoteBalance, 0);
        assertEq(receipt_.post.executorQuoteBalance, 0);
        assertEq(receipt_.pre.shortQuantity, 0);
        assertEq(receipt_.post.shortQuantity, 5);
        assertEq(receipt_.pre.shortCollateral, 0);
        assertEq(receipt_.post.shortCollateral, 4);
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
        assertEq(receipt_.nonce, 1);
        assertEq(receipt_.pre.executorBaseBalance, 5);
        assertEq(receipt_.post.executorBaseBalance, 0);
        assertEq(receipt_.pre.executorQuoteBalance, 0);
        assertEq(receipt_.post.executorQuoteBalance, 0);
        assertEq(receipt_.pre.shortQuantity, 5);
        assertEq(receipt_.post.shortQuantity, 0);
        assertEq(receipt_.pre.shortCollateral, 4);
        assertEq(receipt_.post.shortCollateral, 0);
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

    function testErc1271TraderAcceptsOwnerSignatureAndRejectsWrongSignature() public {
        uint256 walletOwnerKey = 0x1271;
        Local1271Wallet wallet = new Local1271Wallet(vm.addr(walletOwnerKey));
        quote.mint(address(wallet), 100);
        vm.prank(address(wallet));
        quote.approve(address(executor), 100);

        AtomicPackageExecutor.Execution memory entry = _execution(ENTRY, 5, 9, 4);
        entry.trader = address(wallet);
        bytes memory solverSignature = _signature(solverKey, executor.solverAuthorizationDigest(entry));

        bytes memory invalidTraderSignature = _signature(0xBAD, executor.traderPermitDigest(entry));
        vm.expectRevert(AtomicPackageExecutor.InvalidTraderSignature.selector);
        executor.execute(entry, invalidTraderSignature, solverSignature);

        bytes memory traderSignature = _signature(walletOwnerKey, executor.traderPermitDigest(entry));
        executor.execute(entry, traderSignature, solverSignature);
        (uint256 quantity, uint256 collateral,) = executor.positions(address(wallet));
        assertEq(quantity, 5);
        assertEq(collateral, 4);
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
        vm.expectRevert(AtomicPackageExecutor.InvalidTraderSignature.selector);
        executor.execute(entry, traderSignature, solverSignature);

        entry.solver = solver;
        entry.routeHash = keccak256("other-route");
        vm.expectRevert(AtomicPackageExecutor.InvalidTraderSignature.selector);
        executor.execute(entry, traderSignature, solverSignature);

        entry.routeHash = keccak256("route");
        entry.chainId = 84532;
        (traderSignature, solverSignature) = _sign(entry);
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

    function testEveryActiveSolverSettlesOnlyWithItsOwnSignature() public {
        vm.prank(PROPOSER);
        solverRegistry.proposeSolver(nextSolver);
        vm.warp(block.timestamp + 1);
        vm.prank(GOVERNANCE_EXECUTOR);
        solverRegistry.activateSolver(nextSolver);
        assertEq(solverRegistry.activeSolverCount(), 2);

        bytes32 entryReceiptHash = _execute(_execution(ENTRY, 5, 9, 4));

        AtomicPackageExecutor.Execution memory exit = _execution(EXIT, 5, 7, 4);
        exit.nonce = 1;
        exit.entryReceiptHash = entryReceiptHash;
        exit.solver = nextSolver;
        bytes memory traderSignature = _signature(traderKey, executor.traderPermitDigest(exit));
        // One active solver cannot sign for another active solver's execution.
        bytes memory otherSolverSignature = _signature(solverKey, executor.solverAuthorizationDigest(exit));
        vm.expectRevert(AtomicPackageExecutor.InvalidSolverSignature.selector);
        executor.execute(exit, traderSignature, otherSolverSignature);

        executor.execute(exit, traderSignature, _signature(nextSolverKey, executor.solverAuthorizationDigest(exit)));
        assertEq(quote.balanceOf(recipient), 11);
    }

    function testSolverRotationChangesNormalAuthorizationAfterDelay() public {
        vm.prank(PROPOSER);
        solverRegistry.proposeSolver(nextSolver);

        bytes32 entryReceiptHash = _execute(_execution(ENTRY, 5, 9, 4));
        vm.warp(block.timestamp + 1);
        vm.prank(GOVERNANCE_EXECUTOR);
        solverRegistry.activateSolver(nextSolver);
        // Rotation is an addition followed by an immediate removal of the old solver.
        vm.prank(PAUSER);
        solverRegistry.removeSolver(solver);

        AtomicPackageExecutor.Execution memory exit = _execution(EXIT, 5, 7, 4);
        exit.nonce = 1;
        exit.entryReceiptHash = entryReceiptHash;
        (bytes memory traderSignature, bytes memory oldSolverSignature) = _sign(exit);
        vm.expectRevert(AtomicPackageExecutor.InvalidExecution.selector);
        executor.execute(exit, traderSignature, oldSolverSignature);

        exit.solver = nextSolver;
        traderSignature = _signature(traderKey, executor.traderPermitDigest(exit));
        bytes memory nextSolverSignature = _signature(nextSolverKey, executor.solverAuthorizationDigest(exit));
        executor.execute(exit, traderSignature, nextSolverSignature);
        assertEq(quote.balanceOf(recipient), 11);
    }

    function testTraderCanRecoverExitWithoutSolverAndAuthorizationRemainsBound() public {
        bytes32 entryReceiptHash = _execute(_execution(ENTRY, 5, 9, 4));
        AtomicPackageExecutor.Execution memory exit = _execution(EXIT, 5, 7, 4);
        exit.nonce = 1;
        exit.solver = address(0);
        exit.entryReceiptHash = entryReceiptHash;
        bytes memory traderSignature = _signature(traderKey, executor.traderPermitDigest(exit));

        vm.expectRevert(AtomicPackageExecutor.InvalidRecoveryExit.selector);
        executor.executeRecoveryExit(exit, traderSignature);

        AtomicPackageExecutor.Execution memory entryAttempt = _execution(ENTRY, 1, 2, 1);
        entryAttempt.nonce = 1;
        entryAttempt.solver = address(0);
        bytes memory entrySignature = _signature(traderKey, executor.traderPermitDigest(entryAttempt));
        vm.prank(trader);
        vm.expectRevert(AtomicPackageExecutor.InvalidRecoveryExit.selector);
        executor.executeRecoveryExit(entryAttempt, entrySignature);

        exit.recipient = address(0x777);
        vm.prank(trader);
        vm.expectRevert(AtomicPackageExecutor.InvalidTraderSignature.selector);
        executor.executeRecoveryExit(exit, traderSignature);

        exit.recipient = recipient;
        exit.limitQuote = 8;
        vm.prank(trader);
        vm.expectRevert(AtomicPackageExecutor.InvalidTraderSignature.selector);
        executor.executeRecoveryExit(exit, traderSignature);

        exit.limitQuote = 7;
        vm.prank(trader);
        bytes32 recoveryReceiptHash = executor.executeRecoveryExit(exit, traderSignature);
        assertEq(quote.balanceOf(recipient), 11);
        AtomicPackageExecutor.Receipt memory recoveryReceipt = executor.receipt(recoveryReceiptHash);
        assertEq(recoveryReceipt.solver, address(0));
        assertTrue(recoveryReceipt.recovery);

        vm.prank(trader);
        vm.expectRevert(AtomicPackageExecutor.InvalidNonce.selector);
        executor.executeRecoveryExit(exit, traderSignature);
    }

    function testDomainActivationInvalidatesOldSignatureButRecoveryUsesNewDomain() public {
        bytes32 entryReceiptHash = _execute(_execution(ENTRY, 5, 9, 4));
        AtomicPackageExecutor.Execution memory exit = _execution(EXIT, 5, 7, 4);
        exit.nonce = 1;
        exit.solver = address(0);
        exit.entryReceiptHash = entryReceiptHash;
        bytes memory oldDomainSignature = _signature(traderKey, executor.traderPermitDigest(exit));

        bytes32 nextManifestHash = keccak256("local-domain-manifest-2");
        vm.prank(PROPOSER);
        config.proposeDomain(2, nextManifestHash);
        vm.warp(block.timestamp + 1);
        vm.prank(GOVERNANCE_EXECUTOR);
        config.activateDomain();

        vm.prank(trader);
        vm.expectRevert(AtomicPackageExecutor.DomainMismatch.selector);
        executor.executeRecoveryExit(exit, oldDomainSignature);

        exit.domainManifestVersion = 2;
        exit.domainManifestHash = nextManifestHash;
        bytes memory activeDomainSignature = _signature(traderKey, executor.traderPermitDigest(exit));
        vm.prank(trader);
        executor.executeRecoveryExit(exit, activeDomainSignature);
        assertEq(quote.balanceOf(recipient), 11);
    }

    function testChainIdentityAndVenueCodeAreFixed() public {
        AtomicPackageExecutor.Execution memory entry = _execution(ENTRY, 5, 9, 4);
        (bytes memory traderSignature, bytes memory solverSignature) = _sign(entry);
        vm.chainId(8453);
        vm.expectRevert(AtomicPackageExecutor.InvalidConfiguration.selector);
        executor.execute(entry, traderSignature, solverSignature);

        LocalToken otherBase = new LocalToken("Other Base", "OBASE");
        LocalToken otherQuote = new LocalToken("Other Quote", "OQUOTE");
        ProtocolConfig otherConfig = new ProtocolConfig(
            "eip155:8453", 7, keccak256("base-domain"), 1, PROPOSER, CANCELLER, GOVERNANCE_EXECUTOR, PAUSER
        );
        SolverRegistry otherRegistry = new SolverRegistry(otherConfig, solver);
        address predictedExecutor = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        LocalCashCarryVenue otherVenue = new LocalCashCarryVenue(otherBase, otherQuote, predictedExecutor, 3, 2);
        AtomicPackageExecutor otherExecutor = new AtomicPackageExecutor(otherConfig, otherRegistry, otherVenue);
        assertEq(otherExecutor.deploymentChainId(), 8453);
        assertEq(otherExecutor.deploymentDomainIdHash(), keccak256(bytes("eip155:8453")));
        vm.chainId(31337);

        vm.expectRevert(AtomicPackageExecutor.InvalidConfiguration.selector);
        new AtomicPackageExecutor(ProtocolConfig(address(0xBEEF)), solverRegistry, venue);

        vm.etch(address(venue), hex"");
        vm.expectRevert(AtomicPackageExecutor.InvalidConfiguration.selector);
        executor.execute(entry, traderSignature, solverSignature);
        vm.expectRevert(AtomicPackageExecutor.InvalidConfiguration.selector);
        new AtomicPackageExecutor(config, solverRegistry, venue);
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

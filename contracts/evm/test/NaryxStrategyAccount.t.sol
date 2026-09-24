// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "openzeppelin-contracts/token/ERC20/ERC20.sol";
import {IERC20} from "openzeppelin-contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/token/ERC20/utils/SafeERC20.sol";
import {NaryxStrategyAccount} from "../src/NaryxStrategyAccount.sol";
import {PackageVerifier} from "../src/PackageVerifier.sol";
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

contract NaryxStrategyAccountTest is Test {
    uint32 private constant PERP_EXPIRY = type(uint32).max;
    uint256 private constant QUANTITY = 1 ether;
    uint256 private constant MARGIN = 4 ether;
    bytes32 private constant DOMAIN_MANIFEST_HASH = keccak256("domain-manifest");
    bytes32 private constant ROUTE_HASH = keccak256("route");
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
    PackageVerifier private verifier;
    StrategyAccountSpotPort private spotPort;
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
        verifier = new PackageVerifier(config, solverRegistry, ResourceRegistry(address(admissionRegistry)));
        spotPort = new StrategyAccountSpotPort(address(verifier), IERC20(address(base)), IERC20(address(quote)));
        account = new NaryxStrategyAccount(owner, verifier);

        base.mint(address(spotPort), 100 ether);
        quote.mint(address(spotPort), 200 ether);
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
        admission.spot.adapter.localAddress = address(spotPort);
        admission.perpetual.adapter.localAddress = address(verifier);
        admission.perpetual.venue.localAddress = address(perp);
        admission.perpetual.market.localAddress = address(perp);
        admission.baseAsset.localAddress = address(base);
        admission.quoteAsset.localAddress = address(quote);
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
}

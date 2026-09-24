// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "openzeppelin-contracts/token/ERC20/ERC20.sol";
import {IERC20} from "openzeppelin-contracts/token/ERC20/IERC20.sol";
import {DirectInventorySpotPort} from "../src/DirectInventorySpotPort.sol";
import {FirmInventoryReservationBook} from "../src/FirmInventoryReservationBook.sol";
import {ProtocolConfig} from "../src/ProtocolConfig.sol";
import {ISpotFillRecorder} from "../src/interfaces/ISpotFillRecorder.sol";

contract DirectInventoryToken is ERC20 {
    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

    function mint(address recipient, uint256 amount) external {
        _mint(recipient, amount);
    }
}

contract DirectSpotFillRecorder is ISpotFillRecorder {
    ProtocolConfig public immutable config;
    bool public reject;
    bytes32 public spotFillCommitment;
    bytes32 public orderHash;
    bytes32 public quoteHash;
    bytes32 public routeHash;
    address public strategyAccount;
    uint256 public packageNonce;
    uint8 public action;
    uint256 public baseAtoms;
    uint256 public quoteAtoms;

    constructor(ProtocolConfig config_) {
        config = config_;
    }

    function setReject(bool reject_) external {
        reject = reject_;
    }

    function recordSpotFill(
        address strategyAccount_,
        uint256 packageNonce_,
        bytes32 spotFillCommitment_,
        bytes32 orderHash_,
        bytes32 quoteHash_,
        bytes32 routeHash_,
        uint8 action_,
        address,
        address,
        uint256 baseAtoms_,
        uint256 quoteAtoms_
    ) external {
        require(!reject, "inactive verifier context");
        strategyAccount = strategyAccount_;
        packageNonce = packageNonce_;
        spotFillCommitment = spotFillCommitment_;
        orderHash = orderHash_;
        quoteHash = quoteHash_;
        routeHash = routeHash_;
        action = action_;
        baseAtoms = baseAtoms_;
        quoteAtoms = quoteAtoms_;
    }
}

contract DirectInventorySpotPortTest is Test {
    string private constant DOMAIN_ID = "eip155:8453";
    string private constant SOLVER_ID = "solver/base-alpha";
    uint32 private constant DOMAIN_VERSION = 1;
    bytes32 private constant DOMAIN_HASH = keccak256("base-domain-manifest");
    bytes32 private constant ORDER_HASH = keccak256("order");
    bytes32 private constant QUOTE_HASH = keccak256("quote");
    bytes32 private constant ROUTE_HASH = keccak256("route");
    uint64 private constant MAX_TTL = 1 days;
    uint256 private constant BASE_ATOMS = 1 ether;
    uint256 private constant QUOTE_ATOMS = 2_000e6;

    address private constant PROPOSER = address(0x101);
    address private constant CANCELLER = address(0x102);
    address private constant GOVERNANCE_EXECUTOR = address(0x103);
    address private constant PAUSER = address(0x104);
    address private constant RECLAIM_OWNER = address(0x105);

    address private solver;
    DirectInventoryToken private weth;
    DirectInventoryToken private usdc;
    ProtocolConfig private config;
    FirmInventoryReservationBook private book;
    DirectSpotFillRecorder private recorder;
    DirectInventorySpotPort private port;

    function setUp() public {
        vm.chainId(8453);
        solver = vm.addr(0xB0B);
        weth = new DirectInventoryToken("Wrapped Ether", "WETH");
        usdc = new DirectInventoryToken("USD Coin", "USDC");
        config = new ProtocolConfig(
            DOMAIN_ID, DOMAIN_VERSION, DOMAIN_HASH, 1, PROPOSER, CANCELLER, GOVERNANCE_EXECUTOR, PAUSER
        );
        book = new FirmInventoryReservationBook(config, weth, usdc, MAX_TTL, 5 ether, 5 ether);
        recorder = new DirectSpotFillRecorder(config);
        port = new DirectInventorySpotPort(_deployment());

        weth.mint(solver, 20 ether);
        usdc.mint(address(this), 20_000e6);
        vm.prank(solver);
        weth.approve(address(book), type(uint256).max);
        usdc.approve(address(book), type(uint256).max);
    }

    function testEntryConsumesCanonicalFinalizedReservation() public {
        bytes32 reservationId_ = _fundAndFinalize(7, 1, uint64(block.timestamp + 1 hours));
        assertEq(reservationId_, 0x6b710d8851e3fd6893d9e37cc584c3e3c08e5f284e7f14229165a5c579df30a1);

        uint256 quoteIn =
            port.buyExactOutput(7, reservationId_, ORDER_HASH, QUOTE_HASH, ROUTE_HASH, BASE_ATOMS, QUOTE_ATOMS);

        assertEq(quoteIn, QUOTE_ATOMS);
        assertEq(weth.balanceOf(address(this)), BASE_ATOMS);
        assertEq(usdc.balanceOf(address(this)), 20_000e6 - QUOTE_ATOMS);
        assertEq(usdc.balanceOf(solver), QUOTE_ATOMS);
        assertEq(recorder.spotFillCommitment(), reservationId_);
        assertEq(recorder.orderHash(), ORDER_HASH);
        assertEq(recorder.quoteHash(), QUOTE_HASH);
        assertEq(recorder.routeHash(), ROUTE_HASH);
        assertEq(recorder.strategyAccount(), address(this));
        assertEq(recorder.packageNonce(), 7);
        assertEq(recorder.action(), port.ENTRY());
        assertEq(recorder.baseAtoms(), BASE_ATOMS);
        assertEq(recorder.quoteAtoms(), QUOTE_ATOMS);
        assertEq(
            uint8(book.reservation(reservationId_).state), uint8(FirmInventoryReservationBook.ReservationState.CONSUMED)
        );
        assertEq(book.liveReservation(book.solverStrategyKey(solver, address(this))), bytes32(0));
        assertEq(book.reservedBaseAtoms(solver), 0);
    }

    function testExitDirectInventoryIsUnsupported() public {
        uint256 strategyBaseBefore = weth.balanceOf(address(this));
        uint256 strategyQuoteBefore = usdc.balanceOf(address(this));

        vm.expectRevert(DirectInventorySpotPort.UnsupportedAction.selector);
        port.sellExactInput(0, keccak256("reservation"), ORDER_HASH, QUOTE_HASH, ROUTE_HASH, BASE_ATOMS, QUOTE_ATOMS);

        assertEq(weth.balanceOf(address(this)), strategyBaseBefore);
        assertEq(usdc.balanceOf(address(this)), strategyQuoteBefore);
    }

    function testReplayAndExpiryReleaseFailClosed() public {
        bytes32 consumedId = _fundAndFinalize(1, 1, uint64(block.timestamp + 1 hours));
        port.buyExactOutput(1, consumedId, ORDER_HASH, QUOTE_HASH, ROUTE_HASH, BASE_ATOMS, QUOTE_ATOMS);
        vm.expectRevert(DirectInventorySpotPort.ReservationMismatch.selector);
        port.buyExactOutput(1, consumedId, ORDER_HASH, QUOTE_HASH, ROUTE_HASH, BASE_ATOMS, QUOTE_ATOMS);

        vm.prank(solver);
        vm.expectRevert(FirmInventoryReservationBook.InvalidReservation.selector);
        book.reserve(_terms(2, 2, uint64(block.timestamp + MAX_TTL + 1)));

        bytes32 expiringId = _fund(2, 2, uint64(block.timestamp + 1 hours));
        vm.expectRevert(DirectInventorySpotPort.ReservationMismatch.selector);
        port.buyExactOutput(2, expiringId, ORDER_HASH, QUOTE_HASH, ROUTE_HASH, BASE_ATOMS, QUOTE_ATOMS);

        uint256 reclaimBefore = weth.balanceOf(RECLAIM_OWNER);
        vm.warp(block.timestamp + 1 hours);
        vm.prank(address(0xBEEF));
        book.releaseExpired(expiringId);
        assertEq(weth.balanceOf(RECLAIM_OWNER), reclaimBefore + BASE_ATOMS);
        assertEq(
            uint8(book.reservation(expiringId).state), uint8(FirmInventoryReservationBook.ReservationState.RELEASED)
        );
        assertEq(book.liveReservation(book.solverStrategyKey(solver, address(this))), bytes32(0));
    }

    function testMismatchAndRecorderRejectionRollBackReservation() public {
        bytes32 reservationId_ = _fundAndFinalize(9, 1, uint64(block.timestamp + 1 hours));
        vm.prank(solver);
        vm.expectRevert(FirmInventoryReservationBook.ReservationAlreadyExists.selector);
        book.reserve(_terms(10, 2, uint64(block.timestamp + 1 hours)));
        FirmInventoryReservationBook.ReservationTerms memory overCapacity =
            _terms(10, 2, uint64(block.timestamp + 1 hours));
        overCapacity.strategyAccount = address(recorder);
        overCapacity.baseAtoms = 5 ether;
        vm.prank(solver);
        vm.expectRevert(FirmInventoryReservationBook.CapacityExceeded.selector);
        book.reserve(overCapacity);

        vm.expectRevert(DirectInventorySpotPort.ReservationMismatch.selector);
        port.buyExactOutput(
            9, reservationId_, ORDER_HASH, QUOTE_HASH, keccak256("wrong-route"), BASE_ATOMS, QUOTE_ATOMS
        );
        assertEq(
            uint8(book.reservation(reservationId_).state), uint8(FirmInventoryReservationBook.ReservationState.LIVE)
        );

        uint256 strategyBaseBefore = weth.balanceOf(address(this));
        uint256 strategyQuoteBefore = usdc.balanceOf(address(this));
        uint256 solverQuoteBefore = usdc.balanceOf(solver);
        recorder.setReject(true);
        vm.expectRevert(bytes("inactive verifier context"));
        port.buyExactOutput(9, reservationId_, ORDER_HASH, QUOTE_HASH, ROUTE_HASH, BASE_ATOMS, QUOTE_ATOMS);

        assertEq(weth.balanceOf(address(this)), strategyBaseBefore);
        assertEq(usdc.balanceOf(address(this)), strategyQuoteBefore);
        assertEq(usdc.balanceOf(solver), solverQuoteBefore);
        assertEq(
            uint8(book.reservation(reservationId_).state), uint8(FirmInventoryReservationBook.ReservationState.LIVE)
        );
        assertEq(book.liveReservation(book.solverStrategyKey(solver, address(this))), reservationId_);
        assertEq(book.reservedBaseAtoms(solver), BASE_ATOMS);
    }

    function _fundAndFinalize(uint256 packageNonce, uint256 reservationNonce, uint64 expiry)
        private
        returns (bytes32 reservationId_)
    {
        reservationId_ = _fund(packageNonce, reservationNonce, expiry);
        vm.prank(solver);
        book.finalizeReservation(reservationId_, QUOTE_HASH, ROUTE_HASH);
    }

    function _fund(uint256 packageNonce, uint256 reservationNonce, uint64 expiry)
        private
        returns (bytes32 reservationId_)
    {
        vm.prank(solver);
        reservationId_ = book.reserve(_terms(packageNonce, reservationNonce, expiry));
    }

    function _terms(uint256 packageNonce, uint256 reservationNonce, uint64 expiry)
        private
        view
        returns (FirmInventoryReservationBook.ReservationTerms memory)
    {
        return FirmInventoryReservationBook.ReservationTerms({
            domain: FirmInventoryReservationBook.DomainRef({
                domainIdHash: keccak256(bytes(DOMAIN_ID)), manifestVersion: DOMAIN_VERSION, manifestHash: DOMAIN_HASH
            }),
            solverId: SOLVER_ID,
            solver: solver,
            reclaimOwner: RECLAIM_OWNER,
            strategyAccount: address(this),
            packageNonce: packageNonce,
            orderHash: ORDER_HASH,
            reservationNonce: reservationNonce,
            baseAtoms: BASE_ATOMS,
            quoteAtoms: QUOTE_ATOMS,
            expiry: expiry,
            consumer: address(port),
            consumerCodeHash: address(port).codehash
        });
    }

    function _deployment() private view returns (DirectInventorySpotPort.Deployment memory) {
        return DirectInventorySpotPort.Deployment({
            chainId: block.chainid,
            config: config,
            verifier: address(recorder),
            reservationBook: book,
            baseToken: IERC20(address(weth)),
            quoteToken: IERC20(address(usdc)),
            domainIdHash: keccak256(bytes(DOMAIN_ID)),
            domainManifestVersion: DOMAIN_VERSION,
            domainManifestHash: DOMAIN_HASH,
            configCodeHash: address(config).codehash,
            verifierCodeHash: address(recorder).codehash,
            reservationBookCodeHash: address(book).codehash,
            baseTokenCodeHash: address(weth).codehash,
            quoteTokenCodeHash: address(usdc).codehash
        });
    }
}

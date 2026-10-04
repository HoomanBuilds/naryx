// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "openzeppelin-contracts/token/ERC20/ERC20.sol";
import {ECDSA} from "openzeppelin-contracts/utils/cryptography/ECDSA.sol";
import {IERC1271} from "openzeppelin-contracts/interfaces/IERC1271.sol";
import {ProtocolConfig} from "../src/ProtocolConfig.sol";
import {AsyncBondedPackageCoordinator} from "../src/AsyncBondedPackageCoordinator.sol";
import {IAsyncVenueAdapter} from "../src/interfaces/IAsyncVenueAdapter.sol";
import {Eip7702Delegate, RevertingSignatureOwner, WrongMagicSignatureOwner} from "./OwnerSignature.t.sol";

contract AsyncBondToken is ERC20 {
    constructor() ERC20("Bond", "BOND") {}

    function mint(address recipient, uint256 amount) external {
        _mint(recipient, amount);
    }
}

contract AsyncVenueMock is IAsyncVenueAdapter {
    bytes32 public nextKey = keccak256("request-key");
    uint256 public createCount;
    uint256 public recoveryCount;

    function setKey(bytes32 key) external {
        nextKey = key;
    }

    function createRequest(bytes32, VenueRequest calldata) external returns (bytes32) {
        createCount++;
        return nextKey;
    }

    function requestRecovery(bytes32, bytes32, RecoveryAction) external returns (bool) {
        recoveryCount++;
        return true;
    }
}

contract AsyncHandlerMock {
    function report(
        AsyncBondedPackageCoordinator coordinator,
        bytes32 id,
        uint64 version,
        AsyncBondedPackageCoordinator.VenueEvidence calldata evidence
    ) external {
        coordinator.recordVenueEvidence(id, version, evidence);
    }
}

contract AsyncOwner1271 is IERC1271 {
    address public immutable signer;

    constructor(address signer_) {
        signer = signer_;
    }

    function isValidSignature(bytes32 hash, bytes memory signature) external view returns (bytes4) {
        return ECDSA.recover(hash, signature) == signer ? IERC1271.isValidSignature.selector : bytes4(0xffffffff);
    }
}

contract AsyncBondedPackageCoordinatorTest is Test {
    uint256 private constant OWNER_KEY = 0x12345;
    address private constant PROPOSER = address(0xA1);
    address private constant CANCELLER = address(0xA2);
    address private constant EXECUTOR = address(0xA3);
    address private constant PAUSER = address(0xA4);
    address private constant SOLVER = address(0xB1);
    address private constant BOND_RECIPIENT = address(0xB2);
    address private constant RESERVE_RECIPIENT = address(0xB3);
    address private constant SLASH_RECIPIENT = address(0xB4);
    bytes32 private constant DOMAIN_HASH = keccak256("eip155:421614");
    bytes32 private constant MANIFEST_HASH = keccak256("domain-manifest");
    bytes32 private constant CLASS_HASH = keccak256("async-class-manifest");

    ProtocolConfig private config;
    AsyncBondToken private token;
    AsyncVenueMock private adapter;
    AsyncHandlerMock private handler;
    AsyncBondedPackageCoordinator private coordinator;
    address private owner;

    function setUp() public {
        vm.warp(1000);
        owner = vm.addr(OWNER_KEY);
        config = new ProtocolConfig("eip155:421614", 1, MANIFEST_HASH, 10, PROPOSER, CANCELLER, EXECUTOR, PAUSER);
        token = new AsyncBondToken();
        adapter = new AsyncVenueMock();
        handler = new AsyncHandlerMock();
        coordinator = new AsyncBondedPackageCoordinator(config, token, CLASS_HASH);
        vm.prank(PROPOSER);
        coordinator.proposeAdmission(
            address(adapter), address(handler), address(adapter).codehash, address(handler).codehash
        );
        vm.warp(1010);
        vm.prank(EXECUTOR);
        coordinator.activateAdmission(address(adapter));
        vm.prank(PROPOSER);
        config.scheduleUnpause();
        vm.warp(1020);
        vm.prank(EXECUTOR);
        config.activateUnpause();
        token.mint(SOLVER, 100_000);
        vm.prank(SOLVER);
        token.approve(address(coordinator), type(uint256).max);
    }

    function testHappyLifecycleAndWithdrawalLock() public {
        IAsyncVenueAdapter.VenueRequest memory request = _request();
        AsyncBondedPackageCoordinator.Terms memory terms = _terms(owner, request);
        bytes32 id = _reserve(terms);
        vm.expectRevert(AsyncBondedPackageCoordinator.ReleaseLocked.selector);
        coordinator.close(id, 1);
        _submit(id, request);
        coordinator.markVenuePending(id, 2);
        _report(id, 3, AsyncBondedPackageCoordinator.Outcome.EXECUTED, keccak256("filled"));
        coordinator.close(id, 4);
        assertEq(token.balanceOf(BOND_RECIPIENT), terms.bondAtoms);
        assertEq(token.balanceOf(RESERVE_RECIPIENT), terms.recoveryReserveAtoms);
        assertEq(uint8(coordinator.packageState(id).state), uint8(AsyncBondedPackageCoordinator.State.CLOSED));
    }

    function testExecutionClassActivationIsDelayedPauseGatedAndNonReusable() public {
        ProtocolConfig pendingConfig =
            new ProtocolConfig("eip155:421614", 1, MANIFEST_HASH, 10, PROPOSER, CANCELLER, EXECUTOR, PAUSER);
        AsyncBondedPackageCoordinator pendingCoordinator =
            new AsyncBondedPackageCoordinator(pendingConfig, token, bytes32(0));

        vm.prank(PROPOSER);
        pendingCoordinator.proposeExecutionClass(CLASS_HASH);
        vm.prank(EXECUTOR);
        vm.expectRevert(
            abi.encodeWithSelector(
                AsyncBondedPackageCoordinator.ExecutionClassProposalNotReady.selector, uint64(block.timestamp + 10)
            )
        );
        pendingCoordinator.activateExecutionClass();

        vm.warp(block.timestamp + 10);
        vm.prank(EXECUTOR);
        pendingCoordinator.activateExecutionClass();
        assertEq(pendingCoordinator.executionClassManifestHash(), CLASS_HASH);

        vm.prank(PROPOSER);
        vm.expectRevert(
            abi.encodeWithSelector(AsyncBondedPackageCoordinator.ExecutionClassManifestHashUsed.selector, CLASS_HASH)
        );
        pendingCoordinator.proposeExecutionClass(CLASS_HASH);

        vm.prank(PROPOSER);
        pendingConfig.scheduleUnpause();
        vm.warp(block.timestamp + 10);
        vm.prank(EXECUTOR);
        pendingConfig.activateUnpause();
        vm.prank(PROPOSER);
        vm.expectRevert(AsyncBondedPackageCoordinator.InvalidConfiguration.selector);
        pendingCoordinator.proposeExecutionClass(keccak256("next-execution-class"));
    }

    function testReplayInvalidSignatureAndDomainRotation() public {
        IAsyncVenueAdapter.VenueRequest memory request = _request();
        AsyncBondedPackageCoordinator.Terms memory terms = _terms(owner, request);
        bytes memory signature = _sign(terms);
        terms.routeHash = keccak256("mutated-route");
        bytes memory mutatedSignature = _sign(terms);
        vm.prank(SOLVER);
        vm.expectRevert(AsyncBondedPackageCoordinator.InvalidSignature.selector);
        coordinator.reserve(terms, signature);
        terms = _terms(owner, request);
        _reserve(terms);
        vm.prank(SOLVER);
        vm.expectRevert(AsyncBondedPackageCoordinator.InvalidNonce.selector);
        coordinator.reserve(terms, mutatedSignature);
        vm.prank(PROPOSER);
        config.proposeDomain(2, keccak256("rotated"));
        vm.warp(block.timestamp + 10);
        vm.prank(EXECUTOR);
        config.activateDomain();
        terms.nonce = 1;
        terms.reservationHash = coordinator.reservationCommitment(terms);
        bytes memory rotatedSignature = _sign(terms);
        vm.prank(SOLVER);
        vm.expectRevert(AsyncBondedPackageCoordinator.DomainMismatch.selector);
        coordinator.reserve(terms, rotatedSignature);
    }

    function testERC1271OwnerAndDeadlineBoundaries() public {
        AsyncOwner1271 wallet = new AsyncOwner1271(owner);
        IAsyncVenueAdapter.VenueRequest memory request = _request();
        AsyncBondedPackageCoordinator.Terms memory terms = _terms(address(wallet), request);
        bytes32 id = _reserve(terms);
        vm.warp(terms.submissionDeadline);
        vm.prank(SOLVER);
        vm.expectRevert(AsyncBondedPackageCoordinator.DeadlinePassed.selector);
        coordinator.submitRequest(id, 1, request);
        vm.expectRevert(AsyncBondedPackageCoordinator.DeadlineNotReached.selector);
        coordinator.slashMissedSubmission(id, 1);
        vm.warp(terms.submissionDeadline + 1);
        coordinator.slashMissedSubmission(id, 1);
        coordinator.close(id, 2);
        assertEq(token.balanceOf(SLASH_RECIPIENT), terms.bondAtoms);
        assertEq(token.balanceOf(RESERVE_RECIPIENT), terms.recoveryReserveAtoms);
    }

    function testDelegatedEoaOwnerReservesWithItsOwnSignature() public {
        AsyncBondedPackageCoordinator.Terms memory terms = _terms(owner, _request());
        bytes memory signature = _sign(terms);
        vm.signAndAttachDelegation(address(new Eip7702Delegate()), OWNER_KEY);
        vm.prank(SOLVER);
        bytes32 id = coordinator.reserve(terms, signature);
        assertGt(owner.code.length, 0);
        assertEq(uint8(coordinator.packageState(id).state), uint8(AsyncBondedPackageCoordinator.State.RESERVED));
        assertEq(coordinator.nextNonce(owner), 1);
    }

    function testContractOwnerWithWrongMagicOrRevertIsRejected() public {
        address[2] memory rejecting = [address(new WrongMagicSignatureOwner()), address(new RevertingSignatureOwner())];
        for (uint256 i; i < rejecting.length; ++i) {
            AsyncBondedPackageCoordinator.Terms memory terms = _terms(rejecting[i], _request());
            bytes memory signature = _sign(terms);
            vm.prank(SOLVER);
            vm.expectRevert(AsyncBondedPackageCoordinator.InvalidSignature.selector);
            coordinator.reserve(terms, signature);
        }
    }

    function testAdmissionAndCodeIdentityFailClosed() public {
        IAsyncVenueAdapter.VenueRequest memory request = _request();
        AsyncBondedPackageCoordinator.Terms memory terms = _terms(owner, request);
        terms.handlerCodeHash = bytes32(uint256(1));
        bytes memory badSignature = _sign(terms);
        vm.prank(SOLVER);
        vm.expectRevert(AsyncBondedPackageCoordinator.InvalidAdmission.selector);
        coordinator.reserve(terms, badSignature);
        terms = _terms(owner, request);
        bytes32 id = _reserve(terms);
        vm.etch(address(adapter), hex"00");
        vm.prank(SOLVER);
        vm.expectRevert(AsyncBondedPackageCoordinator.InvalidAdmission.selector);
        coordinator.submitRequest(id, 1, request);
    }

    function testCombinedAdapterAndHandlerAdmission() public {
        AsyncVenueMock combined = new AsyncVenueMock();
        bytes32 codeHash = address(combined).codehash;
        vm.prank(PROPOSER);
        coordinator.proposeAdmission(address(combined), address(combined), codeHash, codeHash);
        vm.warp(block.timestamp + 10);
        vm.prank(EXECUTOR);
        coordinator.activateAdmission(address(combined));
        (address admittedHandler, bytes32 adapterHash, bytes32 handlerHash, bool active,) =
            coordinator.admissions(address(combined));
        assertEq(admittedHandler, address(combined));
        assertEq(adapterHash, codeHash);
        assertEq(handlerHash, codeHash);
        assertTrue(active);
    }

    function testRequestKeyCallbackAndVersionBinding() public {
        IAsyncVenueAdapter.VenueRequest memory request = _request();
        bytes32 id = _reserve(_terms(owner, request));
        _submit(id, request);
        AsyncBondedPackageCoordinator.VenueEvidence memory evidence =
            _evidence(bytes32(uint256(1)), AsyncBondedPackageCoordinator.Outcome.EXECUTED, keccak256("filled"));
        vm.expectRevert(AsyncBondedPackageCoordinator.InvalidEvidence.selector);
        handler.report(coordinator, id, 2, evidence);
        evidence.requestKey = adapter.nextKey();
        vm.expectRevert(AsyncBondedPackageCoordinator.InvalidEvidence.selector);
        coordinator.recordVenueEvidence(id, 2, evidence);
        vm.expectRevert(AsyncBondedPackageCoordinator.WrongVersion.selector);
        handler.report(coordinator, id, 1, evidence);
        handler.report(coordinator, id, 2, evidence);
        assertEq(uint8(coordinator.packageState(id).state), uint8(AsyncBondedPackageCoordinator.State.EXECUTED));
    }

    function testLateExecutionPrecedesRecovery() public {
        IAsyncVenueAdapter.VenueRequest memory request = _request();
        bytes32 id = _reserve(_terms(owner, request));
        _submit(id, request);
        coordinator.markVenuePending(id, 2);
        _report(id, 3, AsyncBondedPackageCoordinator.Outcome.FROZEN, keccak256("frozen"));
        coordinator.beginRecovery(id, 4);
        _report(id, 5, AsyncBondedPackageCoordinator.Outcome.EXECUTED, keccak256("late-fill"));
        coordinator.close(id, 6);
        assertEq(token.balanceOf(BOND_RECIPIENT), 100);
    }

    function testFreezeRecoveryAndObjectiveSlash() public {
        IAsyncVenueAdapter.VenueRequest memory request = _request();
        AsyncBondedPackageCoordinator.Terms memory terms = _terms(owner, request);
        bytes32 id = _reserve(terms);
        _submit(id, request);
        _report(id, 2, AsyncBondedPackageCoordinator.Outcome.FROZEN, keccak256("frozen"));
        _report(id, 3, AsyncBondedPackageCoordinator.Outcome.FROZEN, keccak256("frozen"));
        assertEq(coordinator.packageState(id).stateVersion, 3);
        coordinator.beginRecovery(id, 3);
        vm.warp(terms.recoveryDeadline);
        vm.expectRevert(AsyncBondedPackageCoordinator.DeadlineNotReached.selector);
        coordinator.slashMissedRecovery(id, 4);
        vm.warp(terms.recoveryDeadline + 1);
        coordinator.slashMissedRecovery(id, 4);
        vm.expectRevert(AsyncBondedPackageCoordinator.ReleaseLocked.selector);
        coordinator.close(id, 5);
        _report(id, 5, AsyncBondedPackageCoordinator.Outcome.EXECUTED, keccak256("late-fill"));
        coordinator.close(id, 6);
        assertEq(token.balanceOf(SLASH_RECIPIENT), terms.bondAtoms);
    }

    function testCancelRecoveryAndConflictingEvidenceHold() public {
        IAsyncVenueAdapter.VenueRequest memory request = _request();
        bytes32 id = _reserve(_terms(owner, request));
        _submit(id, request);
        _report(id, 2, AsyncBondedPackageCoordinator.Outcome.CANCELLED, keccak256("cancelled"));
        coordinator.beginRecovery(id, 3);
        coordinator.submitRecovery(id, 4);
        _report(id, 5, AsyncBondedPackageCoordinator.Outcome.RECOVERED, keccak256("recovered"));
        _report(id, 6, AsyncBondedPackageCoordinator.Outcome.EXECUTED, keccak256("conflict"));
        vm.expectRevert(AsyncBondedPackageCoordinator.ReleaseLocked.selector);
        coordinator.close(id, 7);
    }

    function testDuplicateVenueKeyRejectedAcrossPackages() public {
        IAsyncVenueAdapter.VenueRequest memory request = _request();
        bytes32 first = _reserve(_terms(owner, request));
        _submit(first, request);
        AsyncBondedPackageCoordinator.Terms memory secondTerms = _terms(owner, request);
        secondTerms.nonce = 1;
        secondTerms.reservationHash = coordinator.reservationCommitment(secondTerms);
        bytes32 second = _reserve(secondTerms);
        vm.prank(SOLVER);
        vm.expectRevert(AsyncBondedPackageCoordinator.InvalidRequest.selector);
        coordinator.submitRequest(second, 1, request);
    }

    function testDuplicateEvidenceIsIdempotentAndLossUsesReserve() public {
        IAsyncVenueAdapter.VenueRequest memory request = _request();
        bytes32 id = _reserve(_terms(owner, request));
        _submit(id, request);
        AsyncBondedPackageCoordinator.VenueEvidence memory evidence =
            _evidence(adapter.nextKey(), AsyncBondedPackageCoordinator.Outcome.EXECUTED, keccak256("filled"));
        evidence.observedLossAtoms = 10;
        handler.report(coordinator, id, 2, evidence);
        handler.report(coordinator, id, 3, evidence);
        assertEq(coordinator.packageState(id).stateVersion, 3);
        coordinator.close(id, 3);
        assertEq(token.balanceOf(owner), 10);
        assertEq(token.balanceOf(RESERVE_RECIPIENT), 15);
    }

    function testOverboundEvidenceCannotClose() public {
        IAsyncVenueAdapter.VenueRequest memory request = _request();
        bytes32 id = _reserve(_terms(owner, request));
        _submit(id, request);
        AsyncBondedPackageCoordinator.VenueEvidence memory evidence =
            _evidence(adapter.nextKey(), AsyncBondedPackageCoordinator.Outcome.EXECUTED, keccak256("too-much-loss"));
        evidence.observedLossAtoms = 26;
        handler.report(coordinator, id, 2, evidence);
        assertEq(
            uint8(coordinator.packageState(id).state), uint8(AsyncBondedPackageCoordinator.State.MANUAL_INTERVENTION)
        );
        vm.expectRevert(AsyncBondedPackageCoordinator.ReleaseLocked.selector);
        coordinator.close(id, 3);
        vm.warp(request.recoveryDeadline);
        vm.prank(owner);
        vm.expectRevert(AsyncBondedPackageCoordinator.WrongState.selector);
        coordinator.submitOverdueRecovery(id, 3);
    }

    function testOverdueRecoveryOpensOnlyAtRecoveryDeadlineForOwnerOrSolver() public {
        IAsyncVenueAdapter.VenueRequest memory request = _request();
        AsyncBondedPackageCoordinator.Terms memory terms = _terms(owner, request);
        bytes32 id = _reserve(terms);
        _submit(id, request);
        coordinator.markVenuePending(id, 2);
        vm.warp(terms.venueDeadline + 1);
        coordinator.beginRecovery(id, 3);
        vm.warp(terms.recoveryDeadline - 1);
        vm.prank(owner);
        vm.expectRevert(AsyncBondedPackageCoordinator.DeadlineNotReached.selector);
        coordinator.submitOverdueRecovery(id, 4);
        vm.warp(terms.recoveryDeadline);
        vm.expectRevert(AsyncBondedPackageCoordinator.DeadlinePassed.selector);
        coordinator.submitRecovery(id, 4);
        vm.prank(BOND_RECIPIENT);
        vm.expectRevert(AsyncBondedPackageCoordinator.UnauthorizedActor.selector);
        coordinator.submitOverdueRecovery(id, 4);
        vm.prank(SOLVER);
        coordinator.submitOverdueRecovery(id, 4);
        assertEq(adapter.recoveryCount(), 1);
        vm.prank(owner);
        vm.expectRevert(AsyncBondedPackageCoordinator.WrongState.selector);
        coordinator.submitOverdueRecovery(id, 5);
        _report(id, 5, AsyncBondedPackageCoordinator.Outcome.RECOVERED, keccak256("late-recovered"));
        coordinator.close(id, 6);
        assertEq(token.balanceOf(BOND_RECIPIENT), terms.bondAtoms);
        assertEq(token.balanceOf(RESERVE_RECIPIENT), terms.recoveryReserveAtoms);
        assertEq(token.balanceOf(SLASH_RECIPIENT), 0);
        assertEq(token.balanceOf(address(coordinator)), 0);
    }

    function testOverdueRecoveryAfterMissedDutyPaysTheSlash() public {
        IAsyncVenueAdapter.VenueRequest memory request = _request();
        AsyncBondedPackageCoordinator.Terms memory terms = _terms(owner, request);
        bytes32 id = _reserve(terms);
        _submit(id, request);
        _report(id, 2, AsyncBondedPackageCoordinator.Outcome.CANCELLED, keccak256("cancelled"));
        coordinator.beginRecovery(id, 3);
        vm.warp(terms.recoveryDeadline + 1);
        vm.prank(SOLVER);
        vm.expectRevert(AsyncBondedPackageCoordinator.WrongState.selector);
        coordinator.submitOverdueRecovery(id, 4);
        coordinator.slashMissedRecovery(id, 4);
        vm.expectRevert(AsyncBondedPackageCoordinator.ReleaseLocked.selector);
        coordinator.close(id, 5);
        vm.prank(owner);
        coordinator.submitOverdueRecovery(id, 5);
        vm.expectRevert(AsyncBondedPackageCoordinator.WrongState.selector);
        coordinator.slashMissedRecovery(id, 6);
        _report(id, 6, AsyncBondedPackageCoordinator.Outcome.RECOVERED, keccak256("late-recovered"));
        coordinator.close(id, 7);
        assertEq(token.balanceOf(SLASH_RECIPIENT), terms.bondAtoms);
        assertEq(token.balanceOf(RESERVE_RECIPIENT), terms.recoveryReserveAtoms);
        assertEq(token.balanceOf(BOND_RECIPIENT), 0);
        assertEq(token.balanceOf(address(coordinator)), 0);
    }

    function testRecoveryDeadlineMissDoesNotCreateSlashDuty() public {
        IAsyncVenueAdapter.VenueRequest memory request = _request();
        AsyncBondedPackageCoordinator.Terms memory terms = _terms(owner, request);
        bytes32 id = _reserve(terms);
        _submit(id, request);
        _report(id, 2, AsyncBondedPackageCoordinator.Outcome.FROZEN, keccak256("frozen"));
        vm.warp(terms.recoveryDeadline);
        coordinator.beginRecovery(id, 3);
        assertEq(
            uint8(coordinator.packageState(id).state), uint8(AsyncBondedPackageCoordinator.State.MANUAL_INTERVENTION)
        );
        vm.expectRevert(AsyncBondedPackageCoordinator.WrongState.selector);
        coordinator.slashMissedRecovery(id, 4);
        _report(id, 4, AsyncBondedPackageCoordinator.Outcome.EXECUTED, keccak256("late-fill"));
        coordinator.close(id, 5);
        assertEq(token.balanceOf(BOND_RECIPIENT), terms.bondAtoms);
    }

    function testAdmissionPausePreventsUnfairSubmissionSlash() public {
        IAsyncVenueAdapter.VenueRequest memory request = _request();
        AsyncBondedPackageCoordinator.Terms memory terms = _terms(owner, request);
        bytes32 id = _reserve(terms);
        vm.prank(PAUSER);
        coordinator.pauseAdmission(address(adapter));
        vm.warp(terms.submissionDeadline + 1);
        coordinator.slashMissedSubmission(id, 1);
        coordinator.close(id, 2);
        assertEq(token.balanceOf(BOND_RECIPIENT), terms.bondAtoms);
        assertEq(token.balanceOf(SLASH_RECIPIENT), 0);
    }

    function _request() private view returns (IAsyncVenueAdapter.VenueRequest memory request) {
        request = IAsyncVenueAdapter.VenueRequest({
            marketId: keccak256("market"),
            collateralToken: address(token),
            sizeDelta: 10,
            collateralAtoms: 1000,
            acceptablePrice: 2000,
            executionFeeWei: 1,
            callbackGasLimit: 200_000,
            packageNonce: 0,
            orderHash: keccak256("order"),
            quoteHash: keccak256("quote"),
            routeHash: keccak256("route"),
            spot: IAsyncVenueAdapter.SpotEntry({
                fundingOwner: address(0),
                port: address(0),
                portCodeHash: bytes32(0),
                baseToken: address(0),
                quoteToken: address(0),
                baseAtoms: 0,
                maxQuoteAtoms: 0,
                rollbackMinQuoteAtoms: 0,
                entryFillCommitment: bytes32(0),
                rollbackFillCommitment: bytes32(0)
            }),
            submissionDeadline: uint64(block.timestamp + 10),
            venueDeadline: uint64(block.timestamp + 20),
            recoveryDeadline: uint64(block.timestamp + 30)
        });
    }

    function _terms(address owner_, IAsyncVenueAdapter.VenueRequest memory request)
        private
        view
        returns (AsyncBondedPackageCoordinator.Terms memory terms)
    {
        terms.domain = AsyncBondedPackageCoordinator.DomainRef(DOMAIN_HASH, 1, MANIFEST_HASH);
        terms.owner = owner_;
        terms.solver = SOLVER;
        terms.adapter = address(adapter);
        terms.handler = address(handler);
        terms.adapterCodeHash = address(adapter).codehash;
        terms.handlerCodeHash = address(handler).codehash;
        terms.orderHash = keccak256("order");
        terms.quoteHash = keccak256("quote");
        terms.routeHash = keccak256("route");
        terms.seriesIdentityKey = keccak256("series");
        terms.seriesBindingVersion = 1;
        terms.seriesBindingHash = keccak256("series-binding");
        terms.executionClassIdentityHash = coordinator.EXECUTION_CLASS_ID();
        terms.executionClassManifestHash = CLASS_HASH;
        terms.requestPayloadHash = keccak256(abi.encode(request));
        terms.evidenceSchemaHash = coordinator.EVIDENCE_SCHEMA_ID();
        terms.bondRecipient = BOND_RECIPIENT;
        terms.recoveryReserveRecipient = RESERVE_RECIPIENT;
        terms.slashRecipient = SLASH_RECIPIENT;
        terms.lossAsset = address(token);
        terms.residualAsset = address(token);
        terms.bondAtoms = 100;
        terms.recoveryReserveAtoms = 25;
        terms.maxAggregateLossAtoms = 25;
        terms.maxIntermediateResidualAtoms = 1000;
        terms.maxTerminalResidualAtoms = 100;
        terms.nonce = 0;
        terms.submissionDeadline = request.submissionDeadline;
        terms.venueDeadline = request.venueDeadline;
        terms.recoveryDeadline = request.recoveryDeadline;
        terms.bondHash = coordinator.bondCommitment(terms);
        terms.reservationHash = coordinator.reservationCommitment(terms);
        terms.recoveryPolicyHash = coordinator.recoveryPolicyCommitment(terms);
    }

    function _sign(AsyncBondedPackageCoordinator.Terms memory terms) private view returns (bytes memory signature) {
        bytes32 digest = coordinator.reserveDigest(terms);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OWNER_KEY, digest);
        signature = abi.encodePacked(r, s, v);
    }

    function _reserve(AsyncBondedPackageCoordinator.Terms memory terms) private returns (bytes32 id) {
        bytes memory signature = _sign(terms);
        vm.prank(SOLVER);
        id = coordinator.reserve(terms, signature);
    }

    function _submit(bytes32 id, IAsyncVenueAdapter.VenueRequest memory request) private {
        vm.prank(SOLVER);
        coordinator.submitRequest(id, 1, request);
    }

    function _evidence(bytes32 key, AsyncBondedPackageCoordinator.Outcome outcome, bytes32 hash)
        private
        view
        returns (AsyncBondedPackageCoordinator.VenueEvidence memory)
    {
        return AsyncBondedPackageCoordinator.VenueEvidence({
            requestKey: key,
            requestPayloadHash: keccak256(abi.encode(_request())),
            evidenceSchemaHash: coordinator.EVIDENCE_SCHEMA_ID(),
            evidenceHash: hash,
            outcome: outcome,
            lossAsset: address(token),
            residualAsset: address(token),
            observedLossAtoms: 0,
            intermediateResidualAtoms: 0,
            terminalResidualAtoms: 0
        });
    }

    function _report(bytes32 id, uint64 version, AsyncBondedPackageCoordinator.Outcome outcome, bytes32 hash) private {
        AsyncBondedPackageCoordinator.VenueEvidence memory evidence = _evidence(adapter.nextKey(), outcome, hash);
        evidence.requestPayloadHash = coordinator.packageState(id).terms.requestPayloadHash;
        handler.report(coordinator, id, version, evidence);
    }
}

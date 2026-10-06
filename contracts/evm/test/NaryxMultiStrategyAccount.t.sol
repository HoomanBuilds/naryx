// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "openzeppelin-contracts/token/ERC20/ERC20.sol";
import {IERC20} from "openzeppelin-contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/token/ERC20/utils/SafeERC20.sol";
import {NaryxMultiStrategyAccount} from "../src/NaryxMultiStrategyAccount.sol";
import {ProtocolConfig} from "../src/ProtocolConfig.sol";
import {SolverRegistry} from "../src/SolverRegistry.sol";
import {StrategyFeePolicyRegistry} from "../src/StrategyFeePolicyRegistry.sol";
import {TypedStrategyAdapterRegistry} from "../src/TypedStrategyAdapterRegistry.sol";
import {ITypedStrategyAdapter} from "../src/interfaces/ITypedStrategyAdapter.sol";

contract MultiStrategyToken is ERC20 {
    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

    function mint(address recipient, uint256 amount) external {
        _mint(recipient, amount);
    }
}

contract MultiStrategyAdapter is ITypedStrategyAdapter {
    using SafeERC20 for IERC20;

    address public immutable strategyAccount;
    IERC20 public immutable base;
    IERC20 public immutable quote;

    constructor(address strategyAccount_, IERC20 base_, IERC20 quote_) {
        strategyAccount = strategyAccount_;
        base = base_;
        quote = quote_;
    }

    function adapterMetadata() external view returns (address, bytes32, uint32, address, address) {
        return (strategyAccount, keccak256("naryx.evm.perp-exact"), 1, address(base), address(quote));
    }

    function executeLeg(bytes calldata payload) external returns (bytes32 evidenceHash) {
        (uint8 mode, IERC20 token, address recipient, uint256 amount, bytes32 expectedEvidence) =
            abi.decode(payload, (uint8, IERC20, address, uint256, bytes32));
        if (mode == 1) token.safeTransferFrom(msg.sender, recipient, amount);
        else if (mode == 2) revert("adapter failure");
        else token.safeTransfer(msg.sender, amount);
        return expectedEvidence;
    }
}

contract NaryxMultiStrategyAccountTest is Test {
    string private constant DOMAIN_ID = "eip155:31337";
    bytes32 private constant DOMAIN_HASH = keccak256("domain");
    bytes32 private constant ADAPTER_ID = keccak256("typed-strategy-adapter");
    bytes32 private constant ADAPTER_MANIFEST_HASH = keccak256("typed-strategy-adapter-v1");
    bytes32 private constant TEMPLATE_ID = keccak256("perpetual-funding-spread-v1");
    bytes32 private constant TEMPLATE_MANIFEST_HASH = keccak256("funding-spread-template-v1");
    bytes32 private constant FEE_POLICY_SUBJECT_ID = keccak256("multi-strategy-fees");
    bytes32 private constant FEE_POLICY_MANIFEST_HASH = keccak256("multi-strategy-fees-v1");
    bytes32 private constant STATE_ONE = keccak256("state-one");
    bytes32 private constant EVIDENCE_ONE = keccak256("evidence-one");
    bytes32 private constant EVIDENCE_TWO = keccak256("evidence-two");
    address private constant PROPOSER = address(0x101);
    address private constant CANCELLER = address(0x102);
    address private constant GOVERNANCE_EXECUTOR = address(0x103);
    address private constant PAUSER = address(0x104);
    address private constant RECIPIENT = address(0x105);
    address private constant PROTOCOL_RECIPIENT = address(0x106);

    uint256 private ownerKey = 0xA11CE;
    uint256 private solverKey = 0xB0B;
    address private owner;
    address private solver;
    ProtocolConfig private config;
    SolverRegistry private solvers;
    TypedStrategyAdapterRegistry private adapters;
    StrategyFeePolicyRegistry private feePolicies;
    NaryxMultiStrategyAccount private account;
    MultiStrategyToken private base;
    MultiStrategyToken private quote;
    MultiStrategyAdapter private adapter;

    function setUp() public {
        owner = vm.addr(ownerKey);
        solver = vm.addr(solverKey);
        config = new ProtocolConfig(DOMAIN_ID, 1, DOMAIN_HASH, 1, PROPOSER, CANCELLER, GOVERNANCE_EXECUTOR, PAUSER);
        solvers = new SolverRegistry(config, solver);
        adapters = new TypedStrategyAdapterRegistry(config);
        feePolicies = new StrategyFeePolicyRegistry(config);
        base = new MultiStrategyToken("Base", "BASE");
        quote = new MultiStrategyToken("Quote", "QUOTE");
        account = new NaryxMultiStrategyAccount(owner, config, solvers, adapters, feePolicies, FEE_POLICY_SUBJECT_ID);
        adapter = new MultiStrategyAdapter(address(account), base, quote);

        vm.prank(PROPOSER);
        adapters.proposeRegistration(_binding(), _control());
        vm.warp(block.timestamp + 1);
        vm.prank(GOVERNANCE_EXECUTOR);
        adapters.activateRegistration(ADAPTER_ID);
        vm.prank(PROPOSER);
        feePolicies.proposePolicy(FEE_POLICY_SUBJECT_ID, _feePolicy());
        vm.warp(block.timestamp + 1);
        vm.prank(GOVERNANCE_EXECUTOR);
        feePolicies.activate(FEE_POLICY_SUBJECT_ID);
        vm.prank(PROPOSER);
        config.scheduleUnpause();
        vm.warp(block.timestamp + 1);
        vm.prank(GOVERNANCE_EXECUTOR);
        config.activateUnpause();
        quote.mint(address(account), 1_000 ether);
    }

    function testCollectsSignedProtocolAndSolverFeesWithinDelayedPolicy() public {
        NaryxMultiStrategyAccount.Execution memory execution = _execution(account.ENTER(), bytes32(0), STATE_ONE, 0);
        execution.fees.protocolFeeAtoms = 0.1 ether;
        execution.fees.solverFeeAtoms = 0.05 ether;
        NaryxMultiStrategyAccount.AdapterCall[] memory calls = _calls(
            true,
            address(quote),
            25 ether,
            abi.encode(uint8(1), IERC20(address(quote)), RECIPIENT, 25 ether, EVIDENCE_ONE)
        );

        account.execute(
            execution,
            calls,
            _sign(ownerKey, account.ownerDigest(execution, calls)),
            _sign(solverKey, account.solverDigest(execution, calls))
        );

        assertEq(quote.balanceOf(PROTOCOL_RECIPIENT), 0.1 ether);
        assertEq(quote.balanceOf(solver), 0.05 ether);
    }

    function testRejectsSignedFeeAbovePolicyCap() public {
        NaryxMultiStrategyAccount.Execution memory execution = _execution(account.ENTER(), bytes32(0), STATE_ONE, 0);
        execution.fees.protocolFeeAtoms = 0.125 ether + 1;
        NaryxMultiStrategyAccount.AdapterCall[] memory calls = _calls(
            true,
            address(quote),
            25 ether,
            abi.encode(uint8(1), IERC20(address(quote)), RECIPIENT, 25 ether, EVIDENCE_ONE)
        );
        bytes memory ownerSignature = _sign(ownerKey, account.ownerDigest(execution, calls));
        bytes memory solverSignature = _sign(solverKey, account.solverDigest(execution, calls));

        vm.expectRevert(StrategyFeePolicyRegistry.FeeExceedsPolicy.selector);
        account.execute(execution, calls, ownerSignature, solverSignature);
    }

    function testExecutesFundingSpreadLifecycleAndClearsAllowance() public {
        NaryxMultiStrategyAccount.Execution memory entry = _execution(account.ENTER(), bytes32(0), STATE_ONE, 0);
        NaryxMultiStrategyAccount.AdapterCall[] memory entryCalls = _calls(
            true,
            address(quote),
            25 ether,
            abi.encode(uint8(1), IERC20(address(quote)), RECIPIENT, 25 ether, EVIDENCE_ONE)
        );
        bytes32 entryReceipt = account.execute(
            entry,
            entryCalls,
            _sign(ownerKey, account.ownerDigest(entry, entryCalls)),
            _sign(solverKey, account.solverDigest(entry, entryCalls))
        );

        assertEq(quote.balanceOf(RECIPIENT), 25 ether);
        assertEq(quote.allowance(address(account), address(adapter)), 0);
        assertEq(account.nextNonce(), 1);
        NaryxMultiStrategyAccount.PackageState memory opened = account.packageState(entry.packageId);
        assertTrue(opened.active);
        assertEq(opened.stateHash, STATE_ONE);
        assertEq(opened.lastReceiptHash, entryReceipt);

        quote.mint(address(adapter), 25 ether);
        NaryxMultiStrategyAccount.Execution memory exit = _execution(account.EXIT(), STATE_ONE, bytes32(0), 1);
        NaryxMultiStrategyAccount.AdapterCall[] memory exitCalls = _calls(
            false, address(0), 0, abi.encode(uint8(0), IERC20(address(quote)), address(0), 25 ether, EVIDENCE_TWO)
        );
        account.execute(
            exit,
            exitCalls,
            _sign(ownerKey, account.ownerDigest(exit, exitCalls)),
            _sign(solverKey, account.solverDigest(exit, exitCalls))
        );

        assertEq(quote.balanceOf(address(account)), 1_000 ether);
        assertFalse(account.packageState(entry.packageId).active);
        assertEq(account.nextNonce(), 2);
    }

    function testAdapterFailureRollsBackTransferNonceAndPackageState() public {
        NaryxMultiStrategyAccount.Execution memory execution = _execution(account.ENTER(), bytes32(0), STATE_ONE, 0);
        NaryxMultiStrategyAccount.AdapterCall[] memory calls = new NaryxMultiStrategyAccount.AdapterCall[](2);
        calls[0] = _call(
            true,
            address(quote),
            25 ether,
            abi.encode(uint8(1), IERC20(address(quote)), RECIPIENT, 25 ether, EVIDENCE_ONE)
        );
        calls[1] = _call(
            true,
            address(quote),
            25 ether,
            abi.encode(uint8(2), IERC20(address(quote)), RECIPIENT, 25 ether, EVIDENCE_TWO)
        );
        execution.totalGrossNotionalAtoms = 100 ether;
        bytes memory ownerSignature = _sign(ownerKey, account.ownerDigest(execution, calls));
        bytes memory solverSignature = _sign(solverKey, account.solverDigest(execution, calls));

        vm.expectRevert(
            abi.encodeWithSelector(
                NaryxMultiStrategyAccount.AdapterExecutionFailed.selector,
                uint256(1),
                abi.encodeWithSignature("Error(string)", "adapter failure")
            )
        );
        account.execute(execution, calls, ownerSignature, solverSignature);

        assertEq(quote.balanceOf(RECIPIENT), 0);
        assertEq(quote.balanceOf(address(account)), 1_000 ether);
        assertEq(quote.allowance(address(account), address(adapter)), 0);
        assertEq(account.nextNonce(), 0);
        assertFalse(account.packageState(execution.packageId).active);
    }

    function testPauseBlocksRiskIncreaseButPreservesExactHistoricalExit() public {
        NaryxMultiStrategyAccount.Execution memory entry = _execution(account.ENTER(), bytes32(0), STATE_ONE, 0);
        NaryxMultiStrategyAccount.AdapterCall[] memory entryCalls = _calls(
            true,
            address(quote),
            10 ether,
            abi.encode(uint8(1), IERC20(address(quote)), RECIPIENT, 10 ether, EVIDENCE_ONE)
        );
        account.execute(
            entry,
            entryCalls,
            _sign(ownerKey, account.ownerDigest(entry, entryCalls)),
            _sign(solverKey, account.solverDigest(entry, entryCalls))
        );

        vm.prank(PAUSER);
        config.pauseEntry();
        NaryxMultiStrategyAccount.Execution memory increase =
            _execution(account.INCREASE(), STATE_ONE, keccak256("state-two"), 1);
        NaryxMultiStrategyAccount.AdapterCall[] memory increaseCalls = _calls(
            true,
            address(quote),
            1 ether,
            abi.encode(uint8(1), IERC20(address(quote)), RECIPIENT, 1 ether, EVIDENCE_TWO)
        );
        bytes memory increaseOwnerSignature = _sign(ownerKey, account.ownerDigest(increase, increaseCalls));
        bytes memory increaseSolverSignature = _sign(solverKey, account.solverDigest(increase, increaseCalls));
        vm.expectRevert(NaryxMultiStrategyAccount.EntryPaused.selector);
        account.execute(increase, increaseCalls, increaseOwnerSignature, increaseSolverSignature);

        vm.prank(PAUSER);
        adapters.tightenControl(_adapterRef(), TypedStrategyAdapterRegistry.Lifecycle.DEPRECATED, 1 ether, 1 ether);
        quote.mint(address(adapter), 10 ether);
        NaryxMultiStrategyAccount.Execution memory exit = _execution(account.EXIT(), STATE_ONE, bytes32(0), 1);
        NaryxMultiStrategyAccount.AdapterCall[] memory exitCalls = _calls(
            false, address(0), 0, abi.encode(uint8(0), IERC20(address(quote)), address(0), 10 ether, EVIDENCE_TWO)
        );
        account.execute(
            exit,
            exitCalls,
            _sign(ownerKey, account.ownerDigest(exit, exitCalls)),
            _sign(solverKey, account.solverDigest(exit, exitCalls))
        );
        assertFalse(account.packageState(entry.packageId).active);
    }

    function testOwnerCanRecoverExitAfterSolverRemoval() public {
        NaryxMultiStrategyAccount.Execution memory entry = _execution(account.ENTER(), bytes32(0), STATE_ONE, 0);
        NaryxMultiStrategyAccount.AdapterCall[] memory entryCalls = _calls(
            true,
            address(quote),
            10 ether,
            abi.encode(uint8(1), IERC20(address(quote)), RECIPIENT, 10 ether, EVIDENCE_ONE)
        );
        account.execute(
            entry,
            entryCalls,
            _sign(ownerKey, account.ownerDigest(entry, entryCalls)),
            _sign(solverKey, account.solverDigest(entry, entryCalls))
        );

        vm.prank(PAUSER);
        solvers.removeSolver(solver);
        vm.prank(PAUSER);
        feePolicies.pause(FEE_POLICY_SUBJECT_ID);
        quote.mint(address(adapter), 10 ether);
        NaryxMultiStrategyAccount.Execution memory exit = _execution(account.EXIT(), STATE_ONE, bytes32(0), 1);
        exit.solver = address(0);
        exit.fees = NaryxMultiStrategyAccount.FeeTerms(0, bytes32(0), address(0), 0, 0);
        NaryxMultiStrategyAccount.AdapterCall[] memory exitCalls = _calls(
            false, address(0), 0, abi.encode(uint8(0), IERC20(address(quote)), address(0), 10 ether, EVIDENCE_TWO)
        );
        account.executeRecovery(exit, exitCalls, _sign(ownerKey, account.ownerDigest(exit, exitCalls)));

        assertFalse(account.packageState(entry.packageId).active);
        assertEq(account.nextNonce(), 2);
        assertEq(quote.balanceOf(address(account)), 1_000 ether);
    }

    function testRegistryRejectsAdapterMetadataMismatch() public {
        TypedStrategyAdapterRegistry.AdapterBinding memory binding = _binding();
        binding.identity = TypedStrategyAdapterRegistry.ManifestRef(
            keccak256("mismatched-adapter"), 1, keccak256("mismatched-adapter-v1")
        );
        binding.adapterClassId = keccak256("naryx.evm.spot-exact");
        vm.prank(PROPOSER);
        vm.expectRevert(TypedStrategyAdapterRegistry.InvalidBinding.selector);
        adapters.proposeRegistration(binding, _control());
    }

    function _binding() private view returns (TypedStrategyAdapterRegistry.AdapterBinding memory) {
        return TypedStrategyAdapterRegistry.AdapterBinding({
            domain: TypedStrategyAdapterRegistry.DomainRef(keccak256(bytes(DOMAIN_ID)), 1, DOMAIN_HASH),
            identity: _adapterRef(),
            mode: TypedStrategyAdapterRegistry.AdapterMode.DIRECT,
            adapter: address(adapter),
            expectedCodeHash: address(adapter).codehash,
            adapterClassId: keccak256("naryx.evm.perp-exact"),
            adapterClassVersion: 1,
            template: _template(),
            settlementClass: _settlement(),
            baseAsset: TypedStrategyAdapterRegistry.AssetBinding(address(base), address(base).codehash),
            quoteAsset: TypedStrategyAdapterRegistry.AssetBinding(address(quote), address(quote).codehash),
            maximumGasLimit: 700_000
        });
    }

    function _control() private pure returns (TypedStrategyAdapterRegistry.AdapterControl memory) {
        return TypedStrategyAdapterRegistry.AdapterControl({
            state: TypedStrategyAdapterRegistry.Lifecycle.ACTIVE,
            maximumApprovalAtoms: 100 ether,
            maximumGrossNotionalAtoms: 1_000 ether
        });
    }

    function _execution(uint8 operation, bytes32 previousState, bytes32 nextState, uint256 nonce)
        private
        view
        returns (NaryxMultiStrategyAccount.Execution memory)
    {
        return NaryxMultiStrategyAccount.Execution({
            domainIdHash: keccak256(bytes(DOMAIN_ID)),
            domainManifestVersion: 1,
            domainManifestHash: DOMAIN_HASH,
            packageId: keccak256("funding-spread-package"),
            orderHash: keccak256(abi.encode("order", nonce)),
            graphHash: keccak256("graph"),
            quoteHash: keccak256(abi.encode("quote", nonce)),
            routeHash: keccak256(abi.encode("route", nonce)),
            template: _template(),
            settlementClass: _settlement(),
            operation: operation,
            previousStateHash: previousState,
            nextStateHash: nextState,
            totalGrossNotionalAtoms: 50 ether,
            fees: NaryxMultiStrategyAccount.FeeTerms({
                policyVersion: 1,
                policyManifestHash: FEE_POLICY_MANIFEST_HASH,
                token: address(quote),
                protocolFeeAtoms: 0,
                solverFeeAtoms: 0
            }),
            solver: solver,
            nonce: nonce,
            deadline: block.timestamp + 1 hours
        });
    }

    function _calls(bool riskIncreasing, address approvalToken, uint256 approvalAtoms, bytes memory payload)
        private
        view
        returns (NaryxMultiStrategyAccount.AdapterCall[] memory result)
    {
        result = new NaryxMultiStrategyAccount.AdapterCall[](1);
        result[0] = _call(riskIncreasing, approvalToken, approvalAtoms, payload);
    }

    function _call(bool riskIncreasing, address approvalToken, uint256 approvalAtoms, bytes memory payload)
        private
        view
        returns (NaryxMultiStrategyAccount.AdapterCall memory)
    {
        return NaryxMultiStrategyAccount.AdapterCall({
            adapter: _adapterRef(),
            target: address(adapter),
            stage: 0,
            riskIncreasing: riskIncreasing,
            approvalToken: approvalToken,
            approvalAtoms: approvalAtoms,
            grossNotionalAtoms: 50 ether,
            gasLimit: 500_000,
            payload: payload
        });
    }

    function _adapterRef() private pure returns (TypedStrategyAdapterRegistry.ManifestRef memory) {
        return TypedStrategyAdapterRegistry.ManifestRef(ADAPTER_ID, 1, ADAPTER_MANIFEST_HASH);
    }

    function _template() private pure returns (TypedStrategyAdapterRegistry.TemplateRef memory) {
        return TypedStrategyAdapterRegistry.TemplateRef(TEMPLATE_ID, 1, TEMPLATE_MANIFEST_HASH);
    }

    function _settlement() private pure returns (TypedStrategyAdapterRegistry.SettlementClassRef memory) {
        return TypedStrategyAdapterRegistry.SettlementClassRef(keccak256("ATOMIC_POSTCONDITION"), 1);
    }

    function _feePolicy() private view returns (StrategyFeePolicyRegistry.Policy memory) {
        return StrategyFeePolicyRegistry.Policy({
            version: 1,
            manifestHash: FEE_POLICY_MANIFEST_HASH,
            token: address(quote),
            expectedTokenCodeHash: address(quote).codehash,
            protocolRecipient: PROTOCOL_RECIPIENT,
            maximumProtocolFeeBps: 25,
            maximumSolverFeeBps: 15,
            paused: false
        });
    }

    function _sign(uint256 key, bytes32 digest) private view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }
}

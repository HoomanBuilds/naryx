// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "openzeppelin-contracts/token/ERC20/ERC20.sol";
import {ProtocolConfig} from "../src/ProtocolConfig.sol";
import {RiskDomainRegistry} from "../src/RiskDomainRegistry.sol";

contract RiskDomainToken is ERC20 {
    constructor() ERC20("Risk Domain USD", "rdUSD") {}
}

contract RiskDomainRegistryTest is Test {
    address private constant PROPOSER = address(0xA1);
    address private constant CANCELLER = address(0xA2);
    address private constant EXECUTOR = address(0xA3);
    address private constant PAUSER = address(0xA4);
    bytes32 private constant DOMAIN = keccak256("sol-relative-value");
    bytes32 private constant MANIFEST_ONE = keccak256("risk-domain-v1");
    bytes32 private constant MANIFEST_TWO = keccak256("risk-domain-v2");
    bytes32 private constant SERIES_ID = keccak256("sol-carry");
    bytes32 private constant SERIES_HASH = keccak256("sol-carry-v2");
    bytes32 private constant VENUE_A = bytes32(uint256(1));
    bytes32 private constant VENUE_B = bytes32(uint256(2));

    RiskDomainRegistry private registry;
    RiskDomainToken private token;
    ProtocolConfig private config;

    function setUp() public {
        vm.warp(1_000);
        config = new ProtocolConfig("eip155:31337", 1, keccak256("domain"), 60, PROPOSER, CANCELLER, EXECUTOR, PAUSER);
        registry = new RiskDomainRegistry(config);
        token = new RiskDomainToken();
    }

    function testDelayedActivationAndBoundedEntry() public {
        _propose(1, MANIFEST_ONE);
        vm.prank(EXECUTOR);
        vm.expectRevert(abi.encodeWithSelector(RiskDomainRegistry.ProposalNotReady.selector, uint64(1_060)));
        registry.activate(DOMAIN);
        vm.warp(1_060);
        vm.prank(EXECUTOR);
        registry.activate(DOMAIN);

        RiskDomainRegistry.EntryRisk memory risk = _risk();
        uint256 required = registry.validateEntry(DOMAIN, 1, MANIFEST_ONE, _series(), risk, _exposures());
        assertEq(required, 500_000_000e6);

        risk.marginQuoteAtoms = required - 1;
        vm.expectRevert(abi.encodeWithSelector(RiskDomainRegistry.MarginInsufficient.selector, required, required - 1));
        registry.validateEntry(DOMAIN, 1, MANIFEST_ONE, _series(), risk, _exposures());

        risk = _risk();
        RiskDomainRegistry.DependencyExposure[] memory exposures = _exposures();
        exposures[0].grossQuoteAtoms = 4_000_000_001e6;
        vm.expectRevert(
            abi.encodeWithSelector(
                RiskDomainRegistry.DependencyLimitExceeded.selector, VENUE_A, 4_000_000_000e6, 4_000_000_001e6
            )
        );
        registry.validateEntry(DOMAIN, 1, MANIFEST_ONE, _series(), risk, exposures);

        RiskDomainRegistry.DependencyExposure[] memory incomplete = new RiskDomainRegistry.DependencyExposure[](1);
        incomplete[0] = exposures[0];
        vm.expectRevert(RiskDomainRegistry.InvalidDependency.selector);
        registry.validateEntry(DOMAIN, 1, MANIFEST_ONE, _series(), risk, incomplete);
    }

    function testPauseKeepsExitOpenAndResumeWaits() public {
        _activate(1, MANIFEST_ONE);
        vm.prank(PAUSER);
        registry.pauseEntry(DOMAIN);
        vm.expectRevert(RiskDomainRegistry.EntryUnavailable.selector);
        registry.validateEntry(DOMAIN, 1, MANIFEST_ONE, _series(), _risk(), _exposures());
        registry.validateExit(DOMAIN, 1, MANIFEST_ONE, _series(), address(token));

        vm.prank(PROPOSER);
        registry.proposeResume(DOMAIN);
        vm.prank(EXECUTOR);
        vm.expectRevert();
        registry.activate(DOMAIN);
        vm.warp(block.timestamp + 60);
        vm.prank(EXECUTOR);
        registry.activate(DOMAIN);
        registry.validateEntry(DOMAIN, 1, MANIFEST_ONE, _series(), _risk(), _exposures());
    }

    function testNewVersionRetiresEntryButPreservesOldExit() public {
        _activate(1, MANIFEST_ONE);
        _activate(2, MANIFEST_TWO);
        vm.expectRevert(RiskDomainRegistry.EntryUnavailable.selector);
        registry.validateEntry(DOMAIN, 1, MANIFEST_ONE, _series(), _risk(), _exposures());
        registry.validateExit(DOMAIN, 1, MANIFEST_ONE, _series(), address(token));
        registry.validateEntry(DOMAIN, 2, MANIFEST_TWO, _series(), _risk(), _exposures());
    }

    function testRejectsUnsortedOrUnsafePolicy() public {
        RiskDomainRegistry.PolicyConfig memory rules = _rules(1, MANIFEST_ONE);
        RiskDomainRegistry.SeriesRef[] memory series = new RiskDomainRegistry.SeriesRef[](1);
        series[0] = _series();
        RiskDomainRegistry.DependencyLimit[] memory dependencies = _limits();
        (dependencies[0], dependencies[1]) = (dependencies[1], dependencies[0]);
        vm.prank(PROPOSER);
        vm.expectRevert(RiskDomainRegistry.InvalidDependency.selector);
        registry.proposePolicy(DOMAIN, rules, series, dependencies);

        rules.netCapQuoteAtoms = rules.grossCapQuoteAtoms + 1;
        vm.prank(PROPOSER);
        vm.expectRevert(RiskDomainRegistry.InvalidPolicy.selector);
        registry.proposePolicy(DOMAIN, rules, series, _limits());
    }

    function testDomainUpgradeInvalidatesTheOldPolicy() public {
        _activate(1, MANIFEST_ONE);
        vm.prank(PROPOSER);
        config.proposeDomain(2, keccak256("domain-v2"));
        vm.warp(block.timestamp + 60);
        vm.prank(EXECUTOR);
        config.activateDomain();
        vm.expectRevert(RiskDomainRegistry.PolicyMismatch.selector);
        registry.validateExit(DOMAIN, 1, MANIFEST_ONE, _series(), address(token));
    }

    function _activate(uint32 version, bytes32 manifest) private {
        _propose(version, manifest);
        vm.warp(block.timestamp + 60);
        vm.prank(EXECUTOR);
        registry.activate(DOMAIN);
    }

    function _propose(uint32 version, bytes32 manifest) private {
        RiskDomainRegistry.SeriesRef[] memory series = new RiskDomainRegistry.SeriesRef[](1);
        series[0] = _series();
        vm.prank(PROPOSER);
        registry.proposePolicy(DOMAIN, _rules(version, manifest), series, _limits());
    }

    function _rules(uint32 version, bytes32 manifest) private view returns (RiskDomainRegistry.PolicyConfig memory) {
        return RiskDomainRegistry.PolicyConfig({
            manifestVersion: version,
            manifestHash: manifest,
            domainManifestVersion: 1,
            domainManifestHash: keccak256("domain"),
            accountingToken: address(token),
            expectedTokenCodeHash: address(token).codehash,
            grossCapQuoteAtoms: 10_000_000_000e6,
            netCapQuoteAtoms: 2_000_000_000e6,
            minimumMarginFloorQuoteAtoms: 500_000_000e6,
            maximumLeverageBps: 50_000,
            maximumStalenessMs: 5_000,
            maximumTimeToUnwindMs: 60_000,
            requiredRecoveryReserveQuoteAtoms: 100_000_000e6,
            aggregateHaircutBps: 3_000
        });
    }

    function _series() private pure returns (RiskDomainRegistry.SeriesRef memory) {
        return RiskDomainRegistry.SeriesRef({seriesId: SERIES_ID, manifestVersion: 2, manifestHash: SERIES_HASH});
    }

    function _limits() private pure returns (RiskDomainRegistry.DependencyLimit[] memory limits) {
        limits = new RiskDomainRegistry.DependencyLimit[](2);
        limits[0] = RiskDomainRegistry.DependencyLimit(VENUE_A, 4_000_000_000e6);
        limits[1] = RiskDomainRegistry.DependencyLimit(VENUE_B, 5_000_000_000e6);
    }

    function _exposures() private pure returns (RiskDomainRegistry.DependencyExposure[] memory exposures) {
        exposures = new RiskDomainRegistry.DependencyExposure[](2);
        exposures[0] = RiskDomainRegistry.DependencyExposure(VENUE_A, 3_000_000_000e6);
        exposures[1] = RiskDomainRegistry.DependencyExposure(VENUE_B, 3_000_000_000e6);
    }

    function _risk() private view returns (RiskDomainRegistry.EntryRisk memory) {
        return RiskDomainRegistry.EntryRisk({
            accountingToken: address(token),
            grossQuoteAtoms: 2_500_000_000e6,
            netQuoteAtoms: 100_000_000e6,
            marginQuoteAtoms: 500_000_000e6,
            reservedRecoveryQuoteAtoms: 100_000_000e6,
            observationAgeMs: 100,
            timeToUnwindMs: 2_000
        });
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {ProtocolConfig} from "../src/ProtocolConfig.sol";

contract ProtocolConfigTest is Test {
    string private constant DOMAIN_ID = "eip155:31337";
    bytes32 private constant MANIFEST_HASH = keccak256("manifest-1");
    bytes32 private constant NEXT_MANIFEST_HASH = keccak256("manifest-2");
    bytes32 private constant OTHER_MANIFEST_HASH = keccak256("manifest-3");
    uint64 private constant CONFIG_DELAY_SECONDS = 50;

    address private constant DEPLOYER = address(0xD1);
    address private constant PROPOSER = address(0xA1);
    address private constant CANCELLER = address(0xA2);
    address private constant EXECUTOR = address(0xA3);
    address private constant PAUSER = address(0xA4);
    address private constant OUTSIDER = address(0xB1);

    event DomainProposed(
        address indexed actor,
        uint32 previousVersion,
        bytes32 previousHash,
        uint32 proposedVersion,
        bytes32 proposedHash,
        uint64 activationTimestamp
    );
    event DomainProposalCancelled(
        address indexed actor,
        uint32 activeVersion,
        bytes32 activeHash,
        uint32 cancelledVersion,
        bytes32 cancelledHash,
        uint64 activationTimestamp
    );
    event DomainActivated(
        address indexed actor, uint32 previousVersion, bytes32 previousHash, uint32 newVersion, bytes32 newHash
    );
    event EntryPaused(address indexed actor);
    event UnpauseScheduled(address indexed actor, uint64 activationTimestamp);
    event UnpauseCancelled(address indexed actor, uint64 activationTimestamp);
    event EntryUnpaused(address indexed actor);

    ProtocolConfig private config;

    function setUp() public {
        vm.prank(DEPLOYER);
        config = _deploy(DOMAIN_ID, 1, MANIFEST_HASH, CONFIG_DELAY_SECONDS, PROPOSER, CANCELLER, EXECUTOR, PAUSER);
    }

    function testConstructionIsValidatedFailClosedAndDeployerHasNoRole() public view {
        assertEq(config.configVersion(), 1);

        (string memory domainId_, uint32 manifestVersion, bytes32 manifestHash) = config.domain();
        assertEq(domainId_, DOMAIN_ID);
        assertEq(manifestVersion, 1);
        assertEq(manifestHash, MANIFEST_HASH);

        (address proposer, address canceller, address executor, address pauser) = config.roles();
        assertEq(proposer, PROPOSER);
        assertEq(canceller, CANCELLER);
        assertEq(executor, EXECUTOR);
        assertEq(pauser, PAUSER);
        assertTrue(DEPLOYER != proposer && DEPLOYER != canceller && DEPLOYER != executor && DEPLOYER != pauser);
        assertEq(config.configDelaySeconds(), CONFIG_DELAY_SECONDS);
        assertTrue(config.entryPaused());

        (bool hasPendingDomain,,,) = config.pendingDomain();
        (bool hasPendingUnpause,) = config.pendingUnpause();
        assertFalse(hasPendingDomain);
        assertFalse(hasPendingUnpause);
    }

    function testInvalidConstructionReverts() public {
        vm.expectRevert(ProtocolConfig.DomainIdEmpty.selector);
        _deploy("", 1, MANIFEST_HASH, CONFIG_DELAY_SECONDS, PROPOSER, CANCELLER, EXECUTOR, PAUSER);

        vm.expectRevert(ProtocolConfig.DomainIdTooLong.selector);
        _deploy(string(new bytes(129)), 1, MANIFEST_HASH, CONFIG_DELAY_SECONDS, PROPOSER, CANCELLER, EXECUTOR, PAUSER);

        vm.expectRevert(ProtocolConfig.DomainIdNotAscii.selector);
        _deploy(
            string(abi.encodePacked(bytes1(0x80))),
            1,
            MANIFEST_HASH,
            CONFIG_DELAY_SECONDS,
            PROPOSER,
            CANCELLER,
            EXECUTOR,
            PAUSER
        );

        vm.expectRevert(ProtocolConfig.DomainManifestVersionZero.selector);
        _deploy(DOMAIN_ID, 0, MANIFEST_HASH, CONFIG_DELAY_SECONDS, PROPOSER, CANCELLER, EXECUTOR, PAUSER);

        vm.expectRevert(ProtocolConfig.DomainManifestHashZero.selector);
        _deploy(DOMAIN_ID, 1, bytes32(0), CONFIG_DELAY_SECONDS, PROPOSER, CANCELLER, EXECUTOR, PAUSER);

        vm.expectRevert(ProtocolConfig.ConfigDelayZero.selector);
        _deploy(DOMAIN_ID, 1, MANIFEST_HASH, 0, PROPOSER, CANCELLER, EXECUTOR, PAUSER);

        vm.expectRevert(ProtocolConfig.GovernanceRoleZero.selector);
        _deploy(DOMAIN_ID, 1, MANIFEST_HASH, CONFIG_DELAY_SECONDS, PROPOSER, CANCELLER, address(0), PAUSER);

        vm.expectRevert(ProtocolConfig.GovernanceRoleDuplicate.selector);
        _deploy(DOMAIN_ID, 1, MANIFEST_HASH, CONFIG_DELAY_SECONDS, PROPOSER, CANCELLER, EXECUTOR, PROPOSER);
    }

    function testDomainProposalRolesCancelNoOverwriteVersionAndExactBoundary() public {
        vm.prank(EXECUTOR);
        vm.expectRevert(ProtocolConfig.DomainProposalMissing.selector);
        config.activateDomain();

        vm.prank(DEPLOYER);
        vm.expectRevert(abi.encodeWithSelector(ProtocolConfig.UnauthorizedRole.selector, DEPLOYER, PROPOSER));
        config.proposeDomain(2, NEXT_MANIFEST_HASH);

        vm.prank(PROPOSER);
        vm.expectRevert(
            abi.encodeWithSelector(ProtocolConfig.DomainManifestVersionNotIncreasing.selector, uint32(1), uint32(1))
        );
        config.proposeDomain(1, NEXT_MANIFEST_HASH);

        vm.prank(PROPOSER);
        vm.expectRevert(ProtocolConfig.DomainManifestHashZero.selector);
        config.proposeDomain(2, bytes32(0));

        vm.warp(100);
        vm.expectEmit(true, true, true, true, address(config));
        emit DomainProposed(PROPOSER, 1, MANIFEST_HASH, 2, NEXT_MANIFEST_HASH, 150);
        vm.prank(PROPOSER);
        config.proposeDomain(2, NEXT_MANIFEST_HASH);

        (bool exists, uint32 version, bytes32 hash, uint64 activationTimestamp) = config.pendingDomain();
        assertTrue(exists);
        assertEq(version, 2);
        assertEq(hash, NEXT_MANIFEST_HASH);
        assertEq(activationTimestamp, 150);

        vm.prank(PROPOSER);
        vm.expectRevert(ProtocolConfig.DomainProposalExists.selector);
        config.proposeDomain(3, OTHER_MANIFEST_HASH);

        vm.prank(OUTSIDER);
        vm.expectRevert(abi.encodeWithSelector(ProtocolConfig.UnauthorizedRole.selector, OUTSIDER, CANCELLER));
        config.cancelDomainProposal();

        vm.expectEmit(true, true, true, true, address(config));
        emit DomainProposalCancelled(CANCELLER, 1, MANIFEST_HASH, 2, NEXT_MANIFEST_HASH, 150);
        vm.prank(CANCELLER);
        config.cancelDomainProposal();

        vm.prank(PROPOSER);
        config.proposeDomain(2, NEXT_MANIFEST_HASH);

        vm.warp(149);
        vm.prank(EXECUTOR);
        vm.expectRevert(abi.encodeWithSelector(ProtocolConfig.DomainProposalNotReady.selector, uint64(150)));
        config.activateDomain();

        vm.warp(150);
        vm.prank(OUTSIDER);
        vm.expectRevert(abi.encodeWithSelector(ProtocolConfig.UnauthorizedRole.selector, OUTSIDER, EXECUTOR));
        config.activateDomain();

        vm.expectEmit(true, true, true, true, address(config));
        emit DomainActivated(EXECUTOR, 1, MANIFEST_HASH, 2, NEXT_MANIFEST_HASH);
        vm.prank(EXECUTOR);
        config.activateDomain();

        (string memory domainId_, uint32 activeVersion, bytes32 activeHash) = config.domain();
        assertEq(domainId_, DOMAIN_ID);
        assertEq(activeVersion, 2);
        assertEq(activeHash, NEXT_MANIFEST_HASH);
        (exists,,,) = config.pendingDomain();
        assertFalse(exists);

        vm.warp(type(uint64).max);
        vm.prank(PROPOSER);
        vm.expectRevert(ProtocolConfig.ActivationTimestampOverflow.selector);
        config.proposeDomain(3, OTHER_MANIFEST_HASH);
    }

    function testImmediatePauseAndDelayedCancelRepauseActivate() public {
        vm.prank(PAUSER);
        vm.expectRevert(ProtocolConfig.EntryAlreadyPaused.selector);
        config.pauseEntry();

        vm.prank(EXECUTOR);
        vm.expectRevert(ProtocolConfig.UnpauseNotScheduled.selector);
        config.activateUnpause();

        vm.warp(200);
        vm.prank(OUTSIDER);
        vm.expectRevert(abi.encodeWithSelector(ProtocolConfig.UnauthorizedRole.selector, OUTSIDER, PROPOSER));
        config.scheduleUnpause();

        vm.expectEmit(true, true, true, true, address(config));
        emit UnpauseScheduled(PROPOSER, 250);
        vm.prank(PROPOSER);
        config.scheduleUnpause();

        vm.prank(PROPOSER);
        vm.expectRevert(ProtocolConfig.UnpauseAlreadyScheduled.selector);
        config.scheduleUnpause();

        vm.warp(249);
        vm.prank(EXECUTOR);
        vm.expectRevert(abi.encodeWithSelector(ProtocolConfig.UnpauseNotReady.selector, uint64(250)));
        config.activateUnpause();

        vm.warp(250);
        vm.prank(OUTSIDER);
        vm.expectRevert(abi.encodeWithSelector(ProtocolConfig.UnauthorizedRole.selector, OUTSIDER, EXECUTOR));
        config.activateUnpause();

        vm.expectEmit(true, true, true, true, address(config));
        emit EntryUnpaused(EXECUTOR);
        vm.prank(EXECUTOR);
        config.activateUnpause();
        assertFalse(config.entryPaused());

        vm.prank(PROPOSER);
        vm.expectRevert(ProtocolConfig.EntryNotPaused.selector);
        config.scheduleUnpause();

        vm.prank(OUTSIDER);
        vm.expectRevert(abi.encodeWithSelector(ProtocolConfig.UnauthorizedRole.selector, OUTSIDER, PAUSER));
        config.pauseEntry();

        vm.expectEmit(true, true, true, true, address(config));
        emit EntryPaused(PAUSER);
        vm.prank(PAUSER);
        config.pauseEntry();
        assertTrue(config.entryPaused());

        vm.prank(PROPOSER);
        config.scheduleUnpause();

        vm.prank(OUTSIDER);
        vm.expectRevert(abi.encodeWithSelector(ProtocolConfig.UnauthorizedRole.selector, OUTSIDER, CANCELLER));
        config.cancelUnpause();

        vm.expectEmit(true, true, true, true, address(config));
        emit UnpauseCancelled(CANCELLER, 300);
        vm.prank(CANCELLER);
        config.cancelUnpause();

        vm.prank(PROPOSER);
        config.scheduleUnpause();

        vm.expectEmit(true, true, true, true, address(config));
        emit UnpauseCancelled(PAUSER, 300);
        vm.expectEmit(true, true, true, true, address(config));
        emit EntryPaused(PAUSER);
        vm.prank(PAUSER);
        config.pauseEntry();

        (bool exists,) = config.pendingUnpause();
        assertFalse(exists);
        vm.warp(300);
        vm.prank(EXECUTOR);
        vm.expectRevert(ProtocolConfig.UnpauseNotScheduled.selector);
        config.activateUnpause();
    }

    function _deploy(
        string memory domainId_,
        uint32 manifestVersion,
        bytes32 manifestHash,
        uint64 delaySeconds,
        address proposer,
        address canceller,
        address executor,
        address pauser
    ) private returns (ProtocolConfig deployed) {
        deployed = new ProtocolConfig(
            domainId_, manifestVersion, manifestHash, delaySeconds, proposer, canceller, executor, pauser
        );
    }
}

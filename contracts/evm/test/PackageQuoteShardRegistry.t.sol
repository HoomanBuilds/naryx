// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {PackageQuoteShard} from "../src/PackageQuoteShard.sol";
import {PackageQuoteShardRegistry} from "../src/PackageQuoteShardRegistry.sol";
import {ProtocolConfig} from "../src/ProtocolConfig.sol";

contract RegistryQuoteConsumer {}

contract PackageQuoteShardRegistryTest is Test {
    uint64 private constant DELAY = 10;
    bytes32 private constant DOMAIN_MANIFEST_HASH = keccak256("domain-manifest-1");
    bytes32 private constant SERIES_MANIFEST_HASH = keccak256("series-manifest-1");
    bytes32 private constant EXECUTION_CLASS_MANIFEST_HASH = keccak256("execution-class-manifest-1");
    bytes32 private constant SHARD_MANIFEST_HASH_1 = keccak256("shard-manifest-1");
    bytes32 private constant SHARD_MANIFEST_HASH_2 = keccak256("shard-manifest-2");

    address private constant PROPOSER = address(0x101);
    address private constant CANCELLER = address(0x102);
    address private constant GOVERNANCE_EXECUTOR = address(0x103);
    address private constant PAUSER = address(0x104);
    address private constant SOLVER = address(0x201);
    address private constant OTHER_SOLVER = address(0x202);

    ProtocolConfig private config;
    PackageQuoteShardRegistry private registry;
    RegistryQuoteConsumer private consumer;
    PackageQuoteShardRegistry.ShardIdentity private identity;
    bytes32 private key;

    function setUp() public {
        vm.warp(100);
        config = new ProtocolConfig(
            "eip155:84532", 1, DOMAIN_MANIFEST_HASH, DELAY, PROPOSER, CANCELLER, GOVERNANCE_EXECUTOR, PAUSER
        );
        registry = new PackageQuoteShardRegistry(config);
        consumer = new RegistryQuoteConsumer();
        identity = PackageQuoteShardRegistry.ShardIdentity({
            seriesManifestHash: SERIES_MANIFEST_HASH,
            executionClassManifestHash: EXECUTION_CLASS_MANIFEST_HASH,
            solver: SOLVER
        });
        key = registry.identityKey(identity);
    }

    function testDelayedActivationAndExactLiveAdmission() public {
        PackageQuoteShard shard = _deployShard(identity);
        uint64 readyAt = _propose(identity, 1, SHARD_MANIFEST_HASH_1, shard);

        vm.prank(GOVERNANCE_EXECUTOR);
        vm.expectRevert(
            abi.encodeWithSelector(PackageQuoteShardRegistry.RegistrationProposalNotReady.selector, readyAt)
        );
        registry.activateRegistration(key);

        vm.warp(readyAt);
        vm.prank(GOVERNANCE_EXECUTOR);
        registry.activateRegistration(key);

        PackageQuoteShardRegistry.ShardReference memory exactRef = _reference(1, SHARD_MANIFEST_HASH_1, shard);
        PackageQuoteShardRegistry.ShardBinding memory binding = registry.validateEntry(exactRef);
        assertEq(binding.identityKey, key);
        assertEq(binding.shard, address(shard));
        (, PackageQuoteShardRegistry.Lifecycle state) = registry.activeShard(key);
        assertEq(uint8(state), uint8(PackageQuoteShardRegistry.Lifecycle.ACTIVE));
    }

    function testMismatchedShardCodeAndIdentityFailClosed() public {
        PackageQuoteShard shard = _deployShard(identity);
        PackageQuoteShardRegistry.ShardIdentity memory wrongIdentity = identity;
        wrongIdentity.solver = OTHER_SOLVER;

        vm.prank(PROPOSER);
        vm.expectRevert(PackageQuoteShardRegistry.InvalidShard.selector);
        registry.proposeRegistration(
            wrongIdentity,
            1,
            SHARD_MANIFEST_HASH_1,
            address(shard),
            address(shard).codehash,
            address(consumer),
            address(consumer).codehash
        );

        vm.prank(PROPOSER);
        vm.expectRevert(PackageQuoteShardRegistry.ShardCodeMismatch.selector);
        registry.proposeRegistration(
            identity,
            1,
            SHARD_MANIFEST_HASH_1,
            address(shard),
            keccak256("wrong-code"),
            address(consumer),
            address(consumer).codehash
        );

        uint64 readyAt = _propose(identity, 1, SHARD_MANIFEST_HASH_1, shard);
        vm.warp(readyAt);
        vm.prank(GOVERNANCE_EXECUTOR);
        registry.activateRegistration(key);
        PackageQuoteShardRegistry.ShardReference memory exactRef = _reference(1, SHARD_MANIFEST_HASH_1, shard);

        vm.etch(address(shard), hex"00");
        vm.expectRevert(PackageQuoteShardRegistry.ShardCodeMismatch.selector);
        registry.validateEntry(exactRef);
    }

    function testVersionsAdvanceStrictlyAndStaleReferencesFail() public {
        PackageQuoteShard shard1 = _deployShard(identity);
        uint64 readyAt = _propose(identity, 1, SHARD_MANIFEST_HASH_1, shard1);
        vm.warp(readyAt);
        vm.prank(GOVERNANCE_EXECUTOR);
        registry.activateRegistration(key);
        PackageQuoteShardRegistry.ShardReference memory staleReference = _reference(1, SHARD_MANIFEST_HASH_1, shard1);

        vm.prank(PROPOSER);
        vm.expectRevert(
            abi.encodeWithSelector(
                PackageQuoteShardRegistry.ManifestVersionNotIncreasing.selector, uint32(1), uint32(1)
            )
        );
        registry.proposeRegistration(
            identity,
            1,
            SHARD_MANIFEST_HASH_1,
            address(shard1),
            address(shard1).codehash,
            address(consumer),
            address(consumer).codehash
        );

        PackageQuoteShard shard2 = _deployShard(identity);
        readyAt = _propose(identity, 2, SHARD_MANIFEST_HASH_2, shard2);
        vm.warp(readyAt);
        vm.prank(GOVERNANCE_EXECUTOR);
        registry.activateRegistration(key);

        vm.expectRevert(
            abi.encodeWithSelector(
                PackageQuoteShardRegistry.ShardReferenceMismatch.selector, staleReference.identityKey
            )
        );
        registry.validateEntry(staleReference);
        (,, bool firstIsCurrent) = registry.shardRecord(key, 1);
        (,, bool secondIsCurrent) = registry.shardRecord(key, 2);
        assertFalse(firstIsCurrent);
        assertTrue(secondIsCurrent);
    }

    function testImmediatePauseBlocksAdmissionAndDelayedRelaxationRestoresIt() public {
        PackageQuoteShard shard = _deployShard(identity);
        uint64 readyAt = _propose(identity, 1, SHARD_MANIFEST_HASH_1, shard);
        vm.warp(readyAt);
        vm.prank(GOVERNANCE_EXECUTOR);
        registry.activateRegistration(key);
        PackageQuoteShardRegistry.ShardReference memory exactRef = _reference(1, SHARD_MANIFEST_HASH_1, shard);

        vm.prank(PAUSER);
        registry.tightenLifecycle(key, PackageQuoteShardRegistry.Lifecycle.ENTRY_PAUSED);
        vm.expectRevert(
            abi.encodeWithSelector(
                PackageQuoteShardRegistry.EntryNotAllowed.selector,
                key,
                PackageQuoteShardRegistry.Lifecycle.ENTRY_PAUSED
            )
        );
        registry.validateEntry(exactRef);

        vm.prank(PROPOSER);
        registry.proposeLifecycle(key, PackageQuoteShardRegistry.Lifecycle.ACTIVE);
        vm.prank(PAUSER);
        registry.tightenLifecycle(key, PackageQuoteShardRegistry.Lifecycle.ENTRY_PAUSED);
        assertFalse(registry.pendingLifecycle(key).exists);

        vm.prank(PROPOSER);
        registry.proposeLifecycle(key, PackageQuoteShardRegistry.Lifecycle.ACTIVE);
        readyAt = uint64(block.timestamp) + DELAY;
        vm.warp(readyAt - 1);
        vm.prank(GOVERNANCE_EXECUTOR);
        vm.expectRevert(abi.encodeWithSelector(PackageQuoteShardRegistry.LifecycleProposalNotReady.selector, readyAt));
        registry.activateLifecycle(key);

        vm.warp(readyAt);
        vm.prank(GOVERNANCE_EXECUTOR);
        registry.activateLifecycle(key);
        assertEq(registry.validateEntry(exactRef).shard, address(shard));

        vm.prank(PAUSER);
        registry.tightenLifecycle(key, PackageQuoteShardRegistry.Lifecycle.DEPRECATED);
        vm.prank(PROPOSER);
        vm.expectRevert(PackageQuoteShardRegistry.InvalidLifecycleRelaxation.selector);
        registry.proposeLifecycle(key, PackageQuoteShardRegistry.Lifecycle.ACTIVE);
    }

    function testDomainRotationRetiresRecordsUntilReregisteredUnderTheActiveDomain() public {
        PackageQuoteShard shard1 = _deployShard(identity);
        uint64 readyAt = _propose(identity, 1, SHARD_MANIFEST_HASH_1, shard1);
        vm.warp(readyAt);
        vm.prank(GOVERNANCE_EXECUTOR);
        registry.activateRegistration(key);
        PackageQuoteShardRegistry.ShardReference memory firstReference = _reference(1, SHARD_MANIFEST_HASH_1, shard1);
        _propose(identity, 2, SHARD_MANIFEST_HASH_2, _deployShard(identity));

        bytes32 rotatedDomainHash = keccak256("domain-manifest-2");
        vm.prank(PROPOSER);
        config.proposeDomain(2, rotatedDomainHash);
        vm.warp(block.timestamp + DELAY);
        vm.prank(GOVERNANCE_EXECUTOR);
        config.activateDomain();

        vm.expectRevert(PackageQuoteShardRegistry.DomainChanged.selector);
        registry.validateEntry(firstReference);
        vm.prank(GOVERNANCE_EXECUTOR);
        vm.expectRevert(PackageQuoteShardRegistry.DomainChanged.selector);
        registry.activateRegistration(key);

        vm.prank(CANCELLER);
        registry.cancelRegistration(key);
        bytes32 thirdManifestHash = keccak256("shard-manifest-3");
        PackageQuoteShard shard3 = _deployShard(identity);
        readyAt = _propose(identity, 3, thirdManifestHash, shard3);
        vm.warp(readyAt);
        vm.prank(GOVERNANCE_EXECUTOR);
        registry.activateRegistration(key);

        assertEq(registry.validateEntry(_reference(3, thirdManifestHash, shard3)).shard, address(shard3));
        PackageQuoteShardRegistry.DomainPin memory pinned = registry.recordDomain(key, 3);
        assertEq(pinned.manifestVersion, 2);
        assertEq(pinned.manifestHash, rotatedDomainHash);
    }

    function _deployShard(PackageQuoteShardRegistry.ShardIdentity memory shardIdentity)
        private
        returns (PackageQuoteShard)
    {
        return new PackageQuoteShard(
            PackageQuoteShard.Deployment({
                chainId: block.chainid,
                config: address(config),
                configCodeHash: address(config).codehash,
                solver: shardIdentity.solver,
                consumer: address(consumer),
                consumerCodeHash: address(consumer).codehash,
                seriesManifestHash: shardIdentity.seriesManifestHash,
                executionClassManifestHash: shardIdentity.executionClassManifestHash
            }),
            PackageQuoteShard.Limits({maxHeartbeatSeconds: 300, maxBatchSize: 16, maxLevelCount: 128})
        );
    }

    function _propose(
        PackageQuoteShardRegistry.ShardIdentity memory shardIdentity,
        uint32 manifestVersion,
        bytes32 manifestHash,
        PackageQuoteShard shard
    ) private returns (uint64 readyAt) {
        vm.prank(PROPOSER);
        registry.proposeRegistration(
            shardIdentity,
            manifestVersion,
            manifestHash,
            address(shard),
            address(shard).codehash,
            address(consumer),
            address(consumer).codehash
        );
        return uint64(block.timestamp) + DELAY;
    }

    function _reference(uint32 manifestVersion, bytes32 manifestHash, PackageQuoteShard shard)
        private
        view
        returns (PackageQuoteShardRegistry.ShardReference memory)
    {
        return PackageQuoteShardRegistry.ShardReference({
            identityKey: key,
            manifestVersion: manifestVersion,
            manifestHash: manifestHash,
            shard: address(shard),
            shardCodeHash: address(shard).codehash,
            consumer: address(consumer),
            consumerCodeHash: address(consumer).codehash
        });
    }
}

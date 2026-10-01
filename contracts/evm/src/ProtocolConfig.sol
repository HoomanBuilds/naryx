// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

contract ProtocolConfig {
    uint16 private constant CONFIG_VERSION = 1;
    uint256 private constant MAX_DOMAIN_ID_BYTES = 128;

    struct PendingDomain {
        uint32 manifestVersion;
        bytes32 manifestHash;
        uint64 activationTimestamp;
    }

    struct PendingTemplate {
        bytes32 manifestHash;
        uint64 activationTimestamp;
    }

    error DomainIdEmpty();
    error DomainIdTooLong();
    error DomainIdNotAscii();
    error DomainManifestVersionZero();
    error DomainManifestHashZero();
    error ConfigDelayZero();
    error GovernanceRoleZero();
    error GovernanceRoleDuplicate();
    error UnauthorizedRole(address caller, address requiredRole);
    error ActivationTimestampOverflow();
    error DomainProposalExists();
    error DomainProposalMissing();
    error DomainManifestVersionNotIncreasing(uint32 activeVersion, uint32 proposedVersion);
    error DomainProposalNotReady(uint64 activationTimestamp);
    error EntryAlreadyPaused();
    error EntryNotPaused();
    error UnpauseAlreadyScheduled();
    error UnpauseNotScheduled();
    error UnpauseNotReady(uint64 activationTimestamp);
    error TemplateManifestHashZero();
    error TemplateManifestHashUsed(bytes32 manifestHash);
    error TemplateProposalExists();
    error TemplateProposalMissing();
    error TemplateProposalNotReady(uint64 activationTimestamp);

    event ProtocolConfigInitialized(
        address indexed actor,
        string domainId,
        uint32 manifestVersion,
        bytes32 manifestHash,
        uint64 configDelaySeconds,
        address proposer,
        address canceller,
        address executor,
        address pauser
    );
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
    event CashCarryTemplateProposed(
        address indexed actor, bytes32 previousHash, bytes32 proposedHash, uint64 activationTimestamp
    );
    event CashCarryTemplateProposalCancelled(
        address indexed actor, bytes32 activeHash, bytes32 cancelledHash, uint64 activationTimestamp
    );
    event CashCarryTemplateActivated(address indexed actor, bytes32 previousHash, bytes32 newHash);
    event EntryPaused(address indexed actor);
    event UnpauseScheduled(address indexed actor, uint64 activationTimestamp);
    event UnpauseCancelled(address indexed actor, uint64 activationTimestamp);
    event EntryUnpaused(address indexed actor);

    string private _domainId;
    uint32 private _domainManifestVersion;
    bytes32 private _domainManifestHash;
    PendingDomain private _pendingDomain;
    bool private _hasPendingDomain;
    bool private _entryPaused;
    uint64 private _pendingUnpauseTimestamp;
    /// The active cash-and-carry template manifest hash. It is governed storage rather than a constructor
    /// argument because the template manifest commits to the reviewed domain manifest, which commits to the
    /// execution verifier code hash, which in turn pins the registries' code hashes. It starts unset, so every
    /// template-bound registration and admission fails closed until the first delayed activation.
    bytes32 private _cashCarryTemplateManifestHash;
    PendingTemplate private _pendingTemplate;
    mapping(bytes32 manifestHash => bool used) private _usedTemplateManifestHashes;

    address private immutable _PROPOSER;
    address private immutable _CANCELLER;
    address private immutable _EXECUTOR;
    address private immutable _PAUSER;
    uint64 private immutable _CONFIG_DELAY_SECONDS;

    modifier onlyProposer() {
        _checkRole(_PROPOSER);
        _;
    }

    modifier onlyCanceller() {
        _checkRole(_CANCELLER);
        _;
    }

    modifier onlyExecutor() {
        _checkRole(_EXECUTOR);
        _;
    }

    modifier onlyPauser() {
        _checkRole(_PAUSER);
        _;
    }

    constructor(
        string memory domainId_,
        uint32 domainManifestVersion_,
        bytes32 domainManifestHash_,
        uint64 configDelaySeconds_,
        address proposer_,
        address canceller_,
        address executor_,
        address pauser_
    ) {
        _validateDomainId(domainId_);
        if (domainManifestVersion_ == 0) revert DomainManifestVersionZero();
        if (domainManifestHash_ == bytes32(0)) revert DomainManifestHashZero();
        if (configDelaySeconds_ == 0) revert ConfigDelayZero();
        _validateRoles(proposer_, canceller_, executor_, pauser_);

        _domainId = domainId_;
        _domainManifestVersion = domainManifestVersion_;
        _domainManifestHash = domainManifestHash_;
        _CONFIG_DELAY_SECONDS = configDelaySeconds_;
        _PROPOSER = proposer_;
        _CANCELLER = canceller_;
        _EXECUTOR = executor_;
        _PAUSER = pauser_;
        _entryPaused = true;

        emit ProtocolConfigInitialized(
            msg.sender,
            domainId_,
            domainManifestVersion_,
            domainManifestHash_,
            configDelaySeconds_,
            proposer_,
            canceller_,
            executor_,
            pauser_
        );
    }

    function configVersion() external pure returns (uint16) {
        return CONFIG_VERSION;
    }

    function domain() external view returns (string memory domainId_, uint32 manifestVersion, bytes32 manifestHash) {
        return (_domainId, _domainManifestVersion, _domainManifestHash);
    }

    function pendingDomain()
        external
        view
        returns (bool exists, uint32 manifestVersion, bytes32 manifestHash, uint64 activationTimestamp)
    {
        PendingDomain memory pending = _pendingDomain;
        return (_hasPendingDomain, pending.manifestVersion, pending.manifestHash, pending.activationTimestamp);
    }

    function cashCarryTemplateManifestHash() external view returns (bytes32) {
        return _cashCarryTemplateManifestHash;
    }

    function pendingCashCarryTemplate()
        external
        view
        returns (bool exists, bytes32 manifestHash, uint64 activationTimestamp)
    {
        PendingTemplate memory pending = _pendingTemplate;
        return (pending.activationTimestamp != 0, pending.manifestHash, pending.activationTimestamp);
    }

    function roles() external view returns (address proposer, address canceller, address executor, address pauser) {
        return (_PROPOSER, _CANCELLER, _EXECUTOR, _PAUSER);
    }

    function configDelaySeconds() external view returns (uint64) {
        return _CONFIG_DELAY_SECONDS;
    }

    function entryPaused() external view returns (bool) {
        return _entryPaused;
    }

    function pendingUnpause() external view returns (bool exists, uint64 activationTimestamp) {
        uint64 timestamp = _pendingUnpauseTimestamp;
        return (timestamp != 0, timestamp);
    }

    function proposeDomain(uint32 manifestVersion, bytes32 manifestHash) external onlyProposer {
        if (_hasPendingDomain) revert DomainProposalExists();
        if (manifestVersion <= _domainManifestVersion) {
            revert DomainManifestVersionNotIncreasing(_domainManifestVersion, manifestVersion);
        }
        if (manifestHash == bytes32(0)) revert DomainManifestHashZero();

        uint64 activationTimestamp = _activationTimestamp();
        _pendingDomain = PendingDomain({
            manifestVersion: manifestVersion, manifestHash: manifestHash, activationTimestamp: activationTimestamp
        });
        _hasPendingDomain = true;

        emit DomainProposed(
            msg.sender, _domainManifestVersion, _domainManifestHash, manifestVersion, manifestHash, activationTimestamp
        );
    }

    function cancelDomainProposal() external onlyCanceller {
        if (!_hasPendingDomain) revert DomainProposalMissing();

        PendingDomain memory pending = _pendingDomain;
        delete _pendingDomain;
        _hasPendingDomain = false;

        emit DomainProposalCancelled(
            msg.sender,
            _domainManifestVersion,
            _domainManifestHash,
            pending.manifestVersion,
            pending.manifestHash,
            pending.activationTimestamp
        );
    }

    function activateDomain() external onlyExecutor {
        if (!_hasPendingDomain) revert DomainProposalMissing();

        PendingDomain memory pending = _pendingDomain;
        if (block.timestamp < pending.activationTimestamp) {
            revert DomainProposalNotReady(pending.activationTimestamp);
        }

        uint32 previousVersion = _domainManifestVersion;
        bytes32 previousHash = _domainManifestHash;
        _domainManifestVersion = pending.manifestVersion;
        _domainManifestHash = pending.manifestHash;
        delete _pendingDomain;
        _hasPendingDomain = false;

        emit DomainActivated(msg.sender, previousVersion, previousHash, pending.manifestVersion, pending.manifestHash);
    }

    /// @notice Proposes the cash-and-carry template manifest hash. Only while entry is paused; a hash that was
    /// ever active is never accepted again, so records registered under a retired template cannot revive.
    function proposeCashCarryTemplate(bytes32 manifestHash) external onlyProposer {
        if (!_entryPaused) revert EntryNotPaused();
        if (_pendingTemplate.activationTimestamp != 0) revert TemplateProposalExists();
        if (manifestHash == bytes32(0)) revert TemplateManifestHashZero();
        if (_usedTemplateManifestHashes[manifestHash]) revert TemplateManifestHashUsed(manifestHash);

        uint64 activationTimestamp = _activationTimestamp();
        _pendingTemplate = PendingTemplate({manifestHash: manifestHash, activationTimestamp: activationTimestamp});
        emit CashCarryTemplateProposed(msg.sender, _cashCarryTemplateManifestHash, manifestHash, activationTimestamp);
    }

    function cancelCashCarryTemplateProposal() external onlyCanceller {
        PendingTemplate memory pending = _pendingTemplate;
        if (pending.activationTimestamp == 0) revert TemplateProposalMissing();
        delete _pendingTemplate;
        emit CashCarryTemplateProposalCancelled(
            msg.sender, _cashCarryTemplateManifestHash, pending.manifestHash, pending.activationTimestamp
        );
    }

    /// @notice Activates the pending template only while entry is paused. Every registry compares its records
    /// with the active hash, so records bound to the previous template stop validating.
    function activateCashCarryTemplate() external onlyExecutor {
        PendingTemplate memory pending = _pendingTemplate;
        if (pending.activationTimestamp == 0) revert TemplateProposalMissing();
        if (block.timestamp < pending.activationTimestamp) {
            revert TemplateProposalNotReady(pending.activationTimestamp);
        }
        if (!_entryPaused) revert EntryNotPaused();

        bytes32 previousHash = _cashCarryTemplateManifestHash;
        _cashCarryTemplateManifestHash = pending.manifestHash;
        _usedTemplateManifestHashes[pending.manifestHash] = true;
        delete _pendingTemplate;
        emit CashCarryTemplateActivated(msg.sender, previousHash, pending.manifestHash);
    }

    function pauseEntry() external onlyPauser {
        uint64 pendingTimestamp = _pendingUnpauseTimestamp;
        if (_entryPaused && pendingTimestamp == 0) revert EntryAlreadyPaused();

        _entryPaused = true;
        if (pendingTimestamp != 0) {
            _pendingUnpauseTimestamp = 0;
            emit UnpauseCancelled(msg.sender, pendingTimestamp);
        }
        emit EntryPaused(msg.sender);
    }

    function scheduleUnpause() external onlyProposer {
        if (!_entryPaused) revert EntryNotPaused();
        if (_pendingUnpauseTimestamp != 0) revert UnpauseAlreadyScheduled();

        uint64 activationTimestamp = _activationTimestamp();
        _pendingUnpauseTimestamp = activationTimestamp;
        emit UnpauseScheduled(msg.sender, activationTimestamp);
    }

    function cancelUnpause() external onlyCanceller {
        uint64 activationTimestamp = _pendingUnpauseTimestamp;
        if (activationTimestamp == 0) revert UnpauseNotScheduled();

        _pendingUnpauseTimestamp = 0;
        emit UnpauseCancelled(msg.sender, activationTimestamp);
    }

    function activateUnpause() external onlyExecutor {
        uint64 activationTimestamp = _pendingUnpauseTimestamp;
        if (activationTimestamp == 0) revert UnpauseNotScheduled();
        if (block.timestamp < activationTimestamp) revert UnpauseNotReady(activationTimestamp);

        _entryPaused = false;
        _pendingUnpauseTimestamp = 0;
        emit EntryUnpaused(msg.sender);
    }

    function _activationTimestamp() private view returns (uint64) {
        if (block.timestamp > uint256(type(uint64).max) - uint256(_CONFIG_DELAY_SECONDS)) {
            revert ActivationTimestampOverflow();
        }
        return uint64(block.timestamp) + _CONFIG_DELAY_SECONDS;
    }

    function _checkRole(address requiredRole) private view {
        if (msg.sender != requiredRole) revert UnauthorizedRole(msg.sender, requiredRole);
    }

    function _validateDomainId(string memory domainId_) private pure {
        bytes memory value = bytes(domainId_);
        if (value.length == 0) revert DomainIdEmpty();
        if (value.length > MAX_DOMAIN_ID_BYTES) revert DomainIdTooLong();
        for (uint256 i; i < value.length; ++i) {
            if (uint8(value[i]) > 0x7f) revert DomainIdNotAscii();
        }
    }

    function _validateRoles(address proposer_, address canceller_, address executor_, address pauser_) private pure {
        address[4] memory roleAddresses = [proposer_, canceller_, executor_, pauser_];
        for (uint256 i; i < roleAddresses.length; ++i) {
            if (roleAddresses[i] == address(0)) revert GovernanceRoleZero();
            for (uint256 j; j < i; ++j) {
                if (roleAddresses[i] == roleAddresses[j]) revert GovernanceRoleDuplicate();
            }
        }
    }
}

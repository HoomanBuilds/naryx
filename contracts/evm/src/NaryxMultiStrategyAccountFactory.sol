// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Create2} from "openzeppelin-contracts/utils/Create2.sol";
import {NaryxMultiStrategyAccount} from "./NaryxMultiStrategyAccount.sol";
import {ProtocolConfig} from "./ProtocolConfig.sol";
import {SolverRegistry} from "./SolverRegistry.sol";
import {StrategyFeePolicyRegistry} from "./StrategyFeePolicyRegistry.sol";
import {TypedStrategyAdapterRegistry} from "./TypedStrategyAdapterRegistry.sol";
import {INaryxMultiStrategyAccountFactory} from "./interfaces/INaryxMultiStrategyAccountFactory.sol";

contract NaryxMultiStrategyAccountFactory is INaryxMultiStrategyAccountFactory {
    ProtocolConfig public immutable config;
    SolverRegistry public immutable solverRegistry;
    TypedStrategyAdapterRegistry public immutable adapterRegistry;
    StrategyFeePolicyRegistry public immutable feePolicyRegistry;
    bytes32 public immutable feePolicySubjectId;
    uint256 public immutable deploymentChainId;
    bytes32 public immutable configCodeHash;
    bytes32 public immutable solverRegistryCodeHash;
    bytes32 public immutable adapterRegistryCodeHash;
    bytes32 public immutable feePolicyRegistryCodeHash;
    address public immutable referenceAccount;
    bytes32 public immutable override accountCodeHash;

    mapping(address account => bool recognized) public override isAccount;

    error InvalidConfiguration();
    error InvalidOwner();
    error AccountCodeMismatch();

    event AccountCreated(address indexed owner, address indexed account);

    constructor(
        ProtocolConfig config_,
        SolverRegistry solverRegistry_,
        TypedStrategyAdapterRegistry adapterRegistry_,
        StrategyFeePolicyRegistry feePolicyRegistry_,
        bytes32 feePolicySubjectId_
    ) {
        if (
            address(config_).code.length == 0 || address(solverRegistry_).code.length == 0
                || address(adapterRegistry_).code.length == 0 || address(feePolicyRegistry_).code.length == 0
                || feePolicySubjectId_ == bytes32(0) || address(solverRegistry_.config()) != address(config_)
                || address(adapterRegistry_.config()) != address(config_)
                || address(feePolicyRegistry_.config()) != address(config_)
        ) revert InvalidConfiguration();

        config = config_;
        solverRegistry = solverRegistry_;
        adapterRegistry = adapterRegistry_;
        feePolicyRegistry = feePolicyRegistry_;
        feePolicySubjectId = feePolicySubjectId_;
        deploymentChainId = block.chainid;
        configCodeHash = address(config_).codehash;
        solverRegistryCodeHash = address(solverRegistry_).codehash;
        adapterRegistryCodeHash = address(adapterRegistry_).codehash;
        feePolicyRegistryCodeHash = address(feePolicyRegistry_).codehash;

        address referenceAccount_ = address(
            new NaryxMultiStrategyAccount(
                address(this), config_, solverRegistry_, adapterRegistry_, feePolicyRegistry_, feePolicySubjectId_
            )
        );
        referenceAccount = referenceAccount_;
        accountCodeHash = referenceAccount_.codehash;
    }

    function accountOf(address owner) public view returns (address) {
        return Create2.computeAddress(
            _salt(owner),
            keccak256(
                abi.encodePacked(
                    type(NaryxMultiStrategyAccount).creationCode,
                    abi.encode(owner, config, solverRegistry, adapterRegistry, feePolicyRegistry, feePolicySubjectId)
                )
            )
        );
    }

    function create(address owner) external returns (NaryxMultiStrategyAccount account) {
        if (owner == address(0) || owner == address(this)) revert InvalidOwner();
        _requireConfiguration();
        address predicted = accountOf(owner);
        if (predicted.code.length == 0) {
            address created = address(
                new NaryxMultiStrategyAccount{salt: _salt(owner)}(
                    owner, config, solverRegistry, adapterRegistry, feePolicyRegistry, feePolicySubjectId
                )
            );
            if (created != predicted || created.codehash != accountCodeHash) revert AccountCodeMismatch();
            isAccount[created] = true;
            emit AccountCreated(owner, created);
        }
        if (!isAccount[predicted] || predicted.codehash != accountCodeHash) revert AccountCodeMismatch();
        return NaryxMultiStrategyAccount(predicted);
    }

    function _requireConfiguration() private view {
        if (
            block.chainid != deploymentChainId || address(config).codehash != configCodeHash
                || address(solverRegistry).codehash != solverRegistryCodeHash
                || address(adapterRegistry).codehash != adapterRegistryCodeHash
                || address(feePolicyRegistry).codehash != feePolicyRegistryCodeHash
        ) revert InvalidConfiguration();
    }

    function _salt(address owner) private pure returns (bytes32) {
        return keccak256(abi.encode(owner));
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Create2} from "openzeppelin-contracts/utils/Create2.sol";
import {NaryxStrategyAccount} from "./NaryxStrategyAccount.sol";
import {PackageVerifier} from "./PackageVerifier.sol";

/// @notice Deploys one `NaryxStrategyAccount` per owner at a CREATE2 address derived from the owner, bound
/// to one verifier. Accounts differ only in storage, so every account shares `accountCodeHash`, read at
/// construction from an inert reference account the factory owns and can never act for.
contract NaryxStrategyAccountFactory {
    PackageVerifier public immutable verifier;
    bytes32 public immutable verifierCodeHash;
    uint256 public immutable deploymentChainId;
    address public immutable referenceAccount;
    bytes32 public immutable accountCodeHash;

    error InvalidConfiguration();
    error InvalidOwner();
    error AccountCodeMismatch();

    event AccountCreated(address indexed owner, address indexed account);

    constructor(PackageVerifier verifier_) {
        if (address(verifier_).code.length == 0) revert InvalidConfiguration();
        verifier = verifier_;
        verifierCodeHash = address(verifier_).codehash;
        deploymentChainId = block.chainid;
        address account = address(new NaryxStrategyAccount(address(this), verifier_));
        referenceAccount = account;
        accountCodeHash = account.codehash;
    }

    /// @notice The account created, or to be created, for `owner`. A novated account keeps this address
    /// under its new owner.
    function accountOf(address owner) public view returns (address) {
        return Create2.computeAddress(
            _salt(owner),
            keccak256(abi.encodePacked(type(NaryxStrategyAccount).creationCode, abi.encode(owner, verifier)))
        );
    }

    /// @notice Permissionless and idempotent: returns the existing account when it is already deployed.
    function create(address owner) external returns (NaryxStrategyAccount account) {
        if (owner == address(0) || owner == address(this)) revert InvalidOwner();
        if (block.chainid != deploymentChainId || address(verifier).codehash != verifierCodeHash) {
            revert InvalidConfiguration();
        }
        address predicted = accountOf(owner);
        if (predicted.code.length == 0) {
            address created = address(new NaryxStrategyAccount{salt: _salt(owner)}(owner, verifier));
            if (created != predicted) revert AccountCodeMismatch();
            emit AccountCreated(owner, created);
        }
        if (predicted.codehash != accountCodeHash) revert AccountCodeMismatch();
        return NaryxStrategyAccount(predicted);
    }

    function _salt(address owner) private pure returns (bytes32) {
        return keccak256(abi.encode(owner));
    }
}

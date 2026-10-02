// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {ECDSA} from "openzeppelin-contracts/utils/cryptography/ECDSA.sol";
import {SignatureChecker} from "openzeppelin-contracts/utils/cryptography/SignatureChecker.sol";

/// @notice Owner or trader authority over an exact digest. The owner's own ECDSA key is tried first, so an EOA
/// that carries an EIP-7702 delegation, and therefore has code, still signs with its key. Only an owner with code
/// then falls back to ERC-1271, through a static call that copies at most one return word and cannot revert the
/// caller. A contract has no private key, so recovery never yields a contract owner's address.
library OwnerSignature {
    function isValidNow(address owner, bytes32 hash, bytes memory signature) internal view returns (bool) {
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(hash, signature);
        if (err == ECDSA.RecoverError.NoError && recovered == owner) return true;
        return owner.code.length != 0 && SignatureChecker.isValidERC1271SignatureNow(owner, hash, signature);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {IERC1271} from "openzeppelin-contracts/interfaces/IERC1271.sol";
import {ECDSA} from "openzeppelin-contracts/utils/cryptography/ECDSA.sol";
import {SignatureChecker} from "openzeppelin-contracts/utils/cryptography/SignatureChecker.sol";
import {OwnerSignature} from "../src/libraries/OwnerSignature.sol";

contract OwnerSignatureHarness {
    function isValidNow(address owner, bytes32 hash, bytes calldata signature) external view returns (bool) {
        return OwnerSignature.isValidNow(owner, hash, signature);
    }
}

/// An EIP-7702 delegate with no ERC-1271 entry point, as many wallet delegates are for raw digests.
contract Eip7702Delegate {
    receive() external payable {}
}

/// A contract owner that approves exactly one signer's ECDSA signature through ERC-1271.
contract Erc1271SignerOwner is IERC1271 {
    address public immutable signer;

    constructor(address signer_) {
        signer = signer_;
    }

    function isValidSignature(bytes32 hash, bytes memory signature) external view returns (bytes4) {
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(hash, signature);
        return err == ECDSA.RecoverError.NoError && recovered == signer
            ? IERC1271.isValidSignature.selector
            : bytes4(0xffffffff);
    }
}

contract WrongMagicSignatureOwner {
    function isValidSignature(bytes32, bytes memory) external pure returns (bytes4) {
        return 0xdeadbeef;
    }
}

contract RevertingSignatureOwner {
    function isValidSignature(bytes32, bytes memory) external pure returns (bytes4) {
        revert("rejected");
    }
}

contract OwnerSignatureTest is Test {
    uint256 private constant SECP256K1_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
    uint256 private constant OWNER_KEY = 0xA11CE;
    uint256 private constant SIGNER_KEY = 0x5161E;
    bytes32 private constant DIGEST = keccak256("owner-signature-digest");

    OwnerSignatureHarness private harness;
    Eip7702Delegate private delegate;

    function setUp() public {
        harness = new OwnerSignatureHarness();
        delegate = new Eip7702Delegate();
    }

    function testFuzzOnlyTheOwnersKeyValidatesWithOrWithoutDelegation(
        uint256 ownerKey,
        uint256 otherKey,
        bytes32 digest,
        bool delegated
    ) public {
        ownerKey = bound(ownerKey, 1, SECP256K1_N - 1);
        otherKey = bound(otherKey, 1, SECP256K1_N - 1);
        vm.assume(ownerKey != otherKey);
        address owner = vm.addr(ownerKey);
        if (delegated) vm.signAndAttachDelegation(address(delegate), ownerKey);

        assertTrue(harness.isValidNow(owner, digest, _signature(ownerKey, digest)));
        assertEq(owner.code.length, delegated ? 23 : 0);
        assertFalse(harness.isValidNow(owner, digest, _signature(otherKey, digest)));
    }

    function testDelegatedEoaOwnerSignsWithItsKeyWhereCodeFirstCheckingFails() public {
        address owner = vm.addr(OWNER_KEY);
        bytes memory signature = _signature(OWNER_KEY, DIGEST);
        vm.signAndAttachDelegation(address(delegate), OWNER_KEY);

        assertTrue(harness.isValidNow(owner, DIGEST, signature));
        assertEq(owner.code, abi.encodePacked(hex"ef0100", address(delegate)));
        assertFalse(SignatureChecker.isValidSignatureNow(owner, DIGEST, signature), "the reported rejection");
    }

    function testDelegatedEoaOwnerAlsoAcceptsItsDelegatesErc1271Signer() public {
        address owner = vm.addr(OWNER_KEY);
        vm.signAndAttachDelegation(address(new Erc1271SignerOwner(vm.addr(SIGNER_KEY))), OWNER_KEY);

        assertTrue(harness.isValidNow(owner, DIGEST, _signature(OWNER_KEY, DIGEST)));
        assertTrue(harness.isValidNow(owner, DIGEST, _signature(SIGNER_KEY, DIGEST)));
        assertFalse(harness.isValidNow(owner, DIGEST, _signature(0xBAD, DIGEST)));
    }

    function testContractOwnerFollowsErc1271AndRejectsWrongMagicAndRevert() public {
        address wallet = address(new Erc1271SignerOwner(vm.addr(SIGNER_KEY)));
        assertTrue(harness.isValidNow(wallet, DIGEST, _signature(SIGNER_KEY, DIGEST)));
        assertFalse(harness.isValidNow(wallet, DIGEST, _signature(OWNER_KEY, DIGEST)));
        assertFalse(harness.isValidNow(address(new WrongMagicSignatureOwner()), DIGEST, _signature(OWNER_KEY, DIGEST)));
        assertFalse(harness.isValidNow(address(new RevertingSignatureOwner()), DIGEST, _signature(OWNER_KEY, DIGEST)));
    }

    function testRejectsZeroOwnerMalleableAndCompactSignatures() public view {
        address owner = vm.addr(OWNER_KEY);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OWNER_KEY, DIGEST);
        bytes memory highS = abi.encodePacked(r, bytes32(SECP256K1_N - uint256(s)), v == 27 ? uint8(28) : uint8(27));
        bytes memory compact = abi.encodePacked(r, bytes32(uint256(s) | (uint256(v - 27) << 255)));

        assertEq(ecrecover(DIGEST, v == 27 ? 28 : 27, r, bytes32(SECP256K1_N - uint256(s))), owner);
        assertFalse(harness.isValidNow(owner, DIGEST, highS));
        assertFalse(harness.isValidNow(owner, DIGEST, compact));
        assertFalse(harness.isValidNow(address(0), DIGEST, abi.encodePacked(r, s, uint8(0))));
    }

    function _signature(uint256 key, bytes32 digest) private pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

interface IPackageCollateralAdapter {
    function manageCollateral(bytes calldata payload) external returns (bytes32 evidenceHash, uint256 outputAtoms);
}

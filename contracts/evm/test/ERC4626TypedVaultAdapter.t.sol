// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "openzeppelin-contracts/token/ERC20/ERC20.sol";
import {IERC20} from "openzeppelin-contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/token/ERC20/utils/SafeERC20.sol";
import {ERC4626Mock} from "openzeppelin-contracts/mocks/token/ERC4626Mock.sol";
import {ERC4626TypedVaultAdapter} from "../src/ERC4626TypedVaultAdapter.sol";
import {ITypedStrategyAdapter} from "../src/interfaces/ITypedStrategyAdapter.sol";

contract VaultAdapterAsset is ERC20 {
    constructor() ERC20("Asset", "ASSET") {}

    function mint(address recipient, uint256 amount) external {
        _mint(recipient, amount);
    }
}

contract VaultAdapterAccount {
    using SafeERC20 for IERC20;

    function execute(ITypedStrategyAdapter adapter, IERC20 token, uint256 approvalAtoms, bytes calldata payload)
        external
        returns (bytes32)
    {
        token.forceApprove(address(adapter), approvalAtoms);
        bytes32 evidence = adapter.executeLeg(payload);
        token.forceApprove(address(adapter), 0);
        return evidence;
    }
}

contract ERC4626TypedVaultAdapterTest is Test {
    bytes32 private constant PACKAGE_ID = keccak256("package");
    bytes32 private constant ORDER_HASH = keccak256("order");
    bytes32 private constant QUOTE_HASH = keccak256("quote");
    bytes32 private constant ROUTE_HASH = keccak256("route");

    VaultAdapterAsset private asset;
    ERC4626Mock private vault;
    VaultAdapterAccount private account;
    ERC4626TypedVaultAdapter private adapter;

    function setUp() public {
        asset = new VaultAdapterAsset();
        vault = new ERC4626Mock(address(asset));
        account = new VaultAdapterAccount();
        adapter = new ERC4626TypedVaultAdapter(
            ERC4626TypedVaultAdapter.Deployment({
                chainId: block.chainid,
                strategyAccount: address(account),
                packageId: PACKAGE_ID,
                vault: vault,
                assetToken: asset,
                strategyAccountCodeHash: address(account).codehash,
                vaultCodeHash: address(vault).codehash,
                assetTokenCodeHash: address(asset).codehash
            })
        );
        asset.mint(address(account), 100 ether);
    }

    function testDepositsAndRedeemsWithExactBalancePostconditions() public {
        bytes32 depositEvidence = account.execute(adapter, asset, 10 ether, _leg(1, 10 ether, 10 ether, 10 ether));
        assertNotEq(depositEvidence, bytes32(0));
        assertEq(asset.balanceOf(address(account)), 90 ether);
        assertEq(vault.balanceOf(address(account)), 10 ether);

        bytes32 redeemEvidence = account.execute(
            adapter, IERC20(address(vault)), 10 ether, _leg(2, 10 ether, 10 ether, 10 ether)
        );
        assertNotEq(redeemEvidence, bytes32(0));
        assertEq(asset.balanceOf(address(account)), 100 ether);
        assertEq(vault.balanceOf(address(account)), 0);
        assertEq(asset.balanceOf(address(adapter)), 0);
        assertEq(vault.balanceOf(address(adapter)), 0);
    }

    function testRejectsOutputOutsideTheSignedRange() public {
        vm.expectRevert(ERC4626TypedVaultAdapter.PostconditionFailed.selector);
        account.execute(adapter, asset, 10 ether, _leg(1, 10 ether, 11 ether, 12 ether));
        assertEq(asset.balanceOf(address(account)), 100 ether);
        assertEq(vault.balanceOf(address(account)), 0);
    }

    function _leg(uint8 action, uint256 inputAtoms, uint256 minimumOutputAtoms, uint256 maximumOutputAtoms)
        private
        pure
        returns (bytes memory)
    {
        return abi.encode(
            ERC4626TypedVaultAdapter.ExactVaultLeg({
                packageId: PACKAGE_ID,
                orderHash: ORDER_HASH,
                quoteHash: QUOTE_HASH,
                routeHash: ROUTE_HASH,
                action: action,
                inputAtoms: inputAtoms,
                minimumOutputAtoms: minimumOutputAtoms,
                maximumOutputAtoms: maximumOutputAtoms
            })
        );
    }
}

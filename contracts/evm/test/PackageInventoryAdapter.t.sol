// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "openzeppelin-contracts/token/ERC20/ERC20.sol";
import {IERC20} from "openzeppelin-contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/token/ERC20/utils/SafeERC20.sol";
import {PackageInventoryAdapter} from "../src/PackageInventoryAdapter.sol";
import {ITypedStrategyAdapter} from "../src/interfaces/ITypedStrategyAdapter.sol";

contract InventoryAdapterToken is ERC20 {
    constructor() ERC20("Inventory", "INV") {}

    function mint(address recipient, uint256 amount) external {
        _mint(recipient, amount);
    }
}

contract InventoryAdapterAccount {
    using SafeERC20 for IERC20;

    function execute(ITypedStrategyAdapter adapter, IERC20 token, uint256 approvalAtoms, bytes calldata payload)
        external
        returns (bytes32)
    {
        if (approvalAtoms != 0) token.forceApprove(address(adapter), approvalAtoms);
        bytes32 evidence = adapter.executeLeg(payload);
        if (approvalAtoms != 0) token.forceApprove(address(adapter), 0);
        return evidence;
    }
}

contract PackageInventoryAdapterTest is Test {
    bytes32 private constant PACKAGE_ID = keccak256("package");
    bytes32 private constant ORDER_HASH = keccak256("order");
    bytes32 private constant QUOTE_HASH = keccak256("quote");
    bytes32 private constant ROUTE_HASH = keccak256("route");

    InventoryAdapterToken private token;
    InventoryAdapterToken private quote;
    InventoryAdapterAccount private account;
    PackageInventoryAdapter private adapter;

    function setUp() public {
        token = new InventoryAdapterToken();
        quote = new InventoryAdapterToken();
        account = new InventoryAdapterAccount();
        adapter = new PackageInventoryAdapter(
            PackageInventoryAdapter.Deployment({
                chainId: block.chainid,
                strategyAccount: address(account),
                packageId: PACKAGE_ID,
                inventoryToken: token,
                quoteToken: quote,
                strategyAccountCodeHash: address(account).codehash,
                inventoryTokenCodeHash: address(token).codehash,
                quoteTokenCodeHash: address(quote).codehash
            })
        );
        token.mint(address(account), 100 ether);
    }

    function testLocksAndReleasesExactPackageInventory() public {
        account.execute(adapter, token, 40 ether, _leg(1, 40 ether, 0, 40 ether));
        assertEq(token.balanceOf(address(account)), 60 ether);
        assertEq(token.balanceOf(address(adapter)), 40 ether);

        account.execute(adapter, token, 0, _leg(2, 15 ether, 40 ether, 25 ether));
        assertEq(token.balanceOf(address(account)), 75 ether);
        assertEq(token.balanceOf(address(adapter)), 25 ether);
    }

    function testRejectsUnexpectedInventoryState() public {
        vm.expectRevert(PackageInventoryAdapter.PreconditionFailed.selector);
        account.execute(adapter, token, 40 ether, _leg(1, 40 ether, 1 ether, 41 ether));
    }

    function _leg(uint8 action, uint256 inputAtoms, uint256 preInventory, uint256 postInventory)
        private
        pure
        returns (bytes memory)
    {
        return abi.encode(
            PackageInventoryAdapter.ExactInventoryLeg({
                packageId: PACKAGE_ID,
                orderHash: ORDER_HASH,
                quoteHash: QUOTE_HASH,
                routeHash: ROUTE_HASH,
                action: action,
                inputAtoms: inputAtoms,
                expectedPreInventoryAtoms: preInventory,
                expectedPostInventoryAtoms: postInventory
            })
        );
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "openzeppelin-contracts/token/ERC20/ERC20.sol";
import {IERC20} from "openzeppelin-contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/token/ERC20/utils/SafeERC20.sol";
import {AaveV3TypedLendingAdapter} from "../src/AaveV3TypedLendingAdapter.sol";
import {IAaveV3Pool} from "../src/interfaces/IAaveV3Pool.sol";
import {ITypedStrategyAdapter} from "../src/interfaces/ITypedStrategyAdapter.sol";

contract LendingAdapterToken is ERC20 {
    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

    function mint(address recipient, uint256 amount) external {
        _mint(recipient, amount);
    }
}

contract LendingAdapterAccount {
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

    function manage(AaveV3TypedLendingAdapter adapter, IERC20 token, uint256 approvalAtoms, bytes calldata payload)
        external
        returns (bytes32, uint256)
    {
        if (approvalAtoms != 0) token.forceApprove(address(adapter), approvalAtoms);
        (bytes32 evidence, uint256 outputAtoms) = adapter.manageCollateral(payload);
        if (approvalAtoms != 0) token.forceApprove(address(adapter), 0);
        return (evidence, outputAtoms);
    }
}

contract LendingAdapterPool is IAaveV3Pool {
    using SafeERC20 for IERC20;

    LendingAdapterToken public immutable collateral;
    LendingAdapterToken public immutable debt;
    mapping(address account => uint256 amount) public collateralOf;
    mapping(address account => uint256 amount) public debtOf;

    constructor(LendingAdapterToken collateral_, LendingAdapterToken debt_) {
        collateral = collateral_;
        debt = debt_;
    }

    function supply(address asset, uint256 amount, address onBehalfOf, uint16) external {
        require(asset == address(collateral));
        IERC20(address(collateral)).safeTransferFrom(msg.sender, address(this), amount);
        collateralOf[onBehalfOf] += amount;
    }

    function withdraw(address asset, uint256 amount, address to) external returns (uint256) {
        require(asset == address(collateral));
        uint256 withdrawn = amount == type(uint256).max ? collateralOf[msg.sender] : amount;
        require(withdrawn <= collateralOf[msg.sender]);
        collateralOf[msg.sender] -= withdrawn;
        IERC20(address(collateral)).safeTransfer(to, withdrawn);
        return withdrawn;
    }

    function accrue(address user, uint256 amount) external {
        collateralOf[user] += amount;
        collateral.mint(address(this), amount);
    }

    function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16, address onBehalfOf) external {
        require(asset == address(debt) && interestRateMode == 2 && onBehalfOf == msg.sender);
        require(debtOf[msg.sender] + amount <= collateralOf[msg.sender] / 2);
        debtOf[msg.sender] += amount;
        debt.mint(msg.sender, amount);
    }

    function repay(address asset, uint256 amount, uint256 interestRateMode, address onBehalfOf)
        external
        returns (uint256)
    {
        require(asset == address(debt) && interestRateMode == 2 && onBehalfOf == msg.sender);
        uint256 repaid = amount < debtOf[msg.sender] ? amount : debtOf[msg.sender];
        IERC20(address(debt)).safeTransferFrom(msg.sender, address(this), repaid);
        debtOf[msg.sender] -= repaid;
        return repaid;
    }

    function getUserAccountData(address user)
        external
        view
        returns (uint256, uint256, uint256, uint256, uint256, uint256)
    {
        uint256 supplied = collateralOf[user];
        uint256 borrowed = debtOf[user];
        uint256 available = supplied / 2 > borrowed ? supplied / 2 - borrowed : 0;
        uint256 health = borrowed == 0 ? type(uint256).max : supplied * 5e17 / borrowed;
        return (supplied, borrowed, available, 5_000, 5_000, health);
    }
}

contract AaveV3TypedLendingAdapterTest is Test {
    bytes32 private constant PACKAGE_ID = keccak256("package");
    bytes32 private constant ORDER_HASH = keccak256("order");
    bytes32 private constant QUOTE_HASH = keccak256("quote");
    bytes32 private constant ROUTE_HASH = keccak256("route");

    LendingAdapterToken private collateral;
    LendingAdapterToken private debt;
    LendingAdapterAccount private account;
    LendingAdapterPool private pool;
    AaveV3TypedLendingAdapter private adapter;

    function setUp() public {
        collateral = new LendingAdapterToken("Collateral", "COL");
        debt = new LendingAdapterToken("Debt", "DEBT");
        account = new LendingAdapterAccount();
        pool = new LendingAdapterPool(collateral, debt);
        adapter = new AaveV3TypedLendingAdapter(
            AaveV3TypedLendingAdapter.Deployment({
                chainId: block.chainid,
                strategyAccount: address(account),
                packageId: PACKAGE_ID,
                pool: pool,
                collateralToken: collateral,
                debtToken: debt,
                strategyAccountCodeHash: address(account).codehash,
                poolCodeHash: address(pool).codehash,
                collateralTokenCodeHash: address(collateral).codehash,
                debtTokenCodeHash: address(debt).codehash
            })
        );
        collateral.mint(address(account), 100 ether);
    }

    function testRunsIsolatedSupplyBorrowRepayWithdrawLifecycle() public {
        account.execute(adapter, collateral, 100 ether, _leg(1, 100 ether, 100 ether, 100 ether, 100 ether, 0));
        assertEq(pool.collateralOf(address(adapter)), 100 ether);

        account.execute(adapter, debt, 0, _leg(3, 40 ether, 40 ether, 40 ether, 100 ether, 40 ether));
        assertEq(debt.balanceOf(address(account)), 40 ether);
        assertEq(pool.debtOf(address(adapter)), 40 ether);

        account.execute(adapter, debt, 40 ether, _leg(4, 40 ether, 40 ether, 40 ether, 100 ether, 0));
        assertEq(debt.balanceOf(address(account)), 0);
        assertEq(pool.debtOf(address(adapter)), 0);

        account.execute(adapter, collateral, 0, _leg(2, 100 ether, 100 ether, 100 ether, 0, 0));
        assertEq(collateral.balanceOf(address(account)), 100 ether);
        assertEq(pool.collateralOf(address(adapter)), 0);
    }

    function testRejectsAStaleSignedPrecondition() public {
        bytes memory payload = _leg(1, 10 ether, 10 ether, 10 ether, 10 ether, 0);
        AaveV3TypedLendingAdapter.ExactLendingLeg memory leg =
            abi.decode(payload, (AaveV3TypedLendingAdapter.ExactLendingLeg));
        leg.expectedPreAccountDataHash = keccak256("stale");
        vm.expectRevert(AaveV3TypedLendingAdapter.PreconditionFailed.selector);
        account.execute(adapter, collateral, 10 ether, abi.encode(leg));
        assertEq(collateral.balanceOf(address(account)), 100 ether);
    }

    function testManagesCollateralOutsideTheActivePackageAndReturnsYield() public {
        (bytes32 supplyEvidence, uint256 supplied) =
            account.manage(adapter, collateral, 100 ether, _management(1, 100 ether, 100 ether, 100 ether, 100 ether));
        assertTrue(supplyEvidence != bytes32(0));
        assertEq(supplied, 100 ether);
        assertEq(adapter.managedCollateralPrincipalAtoms(), 100 ether);

        pool.accrue(address(adapter), 5 ether);
        (bytes32 withdrawEvidence, uint256 withdrawn) =
            account.manage(adapter, collateral, 0, _management(2, type(uint256).max, 100 ether, type(uint256).max, 0));
        assertTrue(withdrawEvidence != bytes32(0));
        assertEq(withdrawn, 105 ether);
        assertEq(collateral.balanceOf(address(account)), 105 ether);
        assertEq(adapter.managedCollateralPrincipalAtoms(), 0);
    }

    function _leg(
        uint8 action,
        uint256 inputAtoms,
        uint256 minimumOutputAtoms,
        uint256 maximumOutputAtoms,
        uint256 expectedCollateral,
        uint256 expectedDebt
    ) private view returns (bytes memory) {
        AaveV3TypedLendingAdapter.AccountData memory pre = adapter.accountData();
        return abi.encode(
            AaveV3TypedLendingAdapter.ExactLendingLeg({
                packageId: PACKAGE_ID,
                orderHash: ORDER_HASH,
                quoteHash: QUOTE_HASH,
                routeHash: ROUTE_HASH,
                expectedPreAccountDataHash: keccak256(abi.encode(pre)),
                action: action,
                inputAtoms: inputAtoms,
                minimumOutputAtoms: minimumOutputAtoms,
                maximumOutputAtoms: maximumOutputAtoms,
                minimumPostCollateralBase: expectedCollateral,
                maximumPostCollateralBase: expectedCollateral,
                minimumPostDebtBase: expectedDebt,
                maximumPostDebtBase: expectedDebt,
                minimumPostHealthFactor: expectedDebt == 0 ? type(uint256).max : 1e18
            })
        );
    }

    function _management(
        uint8 action,
        uint256 inputAtoms,
        uint256 minimumOutputAtoms,
        uint256 maximumOutputAtoms,
        uint256 expectedCollateral
    ) private view returns (bytes memory) {
        AaveV3TypedLendingAdapter.AccountData memory pre = adapter.accountData();
        return abi.encode(
            AaveV3TypedLendingAdapter.CollateralManagement({
                packageId: PACKAGE_ID,
                intentHash: keccak256(abi.encode(action, inputAtoms)),
                expectedPreAccountDataHash: keccak256(abi.encode(pre)),
                action: action,
                inputAtoms: inputAtoms,
                minimumOutputAtoms: minimumOutputAtoms,
                maximumOutputAtoms: maximumOutputAtoms,
                minimumPostCollateralBase: expectedCollateral,
                maximumPostCollateralBase: expectedCollateral,
                minimumPostHealthFactor: type(uint256).max
            })
        );
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "openzeppelin-contracts/token/ERC20/ERC20.sol";
import {IERC20} from "openzeppelin-contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/token/ERC20/utils/SafeERC20.sol";
import {PremiaV3TypedOptionAdapter} from "../src/PremiaV3TypedOptionAdapter.sol";
import {IPremiaV3Pool} from "../src/interfaces/IPremiaV3Pool.sol";
import {ITypedStrategyAdapter} from "../src/interfaces/ITypedStrategyAdapter.sol";

contract OptionAdapterToken is ERC20 {
    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

    function mint(address recipient, uint256 amount) external {
        _mint(recipient, amount);
    }
}

contract OptionAdapterOracle {}

contract OptionAdapterAccount {
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

contract OptionAdapterPool is IPremiaV3Pool {
    using SafeERC20 for IERC20;

    OptionAdapterToken public immutable base;
    OptionAdapterToken public immutable quote;
    address public immutable oracle;
    uint256 public immutable strike;
    uint256 public immutable maturity;
    mapping(address account => uint256 amount) private _longs;
    mapping(address account => uint256 amount) private _shorts;

    constructor(OptionAdapterToken base_, OptionAdapterToken quote_, address oracle_) {
        base = base_;
        quote = quote_;
        oracle = oracle_;
        strike = 2_000e18;
        maturity = block.timestamp + 30 days;
    }

    function getPoolSettings() external view returns (address, address, address, uint256, uint256, bool) {
        return (address(base), address(quote), oracle, strike, maturity, true);
    }

    function trade(uint256 size, bool isBuy, uint256 premiumLimit, address)
        external
        returns (uint256 totalPremium, PositionDelta memory delta)
    {
        totalPremium = size / 10;
        if (isBuy) {
            require(totalPremium <= premiumLimit);
            IERC20(address(base)).safeTransferFrom(msg.sender, address(this), totalPremium);
            _longs[msg.sender] += size;
            delta.longs = int256(size);
            delta.collateral = -int256(totalPremium);
        } else {
            require(totalPremium >= premiumLimit && _longs[msg.sender] >= size);
            _longs[msg.sender] -= size;
            IERC20(address(base)).safeTransfer(msg.sender, totalPremium);
            delta.longs = -int256(size);
            delta.collateral = int256(totalPremium);
        }
    }

    function exercise() external returns (uint256 exerciseValue, uint256 exerciseFee) {
        uint256 longs = _longs[msg.sender];
        _longs[msg.sender] = 0;
        exerciseValue = longs / 5;
        IERC20(address(base)).safeTransfer(msg.sender, exerciseValue);
        return (exerciseValue, 0);
    }

    function settle() external returns (uint256 collateral) {
        uint256 shorts = _shorts[msg.sender];
        _shorts[msg.sender] = 0;
        collateral = shorts / 5;
        IERC20(address(base)).safeTransfer(msg.sender, collateral);
    }

    function balanceOf(address account, uint256 tokenId) external view returns (uint256) {
        return tokenId == 0 ? _shorts[account] : tokenId == 1 ? _longs[account] : 0;
    }
}

contract PremiaV3TypedOptionAdapterTest is Test {
    bytes32 private constant PACKAGE_ID = keccak256("package");
    bytes32 private constant ORDER_HASH = keccak256("order");
    bytes32 private constant QUOTE_HASH = keccak256("quote");
    bytes32 private constant ROUTE_HASH = keccak256("route");

    OptionAdapterToken private base;
    OptionAdapterToken private quote;
    OptionAdapterOracle private oracle;
    OptionAdapterPool private pool;
    OptionAdapterAccount private account;
    PremiaV3TypedOptionAdapter private adapter;

    function setUp() public {
        base = new OptionAdapterToken("Base", "BASE");
        quote = new OptionAdapterToken("Quote", "QUOTE");
        oracle = new OptionAdapterOracle();
        pool = new OptionAdapterPool(base, quote, address(oracle));
        account = new OptionAdapterAccount();
        adapter = new PremiaV3TypedOptionAdapter(
            PremiaV3TypedOptionAdapter.Deployment({
                chainId: block.chainid,
                strategyAccount: address(account),
                packageId: PACKAGE_ID,
                pool: pool,
                baseToken: base,
                quoteToken: quote,
                poolToken: base,
                oracleAdapter: address(oracle),
                strike: pool.strike(),
                maturity: pool.maturity(),
                isCallPool: true,
                strategyAccountCodeHash: address(account).codehash,
                poolCodeHash: address(pool).codehash,
                baseTokenCodeHash: address(base).codehash,
                quoteTokenCodeHash: address(quote).codehash,
                oracleAdapterCodeHash: address(oracle).codehash
            })
        );
        base.mint(address(account), 100 ether);
        base.mint(address(pool), 100 ether);
    }

    function testBuysAndExercisesAnIsolatedLongOption() public {
        account.execute(adapter, base, 10 ether, _leg(1, true, 100 ether, 10 ether, 10 ether, 0, 0, 100 ether, 0, -10 ether, -10 ether));
        assertEq(pool.balanceOf(address(adapter), 1), 100 ether);
        assertEq(base.balanceOf(address(account)), 90 ether);

        account.execute(adapter, base, 0, _leg(2, false, 0, 0, 0, 100 ether, 0, 0, 0, 20 ether, 20 ether));
        assertEq(pool.balanceOf(address(adapter), 1), 0);
        assertEq(base.balanceOf(address(account)), 110 ether);
        assertEq(base.balanceOf(address(adapter)), 0);
    }

    function testRejectsUnexpectedPositionState() public {
        vm.expectRevert(PremiaV3TypedOptionAdapter.PreconditionFailed.selector);
        account.execute(adapter, base, 10 ether, _leg(1, true, 100 ether, 10 ether, 10 ether, 1, 0, 100 ether, 0, -10 ether, -10 ether));
    }

    function _leg(
        uint8 action,
        bool isBuy,
        uint256 size,
        uint256 premiumLimit,
        uint256 maximumInputAtoms,
        uint256 preLongs,
        uint256 preShorts,
        uint256 postLongs,
        uint256 postShorts,
        int256 minimumDelta,
        int256 maximumDelta
    ) private pure returns (bytes memory) {
        return abi.encode(
            PremiaV3TypedOptionAdapter.ExactOptionLeg({
                packageId: PACKAGE_ID,
                orderHash: ORDER_HASH,
                quoteHash: QUOTE_HASH,
                routeHash: ROUTE_HASH,
                action: action,
                isBuy: isBuy,
                size: size,
                premiumLimit: premiumLimit,
                maximumInputAtoms: maximumInputAtoms,
                expectedPreLongs: preLongs,
                expectedPreShorts: preShorts,
                expectedPostLongs: postLongs,
                expectedPostShorts: postShorts,
                minimumAccountTokenDelta: minimumDelta,
                maximumAccountTokenDelta: maximumDelta
            })
        );
    }
}

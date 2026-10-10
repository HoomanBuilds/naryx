// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "openzeppelin-contracts/token/ERC20/IERC20.sol";
import {DeployNativePackageClearingHouse} from "../script/DeployNativePackageClearingHouse.s.sol";
import {NativePackageClearingHouse} from "../src/NativePackageClearingHouse.sol";
import {NaryxTestUSDC} from "../src/conformance/NaryxTestUSDC.sol";

contract DeployNativePackageClearingHouseTest is Test {
    uint256 private constant CHAIN_ID = 84_532;

    DeployNativePackageClearingHouse private script;
    NaryxTestUSDC private collateral;

    function setUp() public {
        vm.chainId(CHAIN_ID);
        script = new DeployNativePackageClearingHouse();
        collateral = new NaryxTestUSDC();
    }

    function testDeploysAgainstPinnedCollateral() public {
        NativePackageClearingHouse clearing = script.deploy(_parameters());

        assertEq(address(clearing.collateralToken()), address(collateral));
        assertEq(clearing.policyHash(), keccak256("sol-carry-clearing-policy-v1"));
        assertEq(clearing.governor(), address(0x101));
        assertTrue(clearing.entryPaused());
    }

    function testRejectsWrongChain() public {
        DeployNativePackageClearingHouse.Parameters memory parameters = _parameters();
        parameters.expectedChainId = 421_614;

        vm.expectRevert(DeployNativePackageClearingHouse.InvalidChain.selector);
        script.deploy(parameters);
    }

    function _parameters() private view returns (DeployNativePackageClearingHouse.Parameters memory) {
        return DeployNativePackageClearingHouse.Parameters({
            expectedChainId: CHAIN_ID,
            collateralToken: IERC20(address(collateral)),
            collateralTokenCodeHash: address(collateral).codehash,
            configuration: NativePackageClearingHouse.Configuration({
                policyHash: keccak256("sol-carry-clearing-policy-v1"),
                governor: address(0x101),
                pauser: address(0x102),
                markAuthority: address(0x103),
                packageQuantityIncrementAtoms: 1e9,
                priceTickQuoteAtoms: 1,
                initialMarginQuoteAtomsPerIncrement: 20e6,
                maintenanceMarginQuoteAtomsPerIncrement: 10e6,
                maximumPositionAtoms: 100e9,
                maximumOpenInterestAtoms: 1_000e9,
                maximumDefaultTransferDiscountBps: 500,
                markMaximumStalenessSeconds: 900,
                defaultAuctionDurationSeconds: 300,
                feeUpdateDelaySeconds: 1 days,
                maximumFeeBps: 100
            })
        });
    }
}

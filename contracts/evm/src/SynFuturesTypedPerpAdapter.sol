// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "openzeppelin-contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/utils/ReentrancyGuard.sol";
import {IPerpMarginGate} from "./interfaces/IPerpMarginGate.sol";
import {ISynFuturesInstrument} from "./interfaces/ISynFuturesInstrument.sol";
import {ISynFuturesPositionObserver} from "./interfaces/ISynFuturesPositionObserver.sol";
import {ITypedStrategyAdapter} from "./interfaces/ITypedStrategyAdapter.sol";

contract SynFuturesTypedPerpAdapter is ITypedStrategyAdapter, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant ADAPTER_CLASS_ID = keccak256("naryx.evm.perp-exact");
    uint32 public constant ADAPTER_CLASS_VERSION = 1;

    struct Deployment {
        uint256 chainId;
        address strategyAccount;
        bytes32 packageId;
        IERC20 baseToken;
        IERC20 collateralToken;
        ISynFuturesInstrument instrument;
        ISynFuturesPositionObserver observer;
        IPerpMarginGate marginGate;
        uint32 expiry;
        bytes32 strategyAccountCodeHash;
        bytes32 baseTokenCodeHash;
        bytes32 collateralTokenCodeHash;
        bytes32 instrumentCodeHash;
        bytes32 observerCodeHash;
        bytes32 marginGateCodeHash;
    }

    struct ExactPerpLeg {
        bytes32 packageId;
        bytes32 orderHash;
        bytes32 quoteHash;
        bytes32 routeHash;
        bytes32 expectedPrePositionHash;
        bytes32[2] tradeArgs;
        int128 expectedPostSizeWad;
        int128 minimumPostBalanceWad;
        int128 maximumPostBalanceWad;
        uint128 minimumPostEntryNotionalWad;
        uint128 maximumPostEntryNotionalWad;
        uint256 expectedReserveBeforeAtoms;
        uint256 minimumReserveAfterAtoms;
        uint256 maximumReserveAfterAtoms;
        uint256 collateralInAtoms;
        uint256 collateralOutAtoms;
        bool withdrawAll;
        uint256 minimumCollateralOutAtoms;
        uint256 maximumCollateralOutAtoms;
    }

    error InvalidConfiguration();
    error UnauthorizedCaller();
    error InvalidLeg();
    error DeploymentChanged();
    error PreconditionFailed();
    error PostconditionFailed();

    address public immutable strategyAccount;
    bytes32 public immutable packageId;
    uint256 public immutable deploymentChainId;
    IERC20 public immutable baseToken;
    IERC20 public immutable collateralToken;
    ISynFuturesInstrument public immutable instrument;
    ISynFuturesPositionObserver public immutable observer;
    IPerpMarginGate public immutable marginGate;
    uint32 public immutable expiry;
    bytes32 public immutable strategyAccountCodeHash;
    bytes32 public immutable baseTokenCodeHash;
    bytes32 public immutable collateralTokenCodeHash;
    bytes32 public immutable instrumentCodeHash;
    bytes32 public immutable observerCodeHash;
    bytes32 public immutable marginGateCodeHash;

    constructor(Deployment memory deployment) {
        if (
            deployment.chainId == 0 || deployment.strategyAccount.code.length == 0 || deployment.packageId == bytes32(0)
                || address(deployment.baseToken).code.length == 0
                || address(deployment.collateralToken).code.length == 0
                || address(deployment.baseToken) == address(deployment.collateralToken)
                || address(deployment.instrument).code.length == 0 || address(deployment.observer).code.length == 0
                || address(deployment.marginGate).code.length == 0 || deployment.expiry == 0
                || deployment.strategyAccountCodeHash == bytes32(0) || deployment.baseTokenCodeHash == bytes32(0)
                || deployment.collateralTokenCodeHash == bytes32(0) || deployment.instrumentCodeHash == bytes32(0)
                || deployment.observerCodeHash == bytes32(0) || deployment.marginGateCodeHash == bytes32(0)
                || address(deployment.marginGate.collateral()) != address(deployment.collateralToken)
        ) revert InvalidConfiguration();

        strategyAccount = deployment.strategyAccount;
        packageId = deployment.packageId;
        deploymentChainId = deployment.chainId;
        baseToken = deployment.baseToken;
        collateralToken = deployment.collateralToken;
        instrument = deployment.instrument;
        observer = deployment.observer;
        marginGate = deployment.marginGate;
        expiry = deployment.expiry;
        strategyAccountCodeHash = deployment.strategyAccountCodeHash;
        baseTokenCodeHash = deployment.baseTokenCodeHash;
        collateralTokenCodeHash = deployment.collateralTokenCodeHash;
        instrumentCodeHash = deployment.instrumentCodeHash;
        observerCodeHash = deployment.observerCodeHash;
        marginGateCodeHash = deployment.marginGateCodeHash;
        _assertDeployment();
    }

    function adapterMetadata() external view returns (address, bytes32, uint32, address, address) {
        return (strategyAccount, ADAPTER_CLASS_ID, ADAPTER_CLASS_VERSION, address(baseToken), address(collateralToken));
    }

    function executeLeg(bytes calldata payload) external nonReentrant returns (bytes32 evidenceHash) {
        if (msg.sender != strategyAccount) revert UnauthorizedCaller();
        ExactPerpLeg memory leg = abi.decode(payload, (ExactPerpLeg));
        _validateLeg(leg);
        _assertDeployment();

        ISynFuturesPositionObserver.Position memory pre = _position();
        uint256 reserveBefore = marginGate.reserveOf(address(this));
        if (
            keccak256(abi.encode(pre)) != leg.expectedPrePositionHash || reserveBefore != leg.expectedReserveBeforeAtoms
        ) {
            revert PreconditionFailed();
        }

        uint256 adapterCollateralBefore = collateralToken.balanceOf(address(this));
        uint256 accountCollateralBefore = collateralToken.balanceOf(strategyAccount);
        if (leg.collateralInAtoms != 0) _deposit(leg.collateralInAtoms);

        ISynFuturesInstrument.PositionCache memory tradeResult = instrument.trade(leg.tradeArgs);
        ISynFuturesPositionObserver.Position memory post = _position();
        if (!_samePosition(tradeResult, post)) revert PostconditionFailed();

        uint256 collateralOut = _withdraw(leg);
        uint256 reserveAfter = marginGate.reserveOf(address(this));
        _validatePostconditions(
            leg, post, reserveAfter, collateralOut, adapterCollateralBefore, accountCollateralBefore
        );

        evidenceHash = _evidenceHash(leg, pre, post, reserveBefore, reserveAfter, collateralOut);
    }

    function _validatePostconditions(
        ExactPerpLeg memory leg,
        ISynFuturesPositionObserver.Position memory post,
        uint256 reserveAfter,
        uint256 collateralOut,
        uint256 adapterCollateralBefore,
        uint256 accountCollateralBefore
    ) private view {
        if (
            post.size != leg.expectedPostSizeWad || post.balance < leg.minimumPostBalanceWad
                || post.balance > leg.maximumPostBalanceWad || post.entryNotional < leg.minimumPostEntryNotionalWad
                || post.entryNotional > leg.maximumPostEntryNotionalWad || reserveAfter < leg.minimumReserveAfterAtoms
                || reserveAfter > leg.maximumReserveAfterAtoms || collateralOut < leg.minimumCollateralOutAtoms
                || collateralOut > leg.maximumCollateralOutAtoms
                || collateralToken.balanceOf(address(this)) != adapterCollateralBefore
                || collateralToken.balanceOf(strategyAccount)
                    != accountCollateralBefore - leg.collateralInAtoms + collateralOut
        ) revert PostconditionFailed();
    }

    function _evidenceHash(
        ExactPerpLeg memory leg,
        ISynFuturesPositionObserver.Position memory pre,
        ISynFuturesPositionObserver.Position memory post,
        uint256 reserveBefore,
        uint256 reserveAfter,
        uint256 collateralOut
    ) private view returns (bytes32) {
        bytes32 executionHash = keccak256(abi.encode(leg.packageId, leg.orderHash, leg.quoteHash, leg.routeHash));
        bytes32 stateHash = keccak256(
            abi.encode(
                keccak256(abi.encode(pre)),
                keccak256(abi.encode(post)),
                reserveBefore,
                reserveAfter,
                leg.collateralInAtoms,
                collateralOut
            )
        );
        return keccak256(abi.encode(address(this), deploymentChainId, executionHash, stateHash));
    }

    function position() external view returns (ISynFuturesPositionObserver.Position memory) {
        return _position();
    }

    function assertDeployment() external view {
        _assertDeployment();
    }

    function _validateLeg(ExactPerpLeg memory leg) private view {
        if (
            leg.packageId != packageId || leg.orderHash == bytes32(0) || leg.quoteHash == bytes32(0)
                || leg.routeHash == bytes32(0) || leg.expectedPrePositionHash == bytes32(0)
                || leg.minimumPostBalanceWad > leg.maximumPostBalanceWad
                || leg.minimumPostEntryNotionalWad > leg.maximumPostEntryNotionalWad
                || leg.minimumReserveAfterAtoms > leg.maximumReserveAfterAtoms
                || leg.minimumCollateralOutAtoms > leg.maximumCollateralOutAtoms
                || (leg.collateralInAtoms != 0 && (leg.collateralOutAtoms != 0 || leg.withdrawAll))
                || (leg.withdrawAll && leg.collateralOutAtoms != 0)
                || (!leg.withdrawAll && leg.collateralOutAtoms == 0 && leg.minimumCollateralOutAtoms != 0)
                || (!leg.withdrawAll && leg.collateralOutAtoms == 0 && leg.maximumCollateralOutAtoms != 0)
        ) revert InvalidLeg();
    }

    function _deposit(uint256 amount) private {
        if (collateralToken.allowance(strategyAccount, address(this)) != amount) revert InvalidLeg();
        uint256 balanceBefore = collateralToken.balanceOf(address(this));
        collateralToken.safeTransferFrom(strategyAccount, address(this), amount);
        if (collateralToken.balanceOf(address(this)) != balanceBefore + amount) revert PostconditionFailed();
        collateralToken.forceApprove(address(marginGate), amount);
        marginGate.deposit(amount);
        collateralToken.forceApprove(address(marginGate), 0);
        if (collateralToken.balanceOf(address(this)) != balanceBefore) revert PostconditionFailed();
    }

    function _withdraw(ExactPerpLeg memory leg) private returns (uint256 collateralOut) {
        if (leg.withdrawAll) collateralOut = marginGate.reserveOf(address(this));
        else collateralOut = leg.collateralOutAtoms;
        if (collateralOut == 0) return 0;
        uint256 balanceBefore = collateralToken.balanceOf(address(this));
        marginGate.withdraw(collateralOut);
        if (collateralToken.balanceOf(address(this)) != balanceBefore + collateralOut) revert PostconditionFailed();
        collateralToken.safeTransfer(strategyAccount, collateralOut);
    }

    function _position() private view returns (ISynFuturesPositionObserver.Position memory) {
        return observer.getPosition(address(instrument), expiry, address(this));
    }

    function _samePosition(
        ISynFuturesInstrument.PositionCache memory cache,
        ISynFuturesPositionObserver.Position memory observed
    ) private pure returns (bool) {
        return cache.balance == observed.balance && cache.size == observed.size
            && cache.entryNotional == observed.entryNotional
            && cache.entrySocialLossIndex == observed.entrySocialLossIndex
            && cache.entryFundingIndex == observed.entryFundingIndex;
    }

    function _assertDeployment() private view {
        if (
            block.chainid != deploymentChainId || strategyAccount.codehash != strategyAccountCodeHash
                || address(baseToken).codehash != baseTokenCodeHash
                || address(collateralToken).codehash != collateralTokenCodeHash
                || address(instrument).codehash != instrumentCodeHash || address(observer).codehash != observerCodeHash
                || address(marginGate).codehash != marginGateCodeHash
                || address(marginGate.collateral()) != address(collateralToken)
        ) revert DeploymentChanged();
    }
}

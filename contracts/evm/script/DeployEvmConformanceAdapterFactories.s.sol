// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Script} from "forge-std/Script.sol";
import {IERC20} from "openzeppelin-contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "openzeppelin-contracts/interfaces/IERC4626.sol";
import {AaveV3TypedLendingAdapterFactory} from "../src/AaveV3TypedLendingAdapterFactory.sol";
import {ERC4626TypedVaultAdapterFactory} from "../src/ERC4626TypedVaultAdapterFactory.sol";
import {NaryxMultiStrategyAccountFactory} from "../src/NaryxMultiStrategyAccountFactory.sol";
import {PackageInventoryAdapterFactory} from "../src/PackageInventoryAdapterFactory.sol";
import {PremiaV3TypedOptionAdapterFactory} from "../src/PremiaV3TypedOptionAdapterFactory.sol";
import {SynFuturesTypedPerpAdapterFactory} from "../src/SynFuturesTypedPerpAdapterFactory.sol";
import {IAaveV3Pool} from "../src/interfaces/IAaveV3Pool.sol";
import {IPerpMarginGate} from "../src/interfaces/IPerpMarginGate.sol";
import {IPremiaV3Pool} from "../src/interfaces/IPremiaV3Pool.sol";
import {INaryxMultiStrategyAccountFactory} from "../src/interfaces/INaryxMultiStrategyAccountFactory.sol";
import {ISynFuturesInstrument} from "../src/interfaces/ISynFuturesInstrument.sol";
import {ISynFuturesPositionObserver} from "../src/interfaces/ISynFuturesPositionObserver.sol";

contract DeployEvmConformanceAdapterFactories is Script {
    struct Parameters {
        uint256 expectedChainId;
        NaryxMultiStrategyAccountFactory accountFactory;
        IERC20 baseAsset;
        IERC20 quoteAsset;
        IPremiaV3Pool lowerStrikeCallPool;
        IPremiaV3Pool upperStrikeCallPool;
        IAaveV3Pool lendingPool;
        IERC4626 vault;
        ISynFuturesInstrument perpetualInstrument;
        ISynFuturesPositionObserver perpetualObserver;
        IPerpMarginGate perpetualMarginGate;
        uint32 perpetualExpiry;
    }

    struct Deployment {
        PremiaV3TypedOptionAdapterFactory lowerStrikeOptionFactory;
        PremiaV3TypedOptionAdapterFactory upperStrikeOptionFactory;
        AaveV3TypedLendingAdapterFactory lendingFactory;
        ERC4626TypedVaultAdapterFactory vaultFactory;
        PackageInventoryAdapterFactory inventoryFactory;
        SynFuturesTypedPerpAdapterFactory perpetualFactory;
    }

    error InvalidChain();
    error InvalidConfiguration();

    function run(Parameters calldata parameters) external returns (Deployment memory deployment) {
        vm.startBroadcast();
        deployment = deploy(parameters);
        vm.stopBroadcast();
    }

    function deploy(Parameters calldata parameters) public returns (Deployment memory deployment) {
        if (parameters.expectedChainId == 0 || block.chainid != parameters.expectedChainId) revert InvalidChain();
        if (
            address(parameters.accountFactory).code.length == 0 || address(parameters.baseAsset).code.length == 0
                || address(parameters.quoteAsset).code.length == 0
                || address(parameters.baseAsset) == address(parameters.quoteAsset)
                || address(parameters.lowerStrikeCallPool).code.length == 0
                || address(parameters.upperStrikeCallPool).code.length == 0
                || address(parameters.lowerStrikeCallPool) == address(parameters.upperStrikeCallPool)
                || address(parameters.lendingPool).code.length == 0 || address(parameters.vault).code.length == 0
                || address(parameters.perpetualInstrument).code.length == 0
                || address(parameters.perpetualObserver).code.length == 0
                || address(parameters.perpetualMarginGate).code.length == 0 || parameters.perpetualExpiry == 0
                || parameters.accountFactory.deploymentChainId() != block.chainid
                || parameters.vault.asset() != address(parameters.baseAsset)
                || address(parameters.perpetualMarginGate.collateral()) != address(parameters.quoteAsset)
        ) revert InvalidConfiguration();

        bytes32 accountFactoryCodeHash = address(parameters.accountFactory).codehash;
        bytes32 strategyAccountCodeHash = parameters.accountFactory.accountCodeHash();
        deployment.lowerStrikeOptionFactory =
            _optionFactory(parameters, parameters.lowerStrikeCallPool, accountFactoryCodeHash, strategyAccountCodeHash);
        deployment.upperStrikeOptionFactory =
            _optionFactory(parameters, parameters.upperStrikeCallPool, accountFactoryCodeHash, strategyAccountCodeHash);
        deployment.lendingFactory = new AaveV3TypedLendingAdapterFactory(
            AaveV3TypedLendingAdapterFactory.Deployment({
                chainId: block.chainid,
                accountFactory: INaryxMultiStrategyAccountFactory(address(parameters.accountFactory)),
                pool: parameters.lendingPool,
                collateralToken: parameters.baseAsset,
                debtToken: parameters.quoteAsset,
                accountFactoryCodeHash: accountFactoryCodeHash,
                strategyAccountCodeHash: strategyAccountCodeHash,
                poolCodeHash: address(parameters.lendingPool).codehash,
                collateralTokenCodeHash: address(parameters.baseAsset).codehash,
                debtTokenCodeHash: address(parameters.quoteAsset).codehash
            })
        );
        deployment.vaultFactory = new ERC4626TypedVaultAdapterFactory(
            ERC4626TypedVaultAdapterFactory.Deployment({
                chainId: block.chainid,
                accountFactory: INaryxMultiStrategyAccountFactory(address(parameters.accountFactory)),
                vault: parameters.vault,
                assetToken: parameters.baseAsset,
                accountFactoryCodeHash: accountFactoryCodeHash,
                strategyAccountCodeHash: strategyAccountCodeHash,
                vaultCodeHash: address(parameters.vault).codehash,
                assetTokenCodeHash: address(parameters.baseAsset).codehash
            })
        );
        deployment.inventoryFactory = new PackageInventoryAdapterFactory(
            PackageInventoryAdapterFactory.Deployment({
                chainId: block.chainid,
                accountFactory: INaryxMultiStrategyAccountFactory(address(parameters.accountFactory)),
                inventoryToken: parameters.baseAsset,
                quoteToken: parameters.quoteAsset,
                accountFactoryCodeHash: accountFactoryCodeHash,
                strategyAccountCodeHash: strategyAccountCodeHash,
                inventoryTokenCodeHash: address(parameters.baseAsset).codehash,
                quoteTokenCodeHash: address(parameters.quoteAsset).codehash
            })
        );
        deployment.perpetualFactory = new SynFuturesTypedPerpAdapterFactory(
            SynFuturesTypedPerpAdapterFactory.Deployment({
                chainId: block.chainid,
                datedFuture: false,
                accountFactory: INaryxMultiStrategyAccountFactory(address(parameters.accountFactory)),
                baseToken: parameters.baseAsset,
                collateralToken: parameters.quoteAsset,
                instrument: parameters.perpetualInstrument,
                observer: parameters.perpetualObserver,
                marginGate: parameters.perpetualMarginGate,
                expiry: parameters.perpetualExpiry,
                accountFactoryCodeHash: accountFactoryCodeHash,
                strategyAccountCodeHash: strategyAccountCodeHash,
                baseTokenCodeHash: address(parameters.baseAsset).codehash,
                collateralTokenCodeHash: address(parameters.quoteAsset).codehash,
                instrumentCodeHash: address(parameters.perpetualInstrument).codehash,
                observerCodeHash: address(parameters.perpetualObserver).codehash,
                marginGateCodeHash: address(parameters.perpetualMarginGate).codehash
            })
        );
    }

    function _optionFactory(
        Parameters calldata parameters,
        IPremiaV3Pool pool,
        bytes32 accountFactoryCodeHash,
        bytes32 strategyAccountCodeHash
    ) private returns (PremiaV3TypedOptionAdapterFactory factory) {
        (address base, address quote, address oracle, uint256 strike, uint256 maturity, bool isCall) =
            pool.getPoolSettings();
        if (base != address(parameters.baseAsset) || quote != address(parameters.quoteAsset) || oracle.code.length == 0)
        {
            revert InvalidConfiguration();
        }
        IERC20 poolToken = isCall ? parameters.baseAsset : parameters.quoteAsset;
        factory = new PremiaV3TypedOptionAdapterFactory(
            PremiaV3TypedOptionAdapterFactory.Deployment({
                chainId: block.chainid,
                accountFactory: INaryxMultiStrategyAccountFactory(address(parameters.accountFactory)),
                pool: pool,
                baseToken: parameters.baseAsset,
                quoteToken: parameters.quoteAsset,
                poolToken: poolToken,
                oracleAdapter: oracle,
                strike: strike,
                maturity: maturity,
                isCallPool: isCall,
                accountFactoryCodeHash: accountFactoryCodeHash,
                strategyAccountCodeHash: strategyAccountCodeHash,
                poolCodeHash: address(pool).codehash,
                baseTokenCodeHash: address(parameters.baseAsset).codehash,
                quoteTokenCodeHash: address(parameters.quoteAsset).codehash,
                oracleAdapterCodeHash: oracle.codehash
            })
        );
    }
}

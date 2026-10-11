// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Create2} from "openzeppelin-contracts/utils/Create2.sol";
import {NaryxMultiStrategyAccount} from "./NaryxMultiStrategyAccount.sol";
import {ProtocolConfig} from "./ProtocolConfig.sol";
import {RiskDomainRegistry} from "./RiskDomainRegistry.sol";
import {SolverRegistry} from "./SolverRegistry.sol";
import {StrategyFeePolicyRegistry} from "./StrategyFeePolicyRegistry.sol";
import {TypedStrategyAdapterRegistry} from "./TypedStrategyAdapterRegistry.sol";

contract NaryxMultiStrategyAccountDeployer {
    error UnauthorizedFactory();
    error DeploymentMismatch();

    function accountOf(
        bytes32 salt,
        address owner,
        address accountFactory,
        ProtocolConfig config,
        SolverRegistry solverRegistry,
        TypedStrategyAdapterRegistry adapterRegistry,
        StrategyFeePolicyRegistry feePolicyRegistry,
        RiskDomainRegistry riskDomainRegistry,
        bytes32 feePolicySubjectId
    ) public view returns (address) {
        return Create2.computeAddress(
            salt,
            keccak256(
                abi.encodePacked(
                    type(NaryxMultiStrategyAccount).creationCode,
                    abi.encode(
                        owner,
                        accountFactory,
                        config,
                        solverRegistry,
                        adapterRegistry,
                        feePolicyRegistry,
                        riskDomainRegistry,
                        feePolicySubjectId
                    )
                )
            ),
            address(this)
        );
    }

    function deploy(
        bytes32 salt,
        address owner,
        address accountFactory,
        ProtocolConfig config,
        SolverRegistry solverRegistry,
        TypedStrategyAdapterRegistry adapterRegistry,
        StrategyFeePolicyRegistry feePolicyRegistry,
        RiskDomainRegistry riskDomainRegistry,
        bytes32 feePolicySubjectId
    ) external returns (NaryxMultiStrategyAccount account) {
        if (msg.sender != accountFactory) revert UnauthorizedFactory();
        address expected = accountOf(
            salt,
            owner,
            accountFactory,
            config,
            solverRegistry,
            adapterRegistry,
            feePolicyRegistry,
            riskDomainRegistry,
            feePolicySubjectId
        );
        account = new NaryxMultiStrategyAccount{salt: salt}(
            owner,
            accountFactory,
            config,
            solverRegistry,
            adapterRegistry,
            feePolicyRegistry,
            riskDomainRegistry,
            feePolicySubjectId
        );
        if (address(account) != expected) revert DeploymentMismatch();
    }
}

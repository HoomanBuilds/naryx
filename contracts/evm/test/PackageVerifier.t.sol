// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "openzeppelin-contracts/token/ERC20/ERC20.sol";
import {IERC20} from "openzeppelin-contracts/token/ERC20/IERC20.sol";
import {ECDSA} from "openzeppelin-contracts/utils/cryptography/ECDSA.sol";
import {IERC1271} from "openzeppelin-contracts/interfaces/IERC1271.sol";
import {PackageVerifier} from "../src/PackageVerifier.sol";
import {ProtocolConfig} from "../src/ProtocolConfig.sol";
import {ResourceRegistry} from "../src/ResourceRegistry.sol";
import {SolverRegistry} from "../src/SolverRegistry.sol";
import {UniswapV3SpotPort} from "../src/UniswapV3SpotPort.sol";
import {ISynFuturesInstrument} from "../src/interfaces/ISynFuturesInstrument.sol";
import {ISynFuturesPositionObserver} from "../src/interfaces/ISynFuturesPositionObserver.sol";

contract VerifierToken is ERC20 {
    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

    function mint(address recipient, uint256 amount) external {
        _mint(recipient, amount);
    }
}

contract VerifierV3Factory {
    address public pool;
    address public tokenA;
    address public tokenB;
    uint24 public fee;

    function setPool(address tokenA_, address tokenB_, uint24 fee_, address pool_) external {
        tokenA = tokenA_;
        tokenB = tokenB_;
        fee = fee_;
        pool = pool_;
    }

    function getPool(address tokenA_, address tokenB_, uint24 fee_) external view returns (address) {
        bool pair = (tokenA_ == tokenA && tokenB_ == tokenB) || (tokenA_ == tokenB && tokenB_ == tokenA);
        return pair && fee_ == fee ? pool : address(0);
    }
}

contract VerifierV3Pool {
    address public immutable factory;
    address public immutable token0;
    address public immutable token1;
    uint24 public immutable fee;

    constructor(address factory_, address token0_, address token1_, uint24 fee_) {
        factory = factory_;
        token0 = token0_;
        token1 = token1_;
        fee = fee_;
    }

    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1)
    {
        require(!zeroForOne && amountSpecified < 0, "entry only");
        amount0 = amountSpecified;
        amount1 = -2 * amountSpecified;
        require(IERC20(token0).transfer(recipient, uint256(-amount0)), "base transfer");
        UniswapV3SpotPort(msg.sender).uniswapV3SwapCallback(amount0, amount1, data);
    }
}

contract VerifierPerp is ISynFuturesInstrument, ISynFuturesPositionObserver {
    mapping(address trader => Position position) private _positions;

    function trade(bytes32[2] calldata args) external returns (PositionCache memory result) {
        uint256 packed = uint256(args[1]);
        int128 sizeDelta = int128(uint128(packed >> 128));
        int128 margin = int128(uint128(packed));
        Position storage position = _positions[msg.sender];
        position.size += sizeDelta;
        position.balance += margin;
        position.entryNotional = uint128(uint256(uint128(position.size < 0 ? -position.size : position.size)) * 2);
        result.balance = position.balance;
        result.size = position.size;
    }

    function getPosition(address instrument, uint32, address target) external view returns (Position memory position) {
        require(instrument == address(this), "wrong instrument");
        return _positions[target];
    }
}

contract VerifierAdmissionRegistry {
    ProtocolConfig public immutable config;
    bytes32 public expectedAdmissionHash;

    constructor(ProtocolConfig config_) {
        config = config_;
    }

    function setExpectedAdmissionHash(bytes32 expectedAdmissionHash_) external {
        expectedAdmissionHash = expectedAdmissionHash_;
    }

    function validateCashCarry(ResourceRegistry.CashCarryAdmission calldata admission) external view returns (uint256) {
        require(keccak256(abi.encode(admission)) == expectedAdmissionHash, "unadmitted route");
        return type(uint256).max;
    }
}

contract VerifierStrategyAccount is IERC1271 {
    address public immutable owner;

    constructor(address owner_) {
        owner = owner_;
    }

    function isValidSignature(bytes32 hash, bytes memory signature) external view returns (bytes4) {
        return ECDSA.recover(hash, signature) == owner ? IERC1271.isValidSignature.selector : bytes4(0xffffffff);
    }

    function executeEntry(
        PackageVerifier verifier,
        PackageVerifier.Execution calldata execution,
        ResourceRegistry.CashCarryAdmission calldata admission,
        bytes calldata traderSignature,
        bytes calldata solverSignature,
        bytes32[2] calldata perpArgs
    ) external returns (bytes32 receiptHash) {
        verifier.begin(execution, admission, traderSignature, solverSignature);
        IERC20(execution.quoteToken).approve(execution.spotPort, execution.spotQuoteBoundAtoms);
        UniswapV3SpotPort(execution.spotPort)
            .buyExactOutput(
                execution.nonce,
                execution.spotFillCommitment,
                execution.orderHash,
                execution.quoteHash,
                execution.routeHash,
                execution.baseQuantityAtoms,
                execution.spotQuoteBoundAtoms
            );
        ISynFuturesInstrument(execution.perpInstrument).trade(perpArgs);
        return verifier.finalize(execution, admission, false);
    }

    function executeEntryWithWrongSpotFillCommitment(
        PackageVerifier verifier,
        PackageVerifier.Execution calldata execution,
        ResourceRegistry.CashCarryAdmission calldata admission,
        bytes calldata traderSignature,
        bytes calldata solverSignature
    ) external {
        verifier.begin(execution, admission, traderSignature, solverSignature);
        IERC20(execution.quoteToken).approve(execution.spotPort, execution.spotQuoteBoundAtoms);
        UniswapV3SpotPort(execution.spotPort)
            .buyExactOutput(
                execution.nonce,
                keccak256("wrong-spot-fill"),
                execution.orderHash,
                execution.quoteHash,
                execution.routeHash,
                execution.baseQuantityAtoms,
                execution.spotQuoteBoundAtoms
            );
    }
}

contract PackageVerifierTest is Test {
    uint24 private constant POOL_FEE = 3000;
    uint32 private constant PERP_EXPIRY = type(uint32).max;
    uint256 private constant QUANTITY = 1 ether;
    uint256 private constant MARGIN = 4 ether;
    bytes32 private constant DOMAIN_MANIFEST_HASH = keccak256("domain-manifest");
    address private constant PROPOSER = address(0x101);
    address private constant CANCELLER = address(0x102);
    address private constant GOVERNANCE_EXECUTOR = address(0x103);
    address private constant PAUSER = address(0x104);

    uint256 private ownerKey = 0xA11CE;
    uint256 private solverKey = 0xB0B;
    address private solver;

    VerifierToken private base;
    VerifierToken private quote;
    VerifierV3Factory private factory;
    VerifierV3Pool private pool;
    VerifierPerp private perp;
    ProtocolConfig private config;
    SolverRegistry private solverRegistry;
    VerifierAdmissionRegistry private admissionRegistry;
    PackageVerifier private verifier;
    UniswapV3SpotPort private spotPort;
    VerifierStrategyAccount private strategy;

    function setUp() public {
        solver = vm.addr(solverKey);
        base = new VerifierToken("Base", "BASE");
        quote = new VerifierToken("Quote", "QUOTE");
        factory = new VerifierV3Factory();
        pool = new VerifierV3Pool(address(factory), address(base), address(quote), POOL_FEE);
        factory.setPool(address(base), address(quote), POOL_FEE, address(pool));
        perp = new VerifierPerp();
        config = new ProtocolConfig(
            "eip155:31337", 1, DOMAIN_MANIFEST_HASH, 1, PROPOSER, CANCELLER, GOVERNANCE_EXECUTOR, PAUSER
        );
        solverRegistry = new SolverRegistry(config, solver);
        admissionRegistry = new VerifierAdmissionRegistry(config);
        verifier = new PackageVerifier(config, solverRegistry, ResourceRegistry(address(admissionRegistry)));
        spotPort = new UniswapV3SpotPort(address(verifier), _spotDeployment());
        strategy = new VerifierStrategyAccount(vm.addr(ownerKey));

        base.mint(address(pool), 100 ether);
        quote.mint(address(strategy), 20 ether);
        vm.prank(PROPOSER);
        config.scheduleUnpause();
        vm.warp(block.timestamp + 1);
        vm.prank(GOVERNANCE_EXECUTOR);
        config.activateUnpause();
    }

    function testValidPackageRecordsAuthoritativeReceipt() public {
        (PackageVerifier.Execution memory execution, ResourceRegistry.CashCarryAdmission memory admission) = _entry();
        admissionRegistry.setExpectedAdmissionHash(keccak256(abi.encode(admission)));
        (bytes memory traderSignature, bytes memory solverSignature) = _sign(execution, admission);

        bytes32 receiptHash = strategy.executeEntry(
            verifier, execution, admission, traderSignature, solverSignature, _tradeArgs(-int128(int256(QUANTITY)))
        );

        assertEq(base.balanceOf(address(strategy)), QUANTITY);
        assertEq(quote.balanceOf(address(strategy)), 18 ether);
        assertEq(verifier.nextNonce(address(strategy)), 1);
        PackageVerifier.Receipt memory receipt_ = verifier.receipt(receiptHash);
        assertEq(receipt_.strategyAccount, address(strategy));
        assertEq(receipt_.spotQuoteAtoms, 2 ether);
        assertEq(receipt_.postPerpSizeWad, -int128(int256(QUANTITY)));
        assertEq(receipt_.postPerpBalanceWad, int128(int256(MARGIN)));
        assertEq(receipt_.postPerpEntryNotionalWad, uint128(2 ether));
    }

    function testWrongSpotFillCommitmentReverts() public {
        (PackageVerifier.Execution memory execution, ResourceRegistry.CashCarryAdmission memory admission) = _entry();
        admissionRegistry.setExpectedAdmissionHash(keccak256(abi.encode(admission)));
        (bytes memory traderSignature, bytes memory solverSignature) = _sign(execution, admission);

        vm.expectRevert(PackageVerifier.InvalidSpotFill.selector);
        strategy.executeEntryWithWrongSpotFillCommitment(
            verifier, execution, admission, traderSignature, solverSignature
        );
        assertEq(verifier.nextNonce(address(strategy)), 0);
    }

    function testReplayRevertsBeforeAnotherExecution() public {
        (PackageVerifier.Execution memory execution, ResourceRegistry.CashCarryAdmission memory admission) = _entry();
        admissionRegistry.setExpectedAdmissionHash(keccak256(abi.encode(admission)));
        (bytes memory traderSignature, bytes memory solverSignature) = _sign(execution, admission);
        bytes32[2] memory args = _tradeArgs(-int128(int256(QUANTITY)));
        strategy.executeEntry(verifier, execution, admission, traderSignature, solverSignature, args);

        vm.expectRevert(PackageVerifier.InvalidNonce.selector);
        strategy.executeEntry(verifier, execution, admission, traderSignature, solverSignature, args);
    }

    function testFinalPositionFailureRollsBackSpotAndPerp() public {
        (PackageVerifier.Execution memory execution, ResourceRegistry.CashCarryAdmission memory admission) = _entry();
        admissionRegistry.setExpectedAdmissionHash(keccak256(abi.encode(admission)));
        (bytes memory traderSignature, bytes memory solverSignature) = _sign(execution, admission);
        uint256 strategyBaseBefore = base.balanceOf(address(strategy));
        uint256 strategyQuoteBefore = quote.balanceOf(address(strategy));
        uint256 poolBaseBefore = base.balanceOf(address(pool));
        uint256 poolQuoteBefore = quote.balanceOf(address(pool));

        vm.expectRevert(PackageVerifier.PostconditionFailed.selector);
        strategy.executeEntry(
            verifier, execution, admission, traderSignature, solverSignature, _tradeArgs(-int128(int256(2 ether)))
        );

        assertEq(base.balanceOf(address(strategy)), strategyBaseBefore);
        assertEq(quote.balanceOf(address(strategy)), strategyQuoteBefore);
        assertEq(base.balanceOf(address(pool)), poolBaseBefore);
        assertEq(quote.balanceOf(address(pool)), poolQuoteBefore);
        assertEq(perp.getPosition(address(perp), PERP_EXPIRY, address(strategy)).size, 0);
        assertEq(verifier.nextNonce(address(strategy)), 0);
    }

    function _entry()
        private
        view
        returns (PackageVerifier.Execution memory execution, ResourceRegistry.CashCarryAdmission memory admission)
    {
        execution = PackageVerifier.Execution({
            domainIdHash: keccak256("eip155:31337"),
            domainManifestVersion: 1,
            domainManifestHash: DOMAIN_MANIFEST_HASH,
            orderHash: keccak256("order"),
            quoteHash: keccak256("quote"),
            routeHash: keccak256("route"),
            spotFillCommitment: keccak256("spot-fill"),
            action: verifier.ENTRY(),
            strategyAccount: address(strategy),
            solver: solver,
            spotPort: address(spotPort),
            perpObserver: address(perp),
            perpInstrument: address(perp),
            perpExpiry: PERP_EXPIRY,
            baseToken: address(base),
            quoteToken: address(quote),
            baseQuantityAtoms: QUANTITY,
            perpQuantityWad: QUANTITY,
            spotQuoteBoundAtoms: 3 ether,
            packageNotionalQuoteAtoms: 2 ether,
            expectedPrePerpBalanceWad: 0,
            expectedPrePerpSizeWad: 0,
            expectedPrePerpEntryNotionalWad: 0,
            expectedPostPerpSizeWad: -int128(int256(QUANTITY)),
            minimumPostPerpBalanceWad: int128(int256(MARGIN)),
            maximumPostPerpBalanceWad: int128(int256(MARGIN)),
            maximumPostPerpEntryNotionalWad: uint128(3 ether),
            entryReceiptHash: bytes32(0),
            nonce: 0,
            deadline: block.timestamp + 1 hours
        });

        admission.domain = ResourceRegistry.DomainRef({
            domainIdHash: execution.domainIdHash,
            manifestVersion: execution.domainManifestVersion,
            manifestHash: execution.domainManifestHash
        });
        admission.action = execution.action;
        admission.packageNotionalQuoteAtoms = execution.packageNotionalQuoteAtoms;
        admission.spot.adapter.localAddress = address(spotPort);
        admission.perpetual.adapter.localAddress = address(verifier);
        admission.perpetual.venue.localAddress = address(perp);
        admission.perpetual.market.localAddress = address(perp);
        admission.baseAsset.localAddress = address(base);
        admission.quoteAsset.localAddress = address(quote);
        admission.spot.quantityAtoms = QUANTITY;
        admission.perpetual.quantityAtoms = QUANTITY;
    }

    function _sign(PackageVerifier.Execution memory execution, ResourceRegistry.CashCarryAdmission memory admission)
        private
        view
        returns (bytes memory traderSignature, bytes memory solverSignature)
    {
        traderSignature = _signature(ownerKey, verifier.traderPermitDigest(execution, admission));
        solverSignature = _signature(solverKey, verifier.solverAuthorizationDigest(execution, admission));
    }

    function _signature(uint256 key, bytes32 digest) private pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _tradeArgs(int128 sizeDelta) private view returns (bytes32[2] memory args) {
        args[0] = bytes32(uint256(block.timestamp + 1 hours) << 56 | uint256(PERP_EXPIRY));
        args[1] = bytes32(uint256(uint128(sizeDelta)) << 128 | MARGIN);
    }

    function _spotDeployment() private view returns (UniswapV3SpotPort.Deployment memory) {
        return UniswapV3SpotPort.Deployment({
            chainId: block.chainid,
            factory: address(factory),
            pool: address(pool),
            baseToken: IERC20(address(base)),
            quoteToken: IERC20(address(quote)),
            baseTokenDecimals: 18,
            quoteTokenDecimals: 18,
            poolFee: POOL_FEE,
            factoryCodeHash: address(factory).codehash,
            poolCodeHash: address(pool).codehash,
            baseTokenCodeHash: address(base).codehash,
            quoteTokenCodeHash: address(quote).codehash
        });
    }
}

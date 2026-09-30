// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "openzeppelin-contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/utils/ReentrancyGuard.sol";

/// @notice Solver performance bonds that pay harmed takers for objective, evidence-bound faults.
/// A solver locks a bond that covers named faults. The claims authority files a claim against a
/// unique fault evidence hash; the solver may dispute it inside the dispute window; an undisputed
/// claim pays once the window closes, and a disputed one pays only if the dispute resolver rejects
/// the dispute. No claim can promise more than the unencumbered bond, and after expiry, with no open
/// claim, the unpaid remainder returns to the solver exactly once.
contract PerformanceBondVault is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint8 public constant FAILED_TO_HONOR_FUNDED_RESERVATION = 1;
    uint8 public constant SUBMITTED_OFF_ROUTE = 2;
    uint8 public constant WITHHELD_REQUIRED_RECOVERY_ACTION = 3;
    /// Bit `fault` is set in a bond's `coveredFaults` for each fault it covers.
    uint8 private constant ALL_FAULTS = (1 << 1) | (1 << 2) | (1 << 3);

    enum ClaimState {
        NONE,
        PENDING,
        DISPUTED,
        PAID,
        REJECTED
    }

    struct Bond {
        address solver;
        IERC20 asset;
        uint256 bondAtoms;
        uint256 maximumPayoutPerClaim;
        /// Pending, disputed, and paid claims: what the bond can no longer promise again.
        uint256 encumberedAtoms;
        uint256 paidAtoms;
        uint64 disputeWindow;
        uint64 expiresAt;
        uint32 openClaims;
        uint8 coveredFaults;
        bool released;
    }

    struct Claim {
        uint8 fault;
        ClaimState state;
        uint64 filedAt;
        address beneficiary;
        uint256 payoutAtoms;
    }

    error InvalidConfiguration();
    error InvalidBond();
    error BondExists();
    error BondUnknown();
    error BondClosed();
    error Unauthorized(address caller);
    error FaultNotCovered(uint8 fault);
    error InvalidClaim();
    error ClaimExists();
    error ClaimNotPending();
    error ClaimNotDisputed();
    error DisputeWindowClosed();
    error DisputeWindowOpen();
    error PayoutAboveCap();
    error PayoutAboveUnencumbered();
    error NotExpired();
    error OpenClaims();
    error TransferAmountMismatch();

    event BondOpened(
        bytes32 indexed bondId,
        address indexed solver,
        address indexed asset,
        uint256 bondAtoms,
        uint8 coveredFaults,
        uint64 expiresAt
    );
    event ClaimFiled(
        bytes32 indexed bondId, bytes32 indexed faultEvidenceHash, uint8 fault, uint256 payoutAtoms, address beneficiary
    );
    event ClaimDisputed(bytes32 indexed bondId, bytes32 indexed faultEvidenceHash);
    event ClaimResolved(bytes32 indexed bondId, bytes32 indexed faultEvidenceHash, bool disputeUpheld);
    event ClaimPaid(
        bytes32 indexed bondId, bytes32 indexed faultEvidenceHash, address indexed beneficiary, uint256 payoutAtoms
    );
    event BondReleased(bytes32 indexed bondId, address indexed solver, uint256 returnedAtoms);

    address public immutable claimsAuthority;
    address public immutable disputeResolver;
    mapping(bytes32 bondId => Bond) private _bonds;
    mapping(bytes32 bondId => mapping(bytes32 faultEvidenceHash => Claim)) private _claims;

    constructor(address claimsAuthority_, address disputeResolver_) {
        if (claimsAuthority_ == address(0) || disputeResolver_ == address(0) || claimsAuthority_ == disputeResolver_) {
            revert InvalidConfiguration();
        }
        claimsAuthority = claimsAuthority_;
        disputeResolver = disputeResolver_;
    }

    function bond(bytes32 bondId) external view returns (Bond memory) {
        return _bonds[bondId];
    }

    function claim(bytes32 bondId, bytes32 faultEvidenceHash) external view returns (Claim memory) {
        return _claims[bondId][faultEvidenceHash];
    }

    /// @notice Locks `bondAtoms` of `asset` from the caller, who becomes the bonded solver.
    function openBond(
        bytes32 bondId,
        IERC20 asset,
        uint256 bondAtoms,
        uint8 coveredFaults,
        uint256 maximumPayoutPerClaim,
        uint64 disputeWindow,
        uint64 expiresAt
    ) external nonReentrant {
        if (
            bondId == bytes32(0) || address(asset).code.length == 0 || bondAtoms == 0 || coveredFaults == 0
                || coveredFaults & ~ALL_FAULTS != 0 || maximumPayoutPerClaim == 0 || maximumPayoutPerClaim > bondAtoms
                || disputeWindow == 0 || expiresAt <= block.timestamp
        ) revert InvalidBond();
        if (_bonds[bondId].solver != address(0)) revert BondExists();
        _bonds[bondId] = Bond({
            solver: msg.sender,
            asset: asset,
            bondAtoms: bondAtoms,
            maximumPayoutPerClaim: maximumPayoutPerClaim,
            encumberedAtoms: 0,
            paidAtoms: 0,
            disputeWindow: disputeWindow,
            expiresAt: expiresAt,
            openClaims: 0,
            coveredFaults: coveredFaults,
            released: false
        });
        // The bond is exactly what arrived: a token that skims transfers cannot back a bond.
        uint256 before = asset.balanceOf(address(this));
        asset.safeTransferFrom(msg.sender, address(this), bondAtoms);
        if (asset.balanceOf(address(this)) - before != bondAtoms) revert TransferAmountMismatch();
        emit BondOpened(bondId, msg.sender, address(asset), bondAtoms, coveredFaults, expiresAt);
    }

    /// @notice Files a claim for one objective fault, bound to its unique evidence hash.
    function fileClaim(bytes32 bondId, bytes32 faultEvidenceHash, uint8 fault, uint256 payoutAtoms, address beneficiary)
        external
    {
        if (msg.sender != claimsAuthority) revert Unauthorized(msg.sender);
        Bond storage entry = _existing(bondId);
        if (entry.released || block.timestamp >= entry.expiresAt) revert BondClosed();
        if (fault == 0 || fault > 7 || entry.coveredFaults & (uint8(1) << fault) == 0) revert FaultNotCovered(fault);
        if (faultEvidenceHash == bytes32(0) || beneficiary == address(0) || beneficiary == entry.solver) {
            revert InvalidClaim();
        }
        if (_claims[bondId][faultEvidenceHash].state != ClaimState.NONE) revert ClaimExists();
        if (payoutAtoms == 0 || payoutAtoms > entry.maximumPayoutPerClaim) revert PayoutAboveCap();
        if (entry.encumberedAtoms + payoutAtoms > entry.bondAtoms) revert PayoutAboveUnencumbered();
        entry.encumberedAtoms += payoutAtoms;
        entry.openClaims += 1;
        _claims[bondId][faultEvidenceHash] = Claim({
            fault: fault,
            state: ClaimState.PENDING,
            filedAt: uint64(block.timestamp),
            beneficiary: beneficiary,
            payoutAtoms: payoutAtoms
        });
        emit ClaimFiled(bondId, faultEvidenceHash, fault, payoutAtoms, beneficiary);
    }

    /// @notice The bonded solver contests a pending claim inside its dispute window.
    function disputeClaim(bytes32 bondId, bytes32 faultEvidenceHash) external {
        Bond storage entry = _existing(bondId);
        if (msg.sender != entry.solver) revert Unauthorized(msg.sender);
        Claim storage filed = _claims[bondId][faultEvidenceHash];
        if (filed.state != ClaimState.PENDING) revert ClaimNotPending();
        if (block.timestamp >= uint256(filed.filedAt) + entry.disputeWindow) revert DisputeWindowClosed();
        filed.state = ClaimState.DISPUTED;
        emit ClaimDisputed(bondId, faultEvidenceHash);
    }

    /// @notice The dispute resolver decides a disputed claim: an upheld dispute rejects the claim.
    function resolveDispute(bytes32 bondId, bytes32 faultEvidenceHash, bool disputeUpheld) external nonReentrant {
        if (msg.sender != disputeResolver) revert Unauthorized(msg.sender);
        Bond storage entry = _existing(bondId);
        Claim storage filed = _claims[bondId][faultEvidenceHash];
        if (filed.state != ClaimState.DISPUTED) revert ClaimNotDisputed();
        emit ClaimResolved(bondId, faultEvidenceHash, disputeUpheld);
        if (disputeUpheld) {
            filed.state = ClaimState.REJECTED;
            entry.encumberedAtoms -= filed.payoutAtoms;
            entry.openClaims -= 1;
        } else {
            _pay(bondId, faultEvidenceHash, entry, filed);
        }
    }

    /// @notice Pays an undisputed claim once its dispute window has closed. Anyone may call it.
    function settleClaim(bytes32 bondId, bytes32 faultEvidenceHash) external nonReentrant {
        Bond storage entry = _existing(bondId);
        Claim storage filed = _claims[bondId][faultEvidenceHash];
        if (filed.state != ClaimState.PENDING) revert ClaimNotPending();
        if (block.timestamp < uint256(filed.filedAt) + entry.disputeWindow) revert DisputeWindowOpen();
        _pay(bondId, faultEvidenceHash, entry, filed);
    }

    /// @notice After expiry, with no open claim, returns the unpaid remainder to the solver once.
    function release(bytes32 bondId) external nonReentrant {
        Bond storage entry = _existing(bondId);
        if (entry.released) revert BondClosed();
        if (block.timestamp < entry.expiresAt) revert NotExpired();
        if (entry.openClaims != 0) revert OpenClaims();
        entry.released = true;
        uint256 returned = entry.bondAtoms - entry.paidAtoms;
        emit BondReleased(bondId, entry.solver, returned);
        if (returned != 0) entry.asset.safeTransfer(entry.solver, returned);
    }

    function _existing(bytes32 bondId) private view returns (Bond storage entry) {
        entry = _bonds[bondId];
        if (entry.solver == address(0)) revert BondUnknown();
    }

    function _pay(bytes32 bondId, bytes32 faultEvidenceHash, Bond storage entry, Claim storage filed) private {
        filed.state = ClaimState.PAID;
        entry.paidAtoms += filed.payoutAtoms;
        entry.openClaims -= 1;
        emit ClaimPaid(bondId, faultEvidenceHash, filed.beneficiary, filed.payoutAtoms);
        entry.asset.safeTransfer(filed.beneficiary, filed.payoutAtoms);
    }
}

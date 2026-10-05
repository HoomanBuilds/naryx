use anchor_lang::prelude::*;

use crate::{
    error::ErrorCode,
    state::{domain_ref_identity_hash, ManifestRef},
    wire::{DomainRef, HASH_BYTE_LENGTH},
};

pub const HARD_MAX_TOTAL_FEE_BPS: u16 = 1_000;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace, Debug)]
pub enum FeePolicyDirection {
    Entry,
    Exit,
}

impl FeePolicyDirection {
    pub fn seed(self) -> [u8; 1] {
        [match self {
            Self::Entry => 1,
            Self::Exit => 2,
        }]
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, InitSpace, Debug)]
pub struct PendingFeePolicy {
    pub version: u32,
    pub manifest_hash: [u8; HASH_BYTE_LENGTH],
    pub maximum_protocol_fee_bps: u16,
    pub maximum_solver_fee_bps: u16,
    pub protocol_fee_recipient: Pubkey,
    pub activation_slot: u64,
}

#[account]
#[derive(InitSpace)]
pub struct FeePolicyRecord {
    pub domain: DomainRef,
    pub domain_identity_hash: [u8; HASH_BYTE_LENGTH],
    pub direction: FeePolicyDirection,
    pub quote_asset: ManifestRef,
    pub active_version: u32,
    pub active_manifest_hash: [u8; HASH_BYTE_LENGTH],
    pub maximum_protocol_fee_bps: u16,
    pub maximum_solver_fee_bps: u16,
    pub protocol_fee_recipient: Pubkey,
    pub paused: bool,
    pub pending: Option<PendingFeePolicy>,
    pub pending_resume_slot: Option<u64>,
    pub bump: u8,
}

impl FeePolicyRecord {
    pub fn validate_identity(
        &self,
        domain: &DomainRef,
        direction: FeePolicyDirection,
        quote_asset: &ManifestRef,
    ) -> Result<()> {
        require!(
            self.domain == *domain
                && self.domain_identity_hash == domain_ref_identity_hash(domain)
                && self.direction == direction
                && self.quote_asset == *quote_asset,
            ErrorCode::FeePolicyIdentityMismatch
        );
        Ok(())
    }

    pub fn validate_fees(
        &self,
        expected_version: u32,
        expected_manifest_hash: [u8; HASH_BYTE_LENGTH],
        package_notional_atoms: u64,
        protocol_fee_atoms: u64,
        solver_fee_atoms: u64,
    ) -> Result<()> {
        require!(
            self.active_version != 0
                && !self.paused
                && self.active_version == expected_version
                && self.active_manifest_hash == expected_manifest_hash,
            ErrorCode::FeePolicyNotActive
        );
        require!(
            package_notional_atoms != 0,
            ErrorCode::FeePolicyNotionalZero
        );
        require!(
            within_bps_cap(
                protocol_fee_atoms,
                package_notional_atoms,
                self.maximum_protocol_fee_bps,
            ) && within_bps_cap(
                solver_fee_atoms,
                package_notional_atoms,
                self.maximum_solver_fee_bps,
            ),
            ErrorCode::FeePolicyFeeExceeded
        );
        Ok(())
    }
}

fn within_bps_cap(fee_atoms: u64, notional_atoms: u64, cap_bps: u16) -> bool {
    u128::from(fee_atoms) * 10_000 <= u128::from(notional_atoms) * u128::from(cap_bps)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wire::DomainRef;

    fn record() -> FeePolicyRecord {
        FeePolicyRecord {
            domain: DomainRef::new("solana:devnet", 1, [0x11; 32]).unwrap(),
            domain_identity_hash: domain_ref_identity_hash(
                &DomainRef::new("solana:devnet", 1, [0x11; 32]).unwrap(),
            ),
            direction: FeePolicyDirection::Entry,
            quote_asset: ManifestRef {
                subject_id: [0x22; 32],
                manifest_version: 3,
                manifest_hash: [0x33; 32],
            },
            active_version: 7,
            active_manifest_hash: [0x44; 32],
            maximum_protocol_fee_bps: 10,
            maximum_solver_fee_bps: 25,
            protocol_fee_recipient: Pubkey::new_unique(),
            paused: false,
            pending: None,
            pending_resume_slot: None,
            bump: 1,
        }
    }

    #[test]
    fn exact_caps_pass_and_one_atom_over_fails() {
        let policy = record();
        policy
            .validate_fees(7, [0x44; 32], 1_000_000, 1_000, 2_500)
            .unwrap();
        assert!(policy
            .validate_fees(7, [0x44; 32], 1_000_000, 1_001, 2_500)
            .is_err());
        assert!(policy
            .validate_fees(7, [0x44; 32], 1_000_000, 1_000, 2_501)
            .is_err());
    }

    #[test]
    fn stale_or_paused_policy_fails_closed() {
        let mut policy = record();
        assert!(policy
            .validate_fees(8, [0x44; 32], 1_000_000, 0, 0)
            .is_err());
        policy.paused = true;
        assert!(policy
            .validate_fees(7, [0x44; 32], 1_000_000, 0, 0)
            .is_err());
    }
}

use anchor_lang::prelude::*;

use crate::{
    error::ErrorCode,
    state::{domain_ref_identity_hash, Lifecycle, ManifestRef},
    wire::{DomainRef, HASH_BYTE_LENGTH},
};

pub const RISK_DOMAIN_SCHEMA_VERSION: u32 = 1;
pub const MAXIMUM_RISK_DOMAIN_SERIES: usize = 16;
pub const MAXIMUM_RISK_DOMAIN_DEPENDENCIES: usize = 32;
pub const MAXIMUM_RISK_DOMAIN_LEVERAGE_BPS: u64 = 1_000_000;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, InitSpace, Debug)]
pub struct RiskDomainSeriesRef {
    pub series_id: [u8; HASH_BYTE_LENGTH],
    pub manifest_version: u32,
    pub manifest_hash: [u8; HASH_BYTE_LENGTH],
}

impl RiskDomainSeriesRef {
    pub fn validate(&self) -> Result<()> {
        require!(
            self.series_id != [0u8; HASH_BYTE_LENGTH]
                && self.manifest_version != 0
                && self.manifest_hash != [0u8; HASH_BYTE_LENGTH],
            ErrorCode::RiskDomainSeriesInvalid
        );
        Ok(())
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, InitSpace, Debug)]
pub struct RiskDomainDependencyLimit {
    pub dependency_id: [u8; HASH_BYTE_LENGTH],
    pub maximum_gross_quote_atoms: u128,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, InitSpace, Debug)]
pub struct RiskDomainDependencyExposure {
    pub dependency_id: [u8; HASH_BYTE_LENGTH],
    pub gross_quote_atoms: u128,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, InitSpace, Debug)]
pub struct RiskDomainPolicyV1 {
    pub schema_version: u32,
    pub manifest_version: u32,
    pub manifest_hash: [u8; HASH_BYTE_LENGTH],
    pub domain_ref_identity_hash: [u8; HASH_BYTE_LENGTH],
    pub accounting_asset: ManifestRef,
    pub gross_cap_quote_atoms: u128,
    pub net_cap_quote_atoms: u128,
    pub minimum_margin_floor_quote_atoms: u128,
    pub maximum_leverage_bps: u64,
    pub maximum_staleness_ms: u64,
    pub maximum_time_to_unwind_ms: u64,
    pub required_recovery_reserve_quote_atoms: u128,
    pub aggregate_haircut_bps: u16,
    #[max_len(16)]
    pub eligible_series: Vec<RiskDomainSeriesRef>,
    #[max_len(32)]
    pub dependency_limits: Vec<RiskDomainDependencyLimit>,
}

impl RiskDomainPolicyV1 {
    pub fn validate(&self, domain: &DomainRef) -> Result<()> {
        require!(
            self.schema_version == RISK_DOMAIN_SCHEMA_VERSION,
            ErrorCode::RiskDomainSchemaUnsupported
        );
        require!(
            self.manifest_version != 0 && self.manifest_hash != [0u8; HASH_BYTE_LENGTH],
            ErrorCode::RiskDomainManifestInvalid
        );
        require!(
            self.domain_ref_identity_hash == domain_ref_identity_hash(domain),
            ErrorCode::RiskDomainDomainMismatch
        );
        self.accounting_asset.validate()?;
        require!(
            self.gross_cap_quote_atoms != 0
                && self.net_cap_quote_atoms != 0
                && self.net_cap_quote_atoms <= self.gross_cap_quote_atoms
                && self.minimum_margin_floor_quote_atoms != 0
                && self.minimum_margin_floor_quote_atoms <= self.gross_cap_quote_atoms
                && self.required_recovery_reserve_quote_atoms != 0
                && self.required_recovery_reserve_quote_atoms <= self.gross_cap_quote_atoms,
            ErrorCode::RiskDomainLimitInvalid
        );
        require!(
            self.maximum_leverage_bps != 0
                && self.maximum_leverage_bps <= MAXIMUM_RISK_DOMAIN_LEVERAGE_BPS,
            ErrorCode::RiskDomainLeverageInvalid
        );
        require!(
            self.maximum_staleness_ms != 0 && self.maximum_time_to_unwind_ms != 0,
            ErrorCode::RiskDomainTimingInvalid
        );
        require!(
            self.aggregate_haircut_bps <= 10_000,
            ErrorCode::RiskDomainHaircutInvalid
        );
        require!(
            !self.eligible_series.is_empty()
                && self.eligible_series.len() <= MAXIMUM_RISK_DOMAIN_SERIES,
            ErrorCode::RiskDomainSeriesInvalid
        );
        let mut previous_series = None;
        for series in &self.eligible_series {
            series.validate()?;
            let key = (
                series.series_id,
                series.manifest_version,
                series.manifest_hash,
            );
            if let Some(previous) = previous_series {
                require!(key > previous, ErrorCode::RiskDomainSeriesInvalid);
            }
            previous_series = Some(key);
        }
        require!(
            !self.dependency_limits.is_empty()
                && self.dependency_limits.len() <= MAXIMUM_RISK_DOMAIN_DEPENDENCIES,
            ErrorCode::RiskDomainDependencyInvalid
        );
        let mut previous_dependency = None;
        for dependency in &self.dependency_limits {
            require!(
                dependency.dependency_id != [0u8; HASH_BYTE_LENGTH]
                    && dependency.maximum_gross_quote_atoms != 0
                    && dependency.maximum_gross_quote_atoms <= self.gross_cap_quote_atoms,
                ErrorCode::RiskDomainDependencyInvalid
            );
            if let Some(previous) = previous_dependency {
                require!(
                    dependency.dependency_id > previous,
                    ErrorCode::RiskDomainDependencyInvalid
                );
            }
            previous_dependency = Some(dependency.dependency_id);
        }
        Ok(())
    }

    pub fn minimum_margin_atoms(&self, gross_quote_atoms: u128) -> Result<u128> {
        require!(
            gross_quote_atoms != 0 && gross_quote_atoms <= self.gross_cap_quote_atoms,
            ErrorCode::RiskDomainExposureExceeded
        );
        let numerator = gross_quote_atoms
            .checked_mul(10_000)
            .ok_or_else(|| error!(ErrorCode::RiskDomainArithmeticOverflow))?;
        let leverage = u128::from(self.maximum_leverage_bps);
        let leveraged = numerator
            .checked_add(leverage - 1)
            .ok_or_else(|| error!(ErrorCode::RiskDomainArithmeticOverflow))?
            / leverage;
        Ok(leveraged.max(self.minimum_margin_floor_quote_atoms))
    }

    pub fn supports_series(&self, requested: &RiskDomainSeriesRef) -> bool {
        self.eligible_series
            .binary_search_by(|series| {
                (
                    series.series_id,
                    series.manifest_version,
                    series.manifest_hash,
                )
                    .cmp(&(
                        requested.series_id,
                        requested.manifest_version,
                        requested.manifest_hash,
                    ))
            })
            .is_ok()
    }

    pub fn dependency_cap(&self, dependency_id: &[u8; HASH_BYTE_LENGTH]) -> Option<u128> {
        self.dependency_limits
            .binary_search_by_key(dependency_id, |dependency| dependency.dependency_id)
            .ok()
            .map(|index| self.dependency_limits[index].maximum_gross_quote_atoms)
    }
}

#[account]
#[derive(InitSpace)]
pub struct RiskDomainRecord {
    pub domain: DomainRef,
    pub risk_domain_id: [u8; HASH_BYTE_LENGTH],
    pub policy: RiskDomainPolicyV1,
    pub lifecycle: Lifecycle,
    pub active: bool,
    pub bump: u8,
}

impl RiskDomainRecord {
    pub fn validate_entry(
        &self,
        domain: &DomainRef,
        series: &RiskDomainSeriesRef,
        gross_quote_atoms: u128,
        net_quote_atoms: u128,
        margin_quote_atoms: u128,
        reserved_recovery_quote_atoms: u128,
        observation_age_ms: u64,
        time_to_unwind_ms: u64,
        dependency_exposures: &[RiskDomainDependencyExposure],
    ) -> Result<u128> {
        require!(
            self.active && self.lifecycle.allows_entry() && self.domain == *domain,
            ErrorCode::RiskDomainEntryUnavailable
        );
        require!(
            self.policy.supports_series(series),
            ErrorCode::RiskDomainSeriesUnsupported
        );
        require!(
            net_quote_atoms <= self.policy.net_cap_quote_atoms,
            ErrorCode::RiskDomainExposureExceeded
        );
        let required_margin = self.policy.minimum_margin_atoms(gross_quote_atoms)?;
        require!(
            margin_quote_atoms >= required_margin,
            ErrorCode::RiskDomainMarginInsufficient
        );
        require!(
            reserved_recovery_quote_atoms >= self.policy.required_recovery_reserve_quote_atoms,
            ErrorCode::RiskDomainRecoveryReserveInsufficient
        );
        require!(
            observation_age_ms <= self.policy.maximum_staleness_ms,
            ErrorCode::RiskDomainObservationStale
        );
        require!(
            time_to_unwind_ms <= self.policy.maximum_time_to_unwind_ms,
            ErrorCode::RiskDomainUnwindTooSlow
        );
        require!(
            dependency_exposures.len() == self.policy.dependency_limits.len(),
            ErrorCode::RiskDomainDependencyInvalid
        );
        let mut previous = None;
        for exposure in dependency_exposures {
            if let Some(previous_id) = previous {
                require!(
                    exposure.dependency_id > previous_id,
                    ErrorCode::RiskDomainDependencyInvalid
                );
            }
            let cap = self
                .policy
                .dependency_cap(&exposure.dependency_id)
                .ok_or_else(|| error!(ErrorCode::RiskDomainDependencyInvalid))?;
            require!(
                exposure.gross_quote_atoms <= cap,
                ErrorCode::RiskDomainDependencyExceeded
            );
            previous = Some(exposure.dependency_id);
        }
        Ok(required_margin)
    }

    pub fn validate_exit(
        &self,
        domain: &DomainRef,
        series: &RiskDomainSeriesRef,
        accounting_asset: &ManifestRef,
    ) -> Result<()> {
        require!(
            self.active && self.lifecycle.allows_exit() && self.domain == *domain,
            ErrorCode::RiskDomainIdentityMismatch
        );
        require!(
            self.policy.supports_series(series),
            ErrorCode::RiskDomainSeriesUnsupported
        );
        require!(
            self.policy.accounting_asset == *accounting_asset,
            ErrorCode::RiskDomainIdentityMismatch
        );
        Ok(())
    }
}

#[account]
#[derive(InitSpace)]
pub struct RiskDomainIndex {
    pub risk_domain_id: [u8; HASH_BYTE_LENGTH],
    pub latest_version: u32,
    pub active_record: Pubkey,
    pub pending_record: Pubkey,
    pub activation_slot: Option<u64>,
    pub entry_paused: bool,
    pub pending_resume_slot: Option<u64>,
    pub bump: u8,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy() -> (DomainRef, RiskDomainPolicyV1) {
        let domain = DomainRef::new("solana:devnet", 1, [0x11; 32]).unwrap();
        let policy = RiskDomainPolicyV1 {
            schema_version: RISK_DOMAIN_SCHEMA_VERSION,
            manifest_version: 1,
            manifest_hash: [0x22; 32],
            domain_ref_identity_hash: domain_ref_identity_hash(&domain),
            accounting_asset: ManifestRef {
                subject_id: [0x33; 32],
                manifest_version: 1,
                manifest_hash: [0x44; 32],
            },
            gross_cap_quote_atoms: 10_000_000,
            net_cap_quote_atoms: 2_000_000,
            minimum_margin_floor_quote_atoms: 500_000,
            maximum_leverage_bps: 50_000,
            maximum_staleness_ms: 5_000,
            maximum_time_to_unwind_ms: 60_000,
            required_recovery_reserve_quote_atoms: 100_000,
            aggregate_haircut_bps: 3_000,
            eligible_series: vec![RiskDomainSeriesRef {
                series_id: [0x55; 32],
                manifest_version: 2,
                manifest_hash: [0x66; 32],
            }],
            dependency_limits: vec![RiskDomainDependencyLimit {
                dependency_id: [0x77; 32],
                maximum_gross_quote_atoms: 4_000_000,
            }],
        };
        (domain, policy)
    }

    #[test]
    fn policy_enforces_margin_and_dependency_caps() {
        let (domain, policy) = policy();
        policy.validate(&domain).unwrap();
        let record = RiskDomainRecord {
            domain: domain.clone(),
            risk_domain_id: [0x88; 32],
            policy: policy.clone(),
            lifecycle: Lifecycle::Active,
            active: true,
            bump: 1,
        };
        let required = record
            .validate_entry(
                &domain,
                &policy.eligible_series[0],
                2_500_000,
                100_000,
                500_000,
                100_000,
                100,
                2_000,
                &[RiskDomainDependencyExposure {
                    dependency_id: [0x77; 32],
                    gross_quote_atoms: 3_000_000,
                }],
            )
            .unwrap();
        assert_eq!(required, 500_000);

        let mut excessive = policy.clone();
        excessive.required_recovery_reserve_quote_atoms = 10_000_001;
        assert!(excessive.validate(&domain).is_err());
    }
}

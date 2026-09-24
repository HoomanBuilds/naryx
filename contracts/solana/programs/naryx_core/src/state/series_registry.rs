use anchor_lang::prelude::*;
use solana_sha256_hasher::hashv;

use crate::{
    error::ErrorCode,
    state::{Lifecycle, ManifestRef, CASH_AND_CARRY_TEMPLATE_ID},
    wire::{DomainRef, ProtocolId, HASH_BYTE_LENGTH},
};

pub const CASH_CARRY_SERIES_BINDING_SCHEMA_VERSION: u32 = 1;
pub const CASH_CARRY_SERIES_TEMPLATE_VERSION: u32 = 1;
pub const CASH_CARRY_SERIES_SETTLEMENT_CLASS_VERSION: u32 = 1;
pub const CASH_CARRY_SERIES_ENTRY_SIDE_ASK: u8 = 1;
pub const ANNUALIZED_NET_YIELD_QUOTE_CONVENTION_ID: &str = "annualized-net-yield-v1";

pub const PROTOCOL_ID_IDENTITY_DOMAIN: &[u8] = b"CON/v1/protocol-id-identity";
pub const DOMAIN_REF_IDENTITY_DOMAIN: &[u8] = b"CON/v1/domain-ref-identity";
pub const SETTLEMENT_CLASS_IDENTITY_DOMAIN: &[u8] = b"CON/v1/settlement-class-identity";
pub const CASH_CARRY_SERIES_IDENTITY_DOMAIN: &[u8] = b"CON/v1/cash-carry-series-identity";
pub const CASH_CARRY_SERIES_BINDING_DOMAIN: &[u8] = b"CON/v1/cash-carry-series-binding";

const ATOMIC_POSTCONDITION_DISCRIMINANT: u8 = 1;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, InitSpace, Debug)]
pub struct CashCarrySeriesBindingV1 {
    pub schema_version: u32,
    pub binding_version: u32,
    pub domain_ref_identity_hash: [u8; HASH_BYTE_LENGTH],
    pub series_manifest_hash: [u8; HASH_BYTE_LENGTH],
    pub execution_class_manifest_hash: [u8; HASH_BYTE_LENGTH],
    pub template_identity_hash: [u8; HASH_BYTE_LENGTH],
    pub template_version: u32,
    pub template_manifest_hash: [u8; HASH_BYTE_LENGTH],
    pub settlement_class_identity_hash: [u8; HASH_BYTE_LENGTH],
    pub base_asset: ManifestRef,
    pub quote_asset: ManifestRef,
    pub quote_convention_identity_hash: [u8; HASH_BYTE_LENGTH],
    pub entry_side: u8,
    pub spot_base_atoms_per_package_unit: u128,
    pub perp_quantity_atoms_per_package_unit: u128,
}

impl CashCarrySeriesBindingV1 {
    pub fn validate(&self, domain: &DomainRef) -> Result<()> {
        require!(
            self.schema_version == CASH_CARRY_SERIES_BINDING_SCHEMA_VERSION,
            ErrorCode::SeriesBindingSchemaUnsupported
        );
        require!(
            self.binding_version != 0,
            ErrorCode::SeriesBindingVersionZero
        );
        require!(
            self.domain_ref_identity_hash == domain_ref_identity_hash(domain),
            ErrorCode::SeriesBindingDomainMismatch
        );
        require!(
            self.series_manifest_hash != [0u8; HASH_BYTE_LENGTH]
                && self.execution_class_manifest_hash != [0u8; HASH_BYTE_LENGTH]
                && self.template_manifest_hash != [0u8; HASH_BYTE_LENGTH],
            ErrorCode::SeriesBindingHashZero
        );
        require!(
            self.template_identity_hash == recognized_template_identity_hash()?
                && self.template_version == CASH_CARRY_SERIES_TEMPLATE_VERSION,
            ErrorCode::SeriesBindingTemplateUnsupported
        );
        require!(
            self.settlement_class_identity_hash == recognized_settlement_class_identity_hash(),
            ErrorCode::SeriesBindingSettlementUnsupported
        );
        self.base_asset.validate()?;
        self.quote_asset.validate()?;
        require!(
            self.base_asset.subject_id != self.quote_asset.subject_id,
            ErrorCode::SeriesBindingAssetMismatch
        );
        require!(
            self.quote_convention_identity_hash == recognized_quote_convention_identity_hash()?,
            ErrorCode::SeriesBindingQuoteConventionUnsupported
        );
        require!(
            self.entry_side == CASH_CARRY_SERIES_ENTRY_SIDE_ASK,
            ErrorCode::SeriesBindingEntrySideUnsupported
        );
        require!(
            self.spot_base_atoms_per_package_unit != 0
                && self.perp_quantity_atoms_per_package_unit != 0,
            ErrorCode::SeriesBindingUnitZero
        );
        Ok(())
    }

    pub fn identity_key(&self) -> [u8; HASH_BYTE_LENGTH] {
        hashv(&[
            CASH_CARRY_SERIES_IDENTITY_DOMAIN,
            self.domain_ref_identity_hash.as_ref(),
            self.series_manifest_hash.as_ref(),
            self.execution_class_manifest_hash.as_ref(),
        ])
        .to_bytes()
    }

    pub fn canonical_bytes(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(425);
        out.extend_from_slice(&self.schema_version.to_be_bytes());
        out.extend_from_slice(&self.binding_version.to_be_bytes());
        out.extend_from_slice(&self.domain_ref_identity_hash);
        out.extend_from_slice(&self.series_manifest_hash);
        out.extend_from_slice(&self.execution_class_manifest_hash);
        out.extend_from_slice(&self.template_identity_hash);
        out.extend_from_slice(&self.template_version.to_be_bytes());
        out.extend_from_slice(&self.template_manifest_hash);
        out.extend_from_slice(&self.settlement_class_identity_hash);
        append_manifest_ref(&mut out, &self.base_asset);
        append_manifest_ref(&mut out, &self.quote_asset);
        out.extend_from_slice(&self.quote_convention_identity_hash);
        out.push(self.entry_side);
        out.extend_from_slice(&self.spot_base_atoms_per_package_unit.to_be_bytes());
        out.extend_from_slice(&self.perp_quantity_atoms_per_package_unit.to_be_bytes());
        out
    }

    pub fn binding_hash(&self) -> [u8; HASH_BYTE_LENGTH] {
        let canonical = self.canonical_bytes();
        hashv(&[CASH_CARRY_SERIES_BINDING_DOMAIN, canonical.as_ref()]).to_bytes()
    }

    pub fn preserves_semantics_of(&self, previous: &Self) -> bool {
        self.schema_version == previous.schema_version
            && self.domain_ref_identity_hash == previous.domain_ref_identity_hash
            && self.series_manifest_hash == previous.series_manifest_hash
            && self.execution_class_manifest_hash == previous.execution_class_manifest_hash
            && self.template_identity_hash == previous.template_identity_hash
            && self.template_version == previous.template_version
            && self.template_manifest_hash == previous.template_manifest_hash
            && self.settlement_class_identity_hash == previous.settlement_class_identity_hash
            && self.base_asset.subject_id == previous.base_asset.subject_id
            && self.quote_asset.subject_id == previous.quote_asset.subject_id
            && self.quote_convention_identity_hash == previous.quote_convention_identity_hash
            && self.entry_side == previous.entry_side
            && self.spot_base_atoms_per_package_unit == previous.spot_base_atoms_per_package_unit
            && self.perp_quantity_atoms_per_package_unit
                == previous.perp_quantity_atoms_per_package_unit
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, InitSpace, Debug)]
pub struct PendingSeriesBindingControl {
    pub lifecycle: Lifecycle,
    pub activation_slot: u64,
}

#[account]
#[derive(InitSpace)]
pub struct CashCarrySeriesBindingRecord {
    pub domain: DomainRef,
    pub identity_key: [u8; HASH_BYTE_LENGTH],
    pub binding_hash: [u8; HASH_BYTE_LENGTH],
    pub binding: CashCarrySeriesBindingV1,
    pub lifecycle: Lifecycle,
    pub pending_control: Option<PendingSeriesBindingControl>,
    pub active: bool,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct CashCarrySeriesBindingIndex {
    pub identity_key: [u8; HASH_BYTE_LENGTH],
    pub latest_version: u32,
    pub active_record: Pubkey,
    pub active_binding_hash: [u8; HASH_BYTE_LENGTH],
    pub pending_record: Pubkey,
    pub pending_binding_hash: [u8; HASH_BYTE_LENGTH],
    pub activation_slot: Option<u64>,
    pub bump: u8,
}

pub fn protocol_id_identity_hash(id: &ProtocolId) -> [u8; HASH_BYTE_LENGTH] {
    let canonical = id.canonical_bytes();
    hashv(&[PROTOCOL_ID_IDENTITY_DOMAIN, canonical.as_ref()]).to_bytes()
}

pub fn domain_ref_identity_hash(domain: &DomainRef) -> [u8; HASH_BYTE_LENGTH] {
    let canonical = domain.canonical_bytes();
    hashv(&[DOMAIN_REF_IDENTITY_DOMAIN, canonical.as_ref()]).to_bytes()
}

pub fn settlement_class_identity_hash(discriminant: u8, version: u32) -> [u8; HASH_BYTE_LENGTH] {
    hashv(&[
        SETTLEMENT_CLASS_IDENTITY_DOMAIN,
        &[discriminant],
        version.to_be_bytes().as_ref(),
    ])
    .to_bytes()
}

pub fn recognized_template_identity_hash() -> Result<[u8; HASH_BYTE_LENGTH]> {
    Ok(protocol_id_identity_hash(&ProtocolId::new(
        CASH_AND_CARRY_TEMPLATE_ID,
    )?))
}

pub fn recognized_quote_convention_identity_hash() -> Result<[u8; HASH_BYTE_LENGTH]> {
    Ok(protocol_id_identity_hash(&ProtocolId::new(
        ANNUALIZED_NET_YIELD_QUOTE_CONVENTION_ID,
    )?))
}

pub fn recognized_settlement_class_identity_hash() -> [u8; HASH_BYTE_LENGTH] {
    settlement_class_identity_hash(
        ATOMIC_POSTCONDITION_DISCRIMINANT,
        CASH_CARRY_SERIES_SETTLEMENT_CLASS_VERSION,
    )
}

fn append_manifest_ref(out: &mut Vec<u8>, reference: &ManifestRef) {
    out.extend_from_slice(&reference.subject_id);
    out.extend_from_slice(&reference.manifest_version.to_be_bytes());
    out.extend_from_slice(&reference.manifest_hash);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decode_32(value: &str) -> [u8; 32] {
        let bytes = decode_hex(value);
        bytes.try_into().unwrap()
    }

    fn decode_hex(value: &str) -> Vec<u8> {
        value
            .as_bytes()
            .chunks_exact(2)
            .map(|pair| {
                let high = (pair[0] as char).to_digit(16).unwrap() as u8;
                let low = (pair[1] as char).to_digit(16).unwrap() as u8;
                (high << 4) | low
            })
            .collect()
    }

    fn binding() -> (DomainRef, CashCarrySeriesBindingV1) {
        let domain = DomainRef::new("eip155:8453", 7, [0x11; 32]).unwrap();
        let binding = CashCarrySeriesBindingV1 {
            schema_version: CASH_CARRY_SERIES_BINDING_SCHEMA_VERSION,
            binding_version: 9,
            domain_ref_identity_hash: domain_ref_identity_hash(&domain),
            series_manifest_hash: [0x22; 32],
            execution_class_manifest_hash: [0x33; 32],
            template_identity_hash: recognized_template_identity_hash().unwrap(),
            template_version: CASH_CARRY_SERIES_TEMPLATE_VERSION,
            template_manifest_hash: [0x44; 32],
            settlement_class_identity_hash: recognized_settlement_class_identity_hash(),
            base_asset: ManifestRef {
                subject_id: [0x55; 32],
                manifest_version: 3,
                manifest_hash: [0x66; 32],
            },
            quote_asset: ManifestRef {
                subject_id: [0x77; 32],
                manifest_version: 4,
                manifest_hash: [0x88; 32],
            },
            quote_convention_identity_hash: recognized_quote_convention_identity_hash().unwrap(),
            entry_side: CASH_CARRY_SERIES_ENTRY_SIDE_ASK,
            spot_base_atoms_per_package_unit: 1_000_000_000,
            perp_quantity_atoms_per_package_unit: 1_000_000,
        };
        (domain, binding)
    }

    #[test]
    fn shared_binding_vector_matches() {
        let (domain, binding) = binding();
        binding.validate(&domain).unwrap();
        assert_eq!(
            binding.domain_ref_identity_hash,
            decode_32("5c3367ef36475ec11ad5b392fc85a349b37d2fdad631c8da833aa0796897c14c")
        );
        assert_eq!(
            binding.template_identity_hash,
            decode_32("f124d7a5a2309c590f307ea911f59dc36c0dfc4203d081ac2fc05d0ee0a8206e")
        );
        assert_eq!(
            binding.quote_convention_identity_hash,
            decode_32("94f75da5f71975ba08a0bf694c183715be548bdce998210ac5924669c9c701a5")
        );
        assert_eq!(
            binding.settlement_class_identity_hash,
            decode_32("d859a5e58ad327a34dc770b146a6120cda0a194dd25734f9fec462a18e11e596")
        );
        assert_eq!(
            binding.identity_key(),
            decode_32("f3d7bc7a8c6cb3ac5a0b3ca45dfdd333143cb8af576749057e34cb6383840a5d")
        );
        assert_eq!(binding.canonical_bytes().len(), 405);
        assert_eq!(
            binding.binding_hash(),
            decode_32("e13ea9e6a47163a913f5caacd460b6ab8bc63e9c91ee46610efd30838870711b")
        );
    }

    #[test]
    fn identity_and_semantics_mutations_are_separated() {
        let (_, original) = binding();
        let mut asset_rotation = original.clone();
        asset_rotation.binding_version += 1;
        asset_rotation.base_asset.manifest_version += 1;
        asset_rotation.base_asset.manifest_hash = [0x91; 32];
        assert_eq!(asset_rotation.identity_key(), original.identity_key());
        assert!(asset_rotation.preserves_semantics_of(&original));

        let mut semantic_change = asset_rotation.clone();
        semantic_change.spot_base_atoms_per_package_unit += 1;
        assert_eq!(semantic_change.identity_key(), original.identity_key());
        assert!(!semantic_change.preserves_semantics_of(&original));

        let mut new_series = original.clone();
        new_series.series_manifest_hash = [0x92; 32];
        assert_ne!(new_series.identity_key(), original.identity_key());
    }

    #[test]
    fn malformed_binding_fields_fail_closed() {
        let (domain, original) = binding();
        let mut malformed = original.clone();
        malformed.spot_base_atoms_per_package_unit = 0;
        assert!(malformed.validate(&domain).is_err());

        malformed = original.clone();
        malformed.base_asset = malformed.quote_asset.clone();
        assert!(malformed.validate(&domain).is_err());

        malformed = original.clone();
        malformed.series_manifest_hash = [0u8; 32];
        assert!(malformed.validate(&domain).is_err());

        malformed = original;
        malformed.template_manifest_hash = [0u8; 32];
        assert!(malformed.validate(&domain).is_err());
    }
}

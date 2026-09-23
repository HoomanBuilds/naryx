use anchor_lang::prelude::*;
use solana_sha256_hasher::hashv;

use crate::error::ErrorCode;

pub mod package_order;
pub use package_order::*;

pub const PROTOCOL_ID_MAX_BYTES: usize = 128;
pub const HASH_BYTE_LENGTH: usize = 32;

const DOMAIN_MANIFEST_HASH_DOMAIN: &[u8] = b"CON/v1/domain-manifest";

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, InitSpace, Debug)]
pub struct ProtocolId {
    #[max_len(PROTOCOL_ID_MAX_BYTES)]
    value: String,
}

impl ProtocolId {
    pub fn new(value: &str) -> Result<Self> {
        require!(value.is_ascii(), ErrorCode::ProtocolIdNotAscii);
        require!(!value.is_empty(), ErrorCode::ProtocolIdEmpty);
        require!(
            value.len() <= PROTOCOL_ID_MAX_BYTES,
            ErrorCode::ProtocolIdTooLong
        );

        Ok(Self {
            value: value.to_string(),
        })
    }

    pub fn as_str(&self) -> &str {
        &self.value
    }

    pub fn canonical_bytes(&self) -> Vec<u8> {
        let value = self.value.as_bytes();
        let mut out = Vec::with_capacity(4 + value.len());
        out.extend_from_slice(&(value.len() as u32).to_be_bytes());
        out.extend_from_slice(value);
        out
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, InitSpace, Debug)]
pub struct DomainRef {
    #[max_len(PROTOCOL_ID_MAX_BYTES)]
    domain_id: String,
    domain_manifest_version: u32,
    domain_manifest_hash: [u8; HASH_BYTE_LENGTH],
}

impl DomainRef {
    pub fn new(
        domain_id: &str,
        domain_manifest_version: u32,
        domain_manifest_hash: [u8; HASH_BYTE_LENGTH],
    ) -> Result<Self> {
        require!(domain_id.is_ascii(), ErrorCode::DomainIdNotAscii);
        require!(!domain_id.is_empty(), ErrorCode::DomainIdEmpty);
        require!(
            domain_id.len() <= PROTOCOL_ID_MAX_BYTES,
            ErrorCode::DomainIdTooLong
        );
        let domain_id = ProtocolId::new(domain_id)?;
        require!(
            domain_manifest_version != 0,
            ErrorCode::DomainManifestVersionZero
        );
        require!(
            domain_manifest_hash != [0u8; HASH_BYTE_LENGTH],
            ErrorCode::DomainManifestHashZero
        );

        Ok(Self {
            domain_id: domain_id.value,
            domain_manifest_version,
            domain_manifest_hash,
        })
    }

    pub fn domain_id(&self) -> &str {
        &self.domain_id
    }

    pub fn domain_manifest_version(&self) -> u32 {
        self.domain_manifest_version
    }

    pub fn domain_manifest_hash(&self) -> [u8; HASH_BYTE_LENGTH] {
        self.domain_manifest_hash
    }

    // These bytes go into a signed preimage that TypeScript and Solidity rebuild independently,
    // so the layout is pinned to big-endian lengths and integers over raw hash bytes. Borsh
    // writes little-endian and ABI pads every field to 32 bytes, so neither codec emits it.
    pub fn canonical_bytes(&self) -> Vec<u8> {
        let id = self.domain_id.as_bytes();
        let mut out = Vec::with_capacity(4 + id.len() + 4 + HASH_BYTE_LENGTH);
        out.extend_from_slice(&(id.len() as u32).to_be_bytes());
        out.extend_from_slice(id);
        out.extend_from_slice(&self.domain_manifest_version.to_be_bytes());
        out.extend_from_slice(&self.domain_manifest_hash);
        out
    }
}

pub fn domain_manifest_hash(payload: &[u8]) -> [u8; HASH_BYTE_LENGTH] {
    hashv(&[DOMAIN_MANIFEST_HASH_DOMAIN, payload]).to_bytes()
}

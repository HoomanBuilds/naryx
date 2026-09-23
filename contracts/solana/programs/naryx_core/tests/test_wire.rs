use {
    anchor_lang::error::Error,
    naryx_core::{
        error::ErrorCode,
        wire::{
            domain_manifest_hash, DomainRef, ProtocolId, HASH_BYTE_LENGTH, PROTOCOL_ID_MAX_BYTES,
        },
    },
};

const DOMAIN_ID: &str = "eip155:8453:eth-carry-v1";

const DOMAIN_MANIFEST_HASH: [u8; HASH_BYTE_LENGTH] = [
    0x40, 0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x4b, 0x4c, 0x4d, 0x4e, 0x4f,
    0x50, 0x51, 0x52, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x5b, 0x5c, 0x5d, 0x5e, 0x5f,
];

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[test]
fn protocol_id_canonical_bytes_match_golden_vector() {
    let environment = ProtocolId::new("devnet").unwrap();

    assert_eq!(environment.as_str(), "devnet");
    assert_eq!(hex(&environment.canonical_bytes()), "000000066465766e6574");
}

#[test]
fn protocol_id_rejects_invalid_values() {
    let at_limit = "n".repeat(PROTOCOL_ID_MAX_BYTES);
    let above_limit = "n".repeat(PROTOCOL_ID_MAX_BYTES + 1);

    assert_eq!(
        ProtocolId::new("devn\u{e9}t").unwrap_err(),
        Error::from(ErrorCode::ProtocolIdNotAscii)
    );
    assert_eq!(
        ProtocolId::new("").unwrap_err(),
        Error::from(ErrorCode::ProtocolIdEmpty)
    );
    assert_eq!(
        ProtocolId::new(&above_limit).unwrap_err(),
        Error::from(ErrorCode::ProtocolIdTooLong)
    );
    assert!(ProtocolId::new(&at_limit).is_ok());
}

#[test]
fn domain_ref_canonical_bytes_match_golden_vector() {
    let domain = DomainRef::new(DOMAIN_ID, 1, DOMAIN_MANIFEST_HASH).unwrap();

    assert_eq!(
        hex(&domain.canonical_bytes()),
        "000000186569703135353a383435333a6574682d63617272792d7631\
         00000001\
         404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f"
    );
}

#[test]
fn domain_ref_rejects_invalid_id_zero_version_and_zero_hash() {
    let at_limit = "n".repeat(PROTOCOL_ID_MAX_BYTES);
    let above_limit = "n".repeat(PROTOCOL_ID_MAX_BYTES + 1);

    assert_eq!(
        DomainRef::new("eip155:8453:eth-carry-v\u{e9}", 1, DOMAIN_MANIFEST_HASH).unwrap_err(),
        Error::from(ErrorCode::DomainIdNotAscii)
    );
    assert_eq!(
        DomainRef::new("", 1, DOMAIN_MANIFEST_HASH).unwrap_err(),
        Error::from(ErrorCode::DomainIdEmpty)
    );
    assert_eq!(
        DomainRef::new(&above_limit, 1, DOMAIN_MANIFEST_HASH).unwrap_err(),
        Error::from(ErrorCode::DomainIdTooLong)
    );
    assert!(DomainRef::new(&at_limit, 1, DOMAIN_MANIFEST_HASH).is_ok());
    assert_eq!(
        DomainRef::new(DOMAIN_ID, 0, DOMAIN_MANIFEST_HASH).unwrap_err(),
        Error::from(ErrorCode::DomainManifestVersionZero)
    );
    assert_eq!(
        DomainRef::new(DOMAIN_ID, 1, [0u8; HASH_BYTE_LENGTH]).unwrap_err(),
        Error::from(ErrorCode::DomainManifestHashZero)
    );
}

#[test]
fn domain_manifest_hash_matches_golden_digest() {
    assert_eq!(
        hex(&domain_manifest_hash(&[0xde, 0xad, 0xbe, 0xef])),
        "23477888042591d383f277a7771e672974da63b843c66e5127e2fd8c1fc598ac"
    );
}

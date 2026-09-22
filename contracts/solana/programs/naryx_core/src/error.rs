use anchor_lang::prelude::*;

#[error_code]
pub enum ErrorCode {
    #[msg("Domain identifier is not ASCII")]
    DomainIdNotAscii,
    #[msg("Domain identifier is empty")]
    DomainIdEmpty,
    #[msg("Domain identifier is above the protocol identifier byte limit")]
    DomainIdTooLong,
    #[msg("Domain manifest version is zero")]
    DomainManifestVersionZero,
    #[msg("Domain manifest hash is all zero")]
    DomainManifestHashZero,
}

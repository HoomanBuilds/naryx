use anchor_lang::prelude::Pubkey;
use solana_sha256_hasher::hashv;

use crate::wire::DomainRef;

const RESERVATION_POLICY_DOMAIN: &[u8] = b"NARYX/firm-reservation-policy/v1";

#[allow(clippy::too_many_arguments)]
pub fn reservation_policy_hash(
    reservation_program: Pubkey,
    reservation_program_data: Pubkey,
    reservation_code_identity: [u8; 32],
    reservation_class: Pubkey,
    reservation_class_version: u16,
    domain: &DomainRef,
    base_mint: Pubkey,
    quote_mint: Pubkey,
    consumer_program: Pubkey,
    consumer_program_data: Pubkey,
    consumer_code_identity: [u8; 32],
) -> [u8; 32] {
    hashv(&[
        RESERVATION_POLICY_DOMAIN,
        reservation_program.as_ref(),
        reservation_program_data.as_ref(),
        &reservation_code_identity,
        reservation_class.as_ref(),
        &reservation_class_version.to_be_bytes(),
        &domain.canonical_bytes(),
        base_mint.as_ref(),
        quote_mint.as_ref(),
        consumer_program.as_ref(),
        consumer_program_data.as_ref(),
        &consumer_code_identity,
    ])
    .to_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn policy_hash_binds_code_class_domain_assets_and_consumer() {
        let domain = DomainRef::new("solana:devnet:naryx", 1, [1; 32]).unwrap();
        let args = (
            Pubkey::new_unique(),
            Pubkey::new_unique(),
            [2; 32],
            Pubkey::new_unique(),
            2,
            Pubkey::new_unique(),
            Pubkey::new_unique(),
            Pubkey::new_unique(),
            Pubkey::new_unique(),
            [3; 32],
        );
        let hash = reservation_policy_hash(
            args.0, args.1, args.2, args.3, args.4, &domain, args.5, args.6, args.7, args.8, args.9,
        );
        assert_eq!(
            hash,
            reservation_policy_hash(
                args.0, args.1, args.2, args.3, args.4, &domain, args.5, args.6, args.7, args.8,
                args.9
            )
        );
        assert_ne!(
            hash,
            reservation_policy_hash(
                args.0, args.1, [4; 32], args.3, args.4, &domain, args.5, args.6, args.7, args.8,
                args.9
            )
        );
        assert_ne!(
            hash,
            reservation_policy_hash(
                args.0,
                args.1,
                args.2,
                args.3,
                args.4,
                &DomainRef::new("solana:devnet:naryx", 2, [1; 32]).unwrap(),
                args.5,
                args.6,
                args.7,
                args.8,
                args.9
            )
        );
        assert_ne!(
            hash,
            reservation_policy_hash(
                args.0, args.1, args.2, args.3, args.4, &domain, args.6, args.5, args.7, args.8,
                args.9
            )
        );
    }
}

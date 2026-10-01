use solana_sha256_hasher::hashv;

pub const PROGRAM_DATA_HEADER_IDENTITY_DOMAIN: &[u8] = b"naryx.program-data-header.v1";
pub const PROGRAM_DATA_METADATA_LENGTH: usize = 45;
const PROGRAM_DATA_STATE: u32 = 3;

pub(crate) fn validate_program_data(data: &[u8]) -> bool {
    let Some(discriminator) = data.get(..4) else {
        return false;
    };
    data.len() > PROGRAM_DATA_METADATA_LENGTH
        && discriminator == PROGRAM_DATA_STATE.to_le_bytes()
        && matches!(data.get(12), Some(0 | 1))
}

// The upgradeable loader is the only writer of ProgramData. Every deploy or upgrade writes a
// strictly newer last-deploy slot (same-slot redeploys are rejected), set-authority rewrites the
// authority bytes, and extension changes the length, so the header plus length pins the ELF bytes
// without hashing them. The full ELF SHA-256 is verified off-chain at registration review.
pub fn program_data_header_identity(data: &[u8]) -> Option<[u8; 32]> {
    if !validate_program_data(data) {
        return None;
    }
    let length = u64::try_from(data.len()).ok()?;
    Some(
        hashv(&[
            PROGRAM_DATA_HEADER_IDENTITY_DOMAIN,
            &data[..PROGRAM_DATA_METADATA_LENGTH],
            &length.to_le_bytes(),
        ])
        .to_bytes(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn program_data(slot: u64, authority: Option<[u8; 32]>, code_length: usize) -> Vec<u8> {
        let mut data = vec![0x7f; PROGRAM_DATA_METADATA_LENGTH + code_length];
        data[..4].copy_from_slice(&PROGRAM_DATA_STATE.to_le_bytes());
        data[4..12].copy_from_slice(&slot.to_le_bytes());
        data[12] = u8::from(authority.is_some());
        data[13..45].copy_from_slice(&authority.unwrap_or([0; 32]));
        data
    }

    #[test]
    fn requires_program_data_state_metadata_and_code() {
        let mut valid = vec![0; PROGRAM_DATA_METADATA_LENGTH + 1];
        valid[..4].copy_from_slice(&PROGRAM_DATA_STATE.to_le_bytes());
        valid[12] = 1;
        assert!(validate_program_data(&valid));

        let mut wrong_state = valid.clone();
        wrong_state[..4].copy_from_slice(&2u32.to_le_bytes());
        assert!(!validate_program_data(&wrong_state));

        let mut wrong_authority_tag = valid.clone();
        wrong_authority_tag[12] = 2;
        assert!(!validate_program_data(&wrong_authority_tag));
        assert!(!validate_program_data(
            &valid[..PROGRAM_DATA_METADATA_LENGTH]
        ));
    }

    #[test]
    fn header_identity_binds_slot_authority_and_length_and_fails_closed() {
        let authority = [9; 32];
        let base = program_data(77, Some(authority), 4096);
        let identity = program_data_header_identity(&base).unwrap();

        let mut expected = PROGRAM_DATA_HEADER_IDENTITY_DOMAIN.to_vec();
        expected.extend_from_slice(&base[..PROGRAM_DATA_METADATA_LENGTH]);
        expected.extend_from_slice(&(base.len() as u64).to_le_bytes());
        assert_eq!(identity, hashv(&[&expected]).to_bytes());

        for changed in [
            program_data(78, Some(authority), 4096),
            program_data(77, Some([8; 32]), 4096),
            program_data(77, None, 4096),
            program_data(77, Some(authority), 4097),
        ] {
            assert_ne!(program_data_header_identity(&changed).unwrap(), identity);
        }

        let mut closed = base.clone();
        closed[..4].copy_from_slice(&0u32.to_le_bytes());
        assert_eq!(program_data_header_identity(&closed), None);
        assert_eq!(program_data_header_identity(&[]), None);
        assert_eq!(
            program_data_header_identity(&base[..PROGRAM_DATA_METADATA_LENGTH]),
            None
        );
    }
}

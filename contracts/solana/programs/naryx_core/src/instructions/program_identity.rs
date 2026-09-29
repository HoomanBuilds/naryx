const PROGRAM_DATA_METADATA_LENGTH: usize = 45;
const PROGRAM_DATA_STATE: u32 = 3;

pub(crate) fn validate_program_data(data: &[u8]) -> bool {
    let Some(discriminator) = data.get(..4) else {
        return false;
    };
    data.len() > PROGRAM_DATA_METADATA_LENGTH
        && discriminator == PROGRAM_DATA_STATE.to_le_bytes()
        && matches!(data.get(12), Some(0 | 1))
}

#[cfg(test)]
mod tests {
    use super::*;

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
}

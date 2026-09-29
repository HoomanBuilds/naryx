use anchor_lang::prelude::*;
use solana_instructions_sysvar::{load_current_index_checked, load_instruction_at_checked};
use solana_sdk_ids::ed25519_program;

const SIGNATURE_OFFSETS_START: usize = 2;
const SIGNATURE_OFFSETS_LENGTH: usize = 14;
const SIGNATURE_LENGTH: usize = 64;
const PUBLIC_KEY_LENGTH: usize = 32;
const MESSAGE_LENGTH: usize = 32;
const CURRENT_INSTRUCTION: u16 = u16::MAX;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Ed25519SignatureError {
    InvalidInstruction,
    Mismatch,
}

pub(crate) fn verify_ed25519_signature(
    instructions_sysvar: &AccountInfo,
    solver: &Pubkey,
    digest: &[u8; MESSAGE_LENGTH],
) -> std::result::Result<(), Ed25519SignatureError> {
    let current_index = load_current_index_checked(instructions_sysvar)
        .map_err(|_| Ed25519SignatureError::InvalidInstruction)?;
    let verifier_index = current_index
        .checked_sub(1)
        .ok_or(Ed25519SignatureError::InvalidInstruction)?;
    let verifier = load_instruction_at_checked(verifier_index as usize, instructions_sysvar)
        .map_err(|_| Ed25519SignatureError::InvalidInstruction)?;

    verify_ed25519_instruction(&verifier, solver, digest, |index| {
        load_instruction_at_checked(index, instructions_sysvar)
            .ok()
            .map(|instruction| instruction.data)
    })
}

fn verify_ed25519_instruction(
    verifier: &anchor_lang::solana_program::instruction::Instruction,
    solver: &Pubkey,
    digest: &[u8; MESSAGE_LENGTH],
    mut load_data: impl FnMut(usize) -> Option<Vec<u8>>,
) -> std::result::Result<(), Ed25519SignatureError> {
    if verifier.program_id != ed25519_program::id()
        || !verifier.accounts.is_empty()
        || verifier.data.len() < SIGNATURE_OFFSETS_START + SIGNATURE_OFFSETS_LENGTH
        || verifier.data[0] != 1
        || verifier.data[1] != 0
    {
        return Err(Ed25519SignatureError::InvalidInstruction);
    }

    let field =
        |offset: usize| u16::from_le_bytes([verifier.data[offset], verifier.data[offset + 1]]);
    let signature_offset = field(2);
    let signature_instruction = field(4);
    let public_key_offset = field(6);
    let public_key_instruction = field(8);
    let message_offset = field(10);
    let message_size = field(12);
    let message_instruction = field(14);
    if message_size as usize != MESSAGE_LENGTH {
        return Err(Ed25519SignatureError::InvalidInstruction);
    }

    resolve_bytes(
        &verifier.data,
        signature_instruction,
        signature_offset,
        SIGNATURE_LENGTH,
        &mut load_data,
    )?;
    let public_key = resolve_bytes(
        &verifier.data,
        public_key_instruction,
        public_key_offset,
        PUBLIC_KEY_LENGTH,
        &mut load_data,
    )?;
    let message = resolve_bytes(
        &verifier.data,
        message_instruction,
        message_offset,
        MESSAGE_LENGTH,
        &mut load_data,
    )?;

    if public_key.as_slice() != solver.as_ref() || message.as_slice() != digest {
        return Err(Ed25519SignatureError::Mismatch);
    }
    Ok(())
}

fn resolve_bytes(
    verifier_data: &[u8],
    instruction_index: u16,
    offset: u16,
    length: usize,
    load_data: &mut impl FnMut(usize) -> Option<Vec<u8>>,
) -> std::result::Result<Vec<u8>, Ed25519SignatureError> {
    let data = if instruction_index == CURRENT_INSTRUCTION {
        verifier_data.to_vec()
    } else {
        load_data(instruction_index as usize).ok_or(Ed25519SignatureError::InvalidInstruction)?
    };
    let start = offset as usize;
    let end = start
        .checked_add(length)
        .ok_or(Ed25519SignatureError::InvalidInstruction)?;
    data.get(start..end)
        .map(<[u8]>::to_vec)
        .ok_or(Ed25519SignatureError::InvalidInstruction)
}

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::solana_program::instruction::Instruction;

    fn verifier(data: Vec<u8>) -> Instruction {
        Instruction {
            program_id: ed25519_program::id(),
            accounts: Vec::new(),
            data,
        }
    }

    fn descriptor(
        signature: (u16, u16),
        public_key: (u16, u16),
        message: (u16, u16),
        message_size: u16,
    ) -> Vec<u8> {
        let mut data = vec![1, 0];
        for value in [
            signature.0,
            signature.1,
            public_key.0,
            public_key.1,
            message.0,
            message_size,
            message.1,
        ] {
            data.extend_from_slice(&value.to_le_bytes());
        }
        data
    }

    #[test]
    fn resolves_each_ed25519_field_from_its_declared_instruction() {
        let solver = Pubkey::new_unique();
        let digest = [7; MESSAGE_LENGTH];
        let signature_data = vec![9; SIGNATURE_LENGTH];
        let public_key_data = solver.to_bytes().to_vec();
        let message_data = digest.to_vec();
        let instruction = verifier(descriptor((0, 0), (0, 1), (0, 2), MESSAGE_LENGTH as u16));
        let sources = [signature_data, public_key_data, message_data];

        assert_eq!(
            verify_ed25519_instruction(&instruction, &solver, &digest, |index| {
                sources.get(index).cloned()
            }),
            Ok(())
        );
    }

    #[test]
    fn rejects_multiple_signatures_and_out_of_bounds_references() {
        let solver = Pubkey::new_unique();
        let digest = [7; MESSAGE_LENGTH];
        let mut multiple = descriptor(
            (16, CURRENT_INSTRUCTION),
            (80, CURRENT_INSTRUCTION),
            (112, CURRENT_INSTRUCTION),
            MESSAGE_LENGTH as u16,
        );
        multiple[0] = 2;
        multiple.resize(144, 0);
        assert_eq!(
            verify_ed25519_instruction(&verifier(multiple), &solver, &digest, |_| None),
            Err(Ed25519SignatureError::InvalidInstruction)
        );

        let out_of_bounds = verifier(descriptor((1, 0), (0, 1), (0, 2), MESSAGE_LENGTH as u16));
        assert_eq!(
            verify_ed25519_instruction(&out_of_bounds, &solver, &digest, |index| {
                [
                    vec![0; SIGNATURE_LENGTH],
                    solver.to_bytes().to_vec(),
                    digest.to_vec(),
                ]
                .get(index)
                .cloned()
            }),
            Err(Ed25519SignatureError::InvalidInstruction)
        );
    }

    #[test]
    fn distinguishes_exact_key_and_message_mismatches() {
        let solver = Pubkey::new_unique();
        let digest = [7; MESSAGE_LENGTH];
        let mut data = descriptor(
            (16, CURRENT_INSTRUCTION),
            (80, CURRENT_INSTRUCTION),
            (112, CURRENT_INSTRUCTION),
            MESSAGE_LENGTH as u16,
        );
        data.extend_from_slice(&[9; SIGNATURE_LENGTH]);
        data.extend_from_slice(Pubkey::new_unique().as_ref());
        data.extend_from_slice(&digest);

        assert_eq!(
            verify_ed25519_instruction(&verifier(data), &solver, &digest, |_| None),
            Err(Ed25519SignatureError::Mismatch)
        );

        let signature = [9; SIGNATURE_LENGTH];
        let key = solver.to_bytes();
        let wrong_message = [8; MESSAGE_LENGTH];
        let sources = [
            signature.as_slice(),
            key.as_slice(),
            wrong_message.as_slice(),
        ];
        let referenced = verifier(descriptor((0, 0), (0, 1), (0, 2), MESSAGE_LENGTH as u16));
        assert_eq!(
            verify_ed25519_instruction(&referenced, &solver, &digest, |index| {
                sources.get(index).map(|source| source.to_vec())
            }),
            Err(Ed25519SignatureError::Mismatch)
        );
    }
}

pub mod consume_reservation;
pub mod finalize_reservation;
pub mod fund_reservation;
pub mod initialize_class;
pub mod release_reservation;

pub use consume_reservation::*;
pub use finalize_reservation::*;
pub use fund_reservation::*;
pub use initialize_class::*;
pub use release_reservation::*;

use anchor_lang::{prelude::*, solana_program::bpf_loader_upgradeable::get_program_data_address};
use naryx_core::DomainRef;
use solana_sha256_hasher::hashv;

use crate::{constants::DOMAIN_REF_IDENTITY_DOMAIN, error::ErrorCode, state::ReservationClass};

pub fn domain_ref_identity(domain: &DomainRef) -> [u8; 32] {
    let canonical = domain.canonical_bytes();
    hashv(&[DOMAIN_REF_IDENTITY_DOMAIN, canonical.as_ref()]).to_bytes()
}

pub(crate) fn live_code_identity(
    program: &AccountInfo,
    program_data: &AccountInfo,
) -> Result<[u8; 32]> {
    require!(program.executable, ErrorCode::ProgramUnsupported);
    require_keys_eq!(
        *program.owner,
        bpf_loader_upgradeable::id(),
        ErrorCode::ProgramUnsupported
    );
    require_keys_eq!(
        program_data.key(),
        get_program_data_address(program.key),
        ErrorCode::CodeIdentityMismatch
    );
    require_keys_eq!(
        *program_data.owner,
        bpf_loader_upgradeable::id(),
        ErrorCode::CodeIdentityMismatch
    );
    let data = program_data.try_borrow_data()?;
    require!(!data.is_empty(), ErrorCode::CodeIdentityMismatch);
    Ok(hashv(&[data.as_ref()]).to_bytes())
}

pub(crate) fn verify_core_identity(
    class: &ReservationClass,
    core_program: &AccountInfo,
    core_program_data: &AccountInfo,
) -> Result<()> {
    require_keys_eq!(
        core_program.key(),
        class.core_program,
        ErrorCode::AccountBindingMismatch
    );
    require_keys_eq!(
        core_program_data.key(),
        class.core_program_data,
        ErrorCode::CodeIdentityMismatch
    );
    require!(
        live_code_identity(core_program, core_program_data)? == class.core_code_identity,
        ErrorCode::CodeIdentityMismatch
    );
    Ok(())
}

pub(crate) fn verify_consumer_identity(
    class: &ReservationClass,
    consumer_program: &AccountInfo,
    consumer_program_data: &AccountInfo,
) -> Result<()> {
    require_keys_eq!(
        consumer_program.key(),
        class.consumer_program,
        ErrorCode::AccountBindingMismatch
    );
    require_keys_eq!(
        consumer_program_data.key(),
        class.consumer_program_data,
        ErrorCode::CodeIdentityMismatch
    );
    require!(
        live_code_identity(consumer_program, consumer_program_data)?
            == class.consumer_code_identity,
        ErrorCode::CodeIdentityMismatch
    );
    Ok(())
}

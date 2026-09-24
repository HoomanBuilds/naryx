#![allow(ambiguous_glob_reexports, unused_imports)]

pub mod batch_upsert_levels;
pub mod cancel_all;
pub mod cancel_level;
pub mod consume_capacity;
pub mod initialize_class;
pub mod initialize_shard;
pub mod mutate_shard;
pub mod set_kill_switch;
pub mod update_reference;

pub use batch_upsert_levels::*;
pub use cancel_all::*;
pub use cancel_level::*;
pub use consume_capacity::*;
pub use initialize_class::*;
pub use initialize_shard::*;
pub use mutate_shard::*;
pub use set_kill_switch::*;
pub use update_reference::*;

use anchor_lang::{prelude::*, solana_program::bpf_loader_upgradeable::get_program_data_address};
use solana_sha256_hasher::hashv;

use crate::{error::ErrorCode, state::PackageQuoteShard};

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

pub(crate) fn verify_program_identities(
    shard: &PackageQuoteShard,
    core_program: &AccountInfo,
    core_program_data: &AccountInfo,
    consumer_program: &AccountInfo,
    consumer_program_data: &AccountInfo,
) -> Result<()> {
    require_keys_eq!(
        core_program.key(),
        shard.core_program,
        ErrorCode::AccountBindingMismatch
    );
    require_keys_eq!(
        core_program_data.key(),
        shard.core_program_data,
        ErrorCode::CodeIdentityMismatch
    );
    require!(
        live_code_identity(core_program, core_program_data)? == shard.core_code_identity,
        ErrorCode::CodeIdentityMismatch
    );
    require_keys_eq!(
        consumer_program.key(),
        shard.consumer_program,
        ErrorCode::AccountBindingMismatch
    );
    require_keys_eq!(
        consumer_program_data.key(),
        shard.consumer_program_data,
        ErrorCode::CodeIdentityMismatch
    );
    require!(
        live_code_identity(consumer_program, consumer_program_data)?
            == shard.consumer_code_identity,
        ErrorCode::CodeIdentityMismatch
    );
    Ok(())
}

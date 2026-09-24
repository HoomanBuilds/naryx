use anchor_lang::prelude::*;

use crate::{
    constants::PACKAGE_BOOK_VERSION, error::ErrorCode, events::PackageQuoteLevelCancelled,
    instructions::MutateShardLevels,
};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct CancelLevelArgs {
    pub expected_shard_sequence: u64,
    pub slot_index: u8,
    pub level_id: u64,
    pub expected_level_sequence: u64,
}

pub fn handler(ctx: Context<MutateShardLevels>, args: CancelLevelArgs) -> Result<()> {
    let shard = &mut ctx.accounts.shard;
    let next_sequence = shard.next_shard_sequence(args.expected_shard_sequence)?;
    let mut level_page = ctx.accounts.level_page.load_mut()?;
    require!(
        level_page.version == PACKAGE_BOOK_VERSION && level_page.shard == shard.key(),
        ErrorCode::AccountBindingMismatch
    );
    shard.cancel_level(
        &mut level_page.levels,
        args.slot_index,
        args.level_id,
        args.expected_level_sequence,
    )?;
    shard.shard_sequence = next_sequence;
    emit!(PackageQuoteLevelCancelled {
        shard: shard.key(),
        level_id: args.level_id,
        shard_sequence: shard.shard_sequence,
    });
    Ok(())
}

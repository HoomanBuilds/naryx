use anchor_lang::prelude::*;

use crate::{
    constants::{MAX_BATCH_LEVEL_UPDATES, MAX_QUOTE_LEVELS},
    error::ErrorCode,
    events::PackageQuoteLevelsUpdated,
    instructions::MutateShardLevels,
    state::QuoteLevelUpdate,
};

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct BatchUpsertLevelsArgs {
    pub expected_shard_sequence: u64,
    pub replace: bool,
    pub updates: Vec<QuoteLevelUpdate>,
}

pub fn handler(ctx: Context<MutateShardLevels>, args: BatchUpsertLevelsArgs) -> Result<()> {
    require!(
        !args.updates.is_empty() && args.updates.len() <= MAX_BATCH_LEVEL_UPDATES,
        ErrorCode::BatchSizeInvalid
    );
    let shard = &mut ctx.accounts.shard;
    require!(!shard.killed, ErrorCode::ShardKilled);
    shard.validate_fresh(Clock::get()?.slot)?;
    let next_sequence = shard.next_shard_sequence(args.expected_shard_sequence)?;
    let mut seen = [false; MAX_QUOTE_LEVELS];
    for update in &args.updates {
        let index = usize::from(update.slot_index);
        require!(index < MAX_QUOTE_LEVELS, ErrorCode::LevelSlotInvalid);
        require!(!seen[index], ErrorCode::DuplicateLevelSlot);
        seen[index] = true;
    }
    if args.replace {
        shard.cancel_all()?;
    }
    let current_slot = Clock::get()?.slot;
    let mut level_page = ctx.accounts.level_page.load_mut()?;
    require!(
        level_page.version == crate::constants::PACKAGE_BOOK_VERSION
            && level_page.shard == shard.key(),
        ErrorCode::AccountBindingMismatch
    );
    for update in args.updates {
        shard.upsert_level(
            &mut level_page.levels,
            &ctx.accounts.package_book_class,
            update,
            current_slot,
        )?;
    }
    shard.shard_sequence = next_sequence;
    emit!(PackageQuoteLevelsUpdated {
        shard: shard.key(),
        epoch: shard.epoch,
        shard_sequence: shard.shard_sequence,
        level_count: shard.level_count,
        replaced: args.replace,
    });
    Ok(())
}

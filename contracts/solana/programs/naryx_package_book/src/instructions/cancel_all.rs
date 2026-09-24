use anchor_lang::prelude::*;

use crate::{events::PackageQuoteEpochCancelled, instructions::MutateShard};

pub fn handler(ctx: Context<MutateShard>, expected_shard_sequence: u64) -> Result<()> {
    let shard = &mut ctx.accounts.shard;
    let next_sequence = shard.next_shard_sequence(expected_shard_sequence)?;
    shard.cancel_all()?;
    shard.shard_sequence = next_sequence;
    emit!(PackageQuoteEpochCancelled {
        shard: shard.key(),
        epoch: shard.epoch,
        shard_sequence: shard.shard_sequence,
    });
    Ok(())
}

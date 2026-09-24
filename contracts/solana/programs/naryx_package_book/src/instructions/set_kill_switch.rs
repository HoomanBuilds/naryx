use anchor_lang::prelude::*;

use crate::{events::PackageQuoteKillSwitchSet, instructions::MutateShard};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct SetKillSwitchArgs {
    pub expected_reference_sequence: u64,
    pub expected_shard_sequence: u64,
    pub reference_package_price: i128,
    pub reference_state_hash: [u8; 32],
    pub heartbeat_expiry_slot: u64,
    pub killed: bool,
}

pub fn handler(ctx: Context<MutateShard>, args: SetKillSwitchArgs) -> Result<()> {
    let shard = &mut ctx.accounts.shard;
    shard.update_reference(
        &ctx.accounts.package_book_class,
        args.expected_reference_sequence,
        args.expected_shard_sequence,
        args.reference_package_price,
        args.reference_state_hash,
        args.heartbeat_expiry_slot,
        Clock::get()?.slot,
    )?;
    shard.killed = args.killed;
    emit!(PackageQuoteKillSwitchSet {
        shard: shard.key(),
        killed: shard.killed,
        reference_sequence: shard.reference_sequence,
        shard_sequence: shard.shard_sequence,
    });
    Ok(())
}

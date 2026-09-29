pub mod constants;
pub mod error;
pub mod events;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("EvE2mjwHrtfQgNu8Whh6QGZBmkzxRjKadsHi4Uqk96dc");

#[program]
pub mod naryx_package_book {
    use super::*;

    pub fn initialize_class(
        ctx: Context<InitializeClass>,
        args: InitializeClassArgs,
    ) -> Result<()> {
        initialize_class::handler(ctx, args)
    }

    pub fn initialize_shard(
        ctx: Context<InitializeShard>,
        args: InitializeShardArgs,
    ) -> Result<()> {
        initialize_shard::handler(ctx, args)
    }

    pub fn update_reference(ctx: Context<MutateShard>, args: UpdateReferenceArgs) -> Result<()> {
        update_reference::handler(ctx, args)
    }

    pub fn batch_upsert_levels(
        ctx: Context<MutateShardLevels>,
        args: BatchUpsertLevelsArgs,
    ) -> Result<()> {
        batch_upsert_levels::handler(ctx, args)
    }

    pub fn cancel_level(ctx: Context<MutateShardLevels>, args: CancelLevelArgs) -> Result<()> {
        cancel_level::handler(ctx, args)
    }

    pub fn cancel_all(ctx: Context<MutateShard>, expected_shard_sequence: u64) -> Result<()> {
        cancel_all::handler(ctx, expected_shard_sequence)
    }

    pub fn set_kill_switch(ctx: Context<MutateShard>, args: SetKillSwitchArgs) -> Result<()> {
        set_kill_switch::handler(ctx, args)
    }

    pub fn consume_capacity(
        ctx: Context<ConsumeCapacity>,
        args: ConsumeCapacityArgs,
    ) -> Result<()> {
        consume_capacity::handler(ctx, args)
    }
}

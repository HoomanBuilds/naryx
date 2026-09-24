use anchor_lang::prelude::*;

use crate::{
    constants::{PACKAGE_BOOK_CLASS_SEED, PACKAGE_QUOTE_SHARD_SEED, QUOTE_LEVEL_PAGE_SEED},
    state::{PackageBookClass, PackageQuoteShard, QuoteLevelPage},
};

#[derive(Accounts)]
pub struct MutateShard<'info> {
    pub solver: Signer<'info>,
    #[account(
        seeds = [
            PACKAGE_BOOK_CLASS_SEED,
            package_book_class.domain_identity_hash.as_ref(),
            package_book_class.domain_manifest_version.to_le_bytes().as_ref(),
            package_book_class.domain_manifest_hash.as_ref()
        ],
        bump = package_book_class.bump
    )]
    pub package_book_class: Box<Account<'info, PackageBookClass>>,
    #[account(
        mut,
        seeds = [
            PACKAGE_QUOTE_SHARD_SEED,
            package_book_class.key().as_ref(),
            solver.key().as_ref(),
            shard.series_manifest_hash.as_ref(),
            shard.execution_class_manifest_hash.as_ref()
        ],
        bump = shard.bump,
        has_one = solver,
        has_one = package_book_class
    )]
    pub shard: Box<Account<'info, PackageQuoteShard>>,
}

#[derive(Accounts)]
pub struct MutateShardLevels<'info> {
    pub solver: Signer<'info>,
    #[account(
        seeds = [
            PACKAGE_BOOK_CLASS_SEED,
            package_book_class.domain_identity_hash.as_ref(),
            package_book_class.domain_manifest_version.to_le_bytes().as_ref(),
            package_book_class.domain_manifest_hash.as_ref()
        ],
        bump = package_book_class.bump
    )]
    pub package_book_class: Box<Account<'info, PackageBookClass>>,
    #[account(
        mut,
        seeds = [
            PACKAGE_QUOTE_SHARD_SEED,
            package_book_class.key().as_ref(),
            solver.key().as_ref(),
            shard.series_manifest_hash.as_ref(),
            shard.execution_class_manifest_hash.as_ref()
        ],
        bump = shard.bump,
        has_one = solver,
        has_one = package_book_class
    )]
    pub shard: Box<Account<'info, PackageQuoteShard>>,
    #[account(
        mut,
        seeds = [QUOTE_LEVEL_PAGE_SEED, shard.key().as_ref()],
        bump = shard.level_page_bump
    )]
    pub level_page: AccountLoader<'info, QuoteLevelPage>,
}

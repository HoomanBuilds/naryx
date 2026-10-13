use anchor_lang::prelude::*;
use solana_sha256_hasher::hashv;

use crate::{
    constants::{MAX_STAGE_BYTES, MAX_STAGE_CHUNK_BYTES, MULTI_STRATEGY_ACCOUNT_SEED, STRATEGY_STAGE_SEED},
    error::ErrorCode,
    state::{MultiStrategyAccount, StrategyExecutionStage},
};

#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct InitializeExecutionStage<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        seeds = [MULTI_STRATEGY_ACCOUNT_SEED, owner.key().as_ref()],
        bump = strategy_account.bump,
        has_one = owner @ ErrorCode::InvalidOwner
    )]
    pub strategy_account: Account<'info, MultiStrategyAccount>,
    #[account(
        init,
        payer = owner,
        space = 8 + StrategyExecutionStage::INIT_SPACE,
        seeds = [STRATEGY_STAGE_SEED, strategy_account.key().as_ref(), nonce.to_be_bytes().as_ref()],
        bump
    )]
    pub stage: Account<'info, StrategyExecutionStage>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct WriteExecutionStage<'info> {
    pub owner: Signer<'info>,
    #[account(
        seeds = [MULTI_STRATEGY_ACCOUNT_SEED, owner.key().as_ref()],
        bump = strategy_account.bump,
        has_one = owner @ ErrorCode::InvalidOwner
    )]
    pub strategy_account: Account<'info, MultiStrategyAccount>,
    #[account(
        mut,
        seeds = [STRATEGY_STAGE_SEED, strategy_account.key().as_ref(), stage.nonce.to_be_bytes().as_ref()],
        bump = stage.bump,
        has_one = owner @ ErrorCode::InvalidOwner
    )]
    pub stage: Account<'info, StrategyExecutionStage>,
}

#[derive(Accounts)]
pub struct CancelExecutionStage<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        seeds = [MULTI_STRATEGY_ACCOUNT_SEED, owner.key().as_ref()],
        bump = strategy_account.bump,
        has_one = owner @ ErrorCode::InvalidOwner
    )]
    pub strategy_account: Account<'info, MultiStrategyAccount>,
    #[account(
        mut,
        close = owner,
        seeds = [STRATEGY_STAGE_SEED, strategy_account.key().as_ref(), stage.nonce.to_be_bytes().as_ref()],
        bump = stage.bump,
        has_one = owner @ ErrorCode::InvalidOwner
    )]
    pub stage: Account<'info, StrategyExecutionStage>,
}

pub fn initialize_stage_handler(
    ctx: Context<InitializeExecutionStage>,
    nonce: u64,
    solver: Pubkey,
    expected_hash: [u8; 32],
    payload_len: u16,
    deadline_slot: u64,
) -> Result<()> {
    require!(
        ctx.accounts.strategy_account.next_nonce == nonce
            && solver != Pubkey::default()
            && solver != ctx.accounts.owner.key()
            && expected_hash != [0u8; 32]
            && payload_len != 0
            && usize::from(payload_len) <= MAX_STAGE_BYTES
            && Clock::get()?.slot < deadline_slot,
        ErrorCode::InvalidStage
    );
    let stage = &mut ctx.accounts.stage;
    stage.owner = ctx.accounts.owner.key();
    stage.solver = solver;
    stage.nonce = nonce;
    stage.deadline_slot = deadline_slot;
    stage.expected_hash = expected_hash;
    stage.payload_len = payload_len;
    stage.sealed = false;
    stage.bump = ctx.bumps.stage;
    stage.payload.clear();
    Ok(())
}

pub fn write_stage_handler(ctx: Context<WriteExecutionStage>, offset: u16, bytes: Vec<u8>) -> Result<()> {
    let stage = &mut ctx.accounts.stage;
    require!(
        !stage.sealed
            && Clock::get()?.slot < stage.deadline_slot
            && usize::from(offset) == stage.payload.len()
            && !bytes.is_empty()
            && bytes.len() <= MAX_STAGE_CHUNK_BYTES
            && stage.payload.len() + bytes.len() <= usize::from(stage.payload_len),
        ErrorCode::InvalidStage
    );
    stage.payload.extend_from_slice(&bytes);
    Ok(())
}

pub fn seal_stage_handler(ctx: Context<WriteExecutionStage>) -> Result<()> {
    let stage = &mut ctx.accounts.stage;
    require!(
        !stage.sealed
            && Clock::get()?.slot < stage.deadline_slot
            && stage.payload.len() == usize::from(stage.payload_len)
            && hashv(&[&stage.payload]).to_bytes() == stage.expected_hash,
        ErrorCode::InvalidStage
    );
    stage.sealed = true;
    Ok(())
}

pub fn cancel_stage_handler(_ctx: Context<CancelExecutionStage>) -> Result<()> {
    Ok(())
}

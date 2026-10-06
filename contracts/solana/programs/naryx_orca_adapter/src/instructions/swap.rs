use anchor_lang::{
    prelude::*,
    solana_program::{
        instruction::{AccountMeta, Instruction},
        program::{invoke, set_return_data},
    },
};
use anchor_spl::token::{Token, TokenAccount};

use crate::{
    constants::{ORCA_SWAP_DISCRIMINATOR, ORCA_WHIRLPOOL_PROGRAM_ID},
    error::ErrorCode,
};
use solana_sha256_hasher::hashv;

const EXACT_OUTPUT_DISCRIMINATOR: [u8; 8] = [0x2d, 0x63, 0x4c, 0xf2, 0xdf, 0x70, 0xa8, 0xa2];
const EXACT_INPUT_DISCRIMINATOR: [u8; 8] = [0xc2, 0xcb, 0x8e, 0x96, 0x89, 0x6e, 0x51, 0x5e];
const TYPED_EVIDENCE_DOMAIN: &[u8] = b"naryx.orca.typed-leg-evidence.v1";

#[derive(Accounts)]
pub struct SwapOrca<'info> {
    pub token_authority: Signer<'info>,
    #[account(
        mut,
        constraint = token_owner_account_a.owner == token_authority.key(),
        constraint = token_owner_account_a.mint != token_owner_account_b.mint @ ErrorCode::TokenMintsEqual
    )]
    pub token_owner_account_a: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = token_owner_account_b.owner == token_authority.key()
    )]
    pub token_owner_account_b: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = token_vault_a.mint == token_owner_account_a.mint
    )]
    pub token_vault_a: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = token_vault_b.mint == token_owner_account_b.mint
    )]
    pub token_vault_b: Account<'info, TokenAccount>,
    /// CHECK: The owner constraint and the invoked program validate the Whirlpool layout.
    #[account(mut, owner = ORCA_WHIRLPOOL_PROGRAM_ID)]
    pub whirlpool: UncheckedAccount<'info>,
    /// CHECK: The invoked program validates the tick array layout and sequence.
    #[account(mut, owner = ORCA_WHIRLPOOL_PROGRAM_ID)]
    pub tick_array_0: UncheckedAccount<'info>,
    /// CHECK: The invoked program validates the tick array layout and sequence.
    #[account(mut, owner = ORCA_WHIRLPOOL_PROGRAM_ID)]
    pub tick_array_1: UncheckedAccount<'info>,
    /// CHECK: The invoked program validates the tick array layout and sequence.
    #[account(mut, owner = ORCA_WHIRLPOOL_PROGRAM_ID)]
    pub tick_array_2: UncheckedAccount<'info>,
    /// CHECK: The address is the canonical oracle PDA for this Whirlpool.
    #[account(
        mut,
        seeds = [b"oracle", whirlpool.key().as_ref()],
        seeds::program = ORCA_WHIRLPOOL_PROGRAM_ID,
        bump
    )]
    pub oracle: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    /// CHECK: The address and executable constraints pin the only CPI target.
    #[account(address = ORCA_WHIRLPOOL_PROGRAM_ID, executable)]
    pub whirlpool_program: UncheckedAccount<'info>,
}

#[event]
pub struct OrcaSwapExecuted {
    pub whirlpool: Pubkey,
    pub token_authority: Pubkey,
    pub exact_input: bool,
    pub a_to_b: bool,
    pub input_atoms: u64,
    pub output_atoms: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize)]
struct OrcaSwapArgs {
    amount: u64,
    other_amount_threshold: u64,
    sqrt_price_limit: u128,
    amount_specified_is_input: bool,
    a_to_b: bool,
}

pub fn exact_output(
    ctx: Context<SwapOrca>,
    amount_out: u64,
    maximum_amount_in: u64,
    sqrt_price_limit: u128,
    a_to_b: bool,
) -> Result<()> {
    execute(
        ctx,
        OrcaSwapArgs {
            amount: amount_out,
            other_amount_threshold: maximum_amount_in,
            sqrt_price_limit,
            amount_specified_is_input: false,
            a_to_b,
        },
    )
    .map(|_| ())
}

pub fn exact_input(
    ctx: Context<SwapOrca>,
    amount_in: u64,
    minimum_amount_out: u64,
    sqrt_price_limit: u128,
    a_to_b: bool,
) -> Result<()> {
    execute(
        ctx,
        OrcaSwapArgs {
            amount: amount_in,
            other_amount_threshold: minimum_amount_out,
            sqrt_price_limit,
            amount_specified_is_input: true,
            a_to_b,
        },
    )
    .map(|_| ())
}

pub fn execute_typed(ctx: Context<SwapOrca>, payload: Vec<u8>) -> Result<()> {
    require!(payload.len() >= 8, ErrorCode::TypedPayloadInvalid);
    let (discriminator, encoded) = payload.split_at(8);
    require!(
        discriminator == EXACT_OUTPUT_DISCRIMINATOR || discriminator == EXACT_INPUT_DISCRIMINATOR,
        ErrorCode::TypedPayloadInvalid
    );
    let mut encoded = encoded;
    let args = OrcaSwapArgs::deserialize(&mut encoded)
        .map_err(|_| error!(ErrorCode::TypedPayloadInvalid))?;
    require!(
        encoded.is_empty()
            && args.amount_specified_is_input == (discriminator == EXACT_INPUT_DISCRIMINATOR),
        ErrorCode::TypedPayloadInvalid
    );
    let authority = ctx.accounts.token_authority.key();
    let whirlpool = ctx.accounts.whirlpool.key();
    let (input_atoms, output_atoms) = execute(ctx, args)?;
    let evidence = hashv(&[
        TYPED_EVIDENCE_DOMAIN,
        authority.as_ref(),
        whirlpool.as_ref(),
        discriminator,
        &input_atoms.to_le_bytes(),
        &output_atoms.to_le_bytes(),
    ])
    .to_bytes();
    set_return_data(&evidence);
    Ok(())
}

fn execute(ctx: Context<SwapOrca>, args: OrcaSwapArgs) -> Result<(u64, u64)> {
    require!(args.amount != 0, ErrorCode::AmountZero);
    require!(args.other_amount_threshold != 0, ErrorCode::ThresholdZero);

    let pre_a = ctx.accounts.token_owner_account_a.amount;
    let pre_b = ctx.accounts.token_owner_account_b.amount;
    let instruction = build_swap_instruction(&ctx.accounts, &args)?;
    invoke(
        &instruction,
        &[
            ctx.accounts.whirlpool_program.to_account_info(),
            ctx.accounts.token_program.to_account_info(),
            ctx.accounts.token_authority.to_account_info(),
            ctx.accounts.whirlpool.to_account_info(),
            ctx.accounts.token_owner_account_a.to_account_info(),
            ctx.accounts.token_vault_a.to_account_info(),
            ctx.accounts.token_owner_account_b.to_account_info(),
            ctx.accounts.token_vault_b.to_account_info(),
            ctx.accounts.tick_array_0.to_account_info(),
            ctx.accounts.tick_array_1.to_account_info(),
            ctx.accounts.tick_array_2.to_account_info(),
            ctx.accounts.oracle.to_account_info(),
        ],
    )?;

    ctx.accounts.token_owner_account_a.reload()?;
    ctx.accounts.token_owner_account_b.reload()?;
    let (pre_input, post_input, pre_output, post_output) = if args.a_to_b {
        (
            pre_a,
            ctx.accounts.token_owner_account_a.amount,
            pre_b,
            ctx.accounts.token_owner_account_b.amount,
        )
    } else {
        (
            pre_b,
            ctx.accounts.token_owner_account_b.amount,
            pre_a,
            ctx.accounts.token_owner_account_a.amount,
        )
    };
    let input_atoms = pre_input
        .checked_sub(post_input)
        .ok_or_else(|| error!(ErrorCode::BalanceDirectionInvalid))?;
    let output_atoms = post_output
        .checked_sub(pre_output)
        .ok_or_else(|| error!(ErrorCode::BalanceDirectionInvalid))?;
    enforce_postconditions(&args, input_atoms, output_atoms)?;

    emit!(OrcaSwapExecuted {
        whirlpool: ctx.accounts.whirlpool.key(),
        token_authority: ctx.accounts.token_authority.key(),
        exact_input: args.amount_specified_is_input,
        a_to_b: args.a_to_b,
        input_atoms,
        output_atoms,
    });
    Ok((input_atoms, output_atoms))
}

fn build_swap_instruction(accounts: &SwapOrca<'_>, args: &OrcaSwapArgs) -> Result<Instruction> {
    let data = swap_instruction_data(args)?;
    Ok(Instruction {
        program_id: ORCA_WHIRLPOOL_PROGRAM_ID,
        accounts: swap_account_metas([
            accounts.token_program.key(),
            accounts.token_authority.key(),
            accounts.whirlpool.key(),
            accounts.token_owner_account_a.key(),
            accounts.token_vault_a.key(),
            accounts.token_owner_account_b.key(),
            accounts.token_vault_b.key(),
            accounts.tick_array_0.key(),
            accounts.tick_array_1.key(),
            accounts.tick_array_2.key(),
            accounts.oracle.key(),
        ]),
        data,
    })
}

fn swap_account_metas(keys: [Pubkey; 11]) -> Vec<AccountMeta> {
    vec![
        AccountMeta::new_readonly(keys[0], false),
        AccountMeta::new_readonly(keys[1], true),
        AccountMeta::new(keys[2], false),
        AccountMeta::new(keys[3], false),
        AccountMeta::new(keys[4], false),
        AccountMeta::new(keys[5], false),
        AccountMeta::new(keys[6], false),
        AccountMeta::new(keys[7], false),
        AccountMeta::new(keys[8], false),
        AccountMeta::new(keys[9], false),
        AccountMeta::new(keys[10], false),
    ]
}

fn swap_instruction_data(args: &OrcaSwapArgs) -> Result<Vec<u8>> {
    let mut data = Vec::with_capacity(42);
    data.extend_from_slice(&ORCA_SWAP_DISCRIMINATOR);
    args.serialize(&mut data)
        .map_err(|_| error!(ErrorCode::SerializationFailed))?;
    Ok(data)
}

fn enforce_postconditions(args: &OrcaSwapArgs, input_atoms: u64, output_atoms: u64) -> Result<()> {
    if args.amount_specified_is_input {
        require!(input_atoms == args.amount, ErrorCode::ExactInputMismatch);
        require!(
            output_atoms >= args.other_amount_threshold,
            ErrorCode::MinimumOutputNotMet
        );
    } else {
        require!(output_atoms == args.amount, ErrorCode::ExactOutputMismatch);
        require!(
            input_atoms <= args.other_amount_threshold,
            ErrorCode::MaximumInputExceeded
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use orca_whirlpools_client::{Swap, SwapInstructionArgs};

    #[test]
    fn encodes_exact_output_swap() {
        let args = OrcaSwapArgs {
            amount: 11,
            other_amount_threshold: 23,
            sqrt_price_limit: 37,
            amount_specified_is_input: false,
            a_to_b: true,
        };
        let swap = Swap {
            token_program: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
                .parse()
                .unwrap(),
            token_authority: "11111111111111111111111111111111".parse().unwrap(),
            whirlpool: "SysvarC1ock11111111111111111111111111111111"
                .parse()
                .unwrap(),
            token_owner_account_a: "SysvarRent111111111111111111111111111111111"
                .parse()
                .unwrap(),
            token_vault_a: "SysvarRecentB1ockHashes11111111111111111111"
                .parse()
                .unwrap(),
            token_owner_account_b: "Vote111111111111111111111111111111111111111"
                .parse()
                .unwrap(),
            token_vault_b: "Stake11111111111111111111111111111111111111"
                .parse()
                .unwrap(),
            tick_array0: "Config1111111111111111111111111111111111111"
                .parse()
                .unwrap(),
            tick_array1: "AddressLookupTab1e1111111111111111111111111"
                .parse()
                .unwrap(),
            tick_array2: "ComputeBudget111111111111111111111111111111"
                .parse()
                .unwrap(),
            oracle: "Ed25519SigVerify111111111111111111111111111"
                .parse()
                .unwrap(),
        };
        let official = swap.instruction(SwapInstructionArgs {
            amount: args.amount,
            other_amount_threshold: args.other_amount_threshold,
            sqrt_price_limit: args.sqrt_price_limit,
            amount_specified_is_input: args.amount_specified_is_input,
            a_to_b: args.a_to_b,
        });
        assert_eq!(swap_instruction_data(&args).unwrap(), official.data);
        let official_keys: Vec<_> = official
            .accounts
            .iter()
            .map(|meta| Pubkey::new_from_array(meta.pubkey.to_bytes()))
            .collect();
        let local = swap_account_metas(official_keys.clone().try_into().unwrap());
        assert_eq!(
            local.iter().map(|meta| meta.pubkey).collect::<Vec<_>>(),
            official_keys
        );
        let official_flags: Vec<_> = official
            .accounts
            .iter()
            .map(|meta| (meta.is_signer, meta.is_writable))
            .collect();
        assert_eq!(
            official_flags,
            vec![
                (false, false),
                (true, false),
                (false, true),
                (false, true),
                (false, true),
                (false, true),
                (false, true),
                (false, true),
                (false, true),
                (false, true),
                (false, false),
            ]
        );
        let flags: Vec<_> = local
            .iter()
            .map(|meta| (meta.is_signer, meta.is_writable))
            .collect();
        assert_eq!(
            flags,
            vec![
                (false, false),
                (true, false),
                (false, true),
                (false, true),
                (false, true),
                (false, true),
                (false, true),
                (false, true),
                (false, true),
                (false, true),
                (false, true),
            ]
        );
    }

    #[test]
    fn enforces_exact_output_limits() {
        let args = OrcaSwapArgs {
            amount: 11,
            other_amount_threshold: 23,
            sqrt_price_limit: 0,
            amount_specified_is_input: false,
            a_to_b: true,
        };
        assert!(enforce_postconditions(&args, 23, 11).is_ok());
        assert!(enforce_postconditions(&args, 24, 11).is_err());
        assert!(enforce_postconditions(&args, 23, 10).is_err());
    }

    #[test]
    fn enforces_exact_input_limits() {
        let args = OrcaSwapArgs {
            amount: 11,
            other_amount_threshold: 23,
            sqrt_price_limit: 0,
            amount_specified_is_input: true,
            a_to_b: false,
        };
        assert!(enforce_postconditions(&args, 11, 23).is_ok());
        assert!(enforce_postconditions(&args, 10, 23).is_err());
        assert!(enforce_postconditions(&args, 11, 22).is_err());
    }
}

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::{constants::MARKET_SEED, engine::Settlement, error::TestPerpError, TestPerpMarket};

pub fn market_transfer<'info>(
    market: &Account<'info, TestPerpMarket>,
    token_program: &Program<'info, Token>,
    from: &Account<'info, TokenAccount>,
    to: AccountInfo<'info>,
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let bump = [market.bump];
    let seeds: &[&[u8]] = &[
        MARKET_SEED,
        market.owner.as_ref(),
        market.feed_id.as_ref(),
        bump.as_ref(),
    ];
    token::transfer(
        CpiContext::new_with_signer(
            token_program.key(),
            Transfer {
                from: from.to_account_info(),
                to,
                authority: market.to_account_info(),
            },
            &[seeds],
        ),
        amount,
    )
}

pub fn apply_vault_settlement<'info>(
    market: &Account<'info, TestPerpMarket>,
    token_program: &Program<'info, Token>,
    collateral_vault: &Account<'info, TokenAccount>,
    fee_vault: &Account<'info, TokenAccount>,
    insurance_vault: &Account<'info, TokenAccount>,
    settlement: &Settlement,
) -> Result<()> {
    require!(
        insurance_vault.amount >= settlement.from_insurance,
        TestPerpError::InsufficientInsurance
    );
    market_transfer(
        market,
        token_program,
        insurance_vault,
        collateral_vault.to_account_info(),
        settlement.from_insurance,
    )?;
    market_transfer(
        market,
        token_program,
        collateral_vault,
        insurance_vault.to_account_info(),
        settlement.to_insurance,
    )?;
    market_transfer(
        market,
        token_program,
        collateral_vault,
        fee_vault.to_account_info(),
        settlement.to_fee_vault,
    )
}

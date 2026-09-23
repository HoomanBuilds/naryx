use anchor_lang::prelude::*;

use crate::{constants::BPS_DENOMINATOR, error::ErrorCode};

#[allow(clippy::too_many_arguments)]
pub fn validate_market_parameters(
    price_quote_atoms: u64,
    price_base_atoms: u64,
    spot_fee_bps: u16,
    initial_margin_bps: u16,
    max_spot_base_atoms: u64,
    max_perp_base_atoms: u64,
) -> Result<()> {
    require!(
        price_quote_atoms != 0 && price_base_atoms != 0,
        ErrorCode::InvalidPrice
    );
    require!(
        gcd(price_quote_atoms, price_base_atoms) == 1,
        ErrorCode::PriceNotReduced
    );
    require!(
        u64::from(spot_fee_bps) <= BPS_DENOMINATOR,
        ErrorCode::InvalidFeeBps
    );
    require!(
        initial_margin_bps != 0 && u64::from(initial_margin_bps) <= BPS_DENOMINATOR,
        ErrorCode::InvalidMarginBps
    );
    require!(
        max_spot_base_atoms != 0 && max_perp_base_atoms != 0,
        ErrorCode::InvalidCap
    );
    Ok(())
}

pub fn mul_div_floor(left: u64, right: u64, denominator: u64) -> Result<u64> {
    require!(denominator != 0, ErrorCode::InvalidPrice);
    let product = u128::from(left)
        .checked_mul(u128::from(right))
        .ok_or_else(|| error!(ErrorCode::ArithmeticOverflow))?;
    u64::try_from(product / u128::from(denominator))
        .map_err(|_| error!(ErrorCode::ArithmeticOverflow))
}

pub fn mul_div_ceil(left: u64, right: u64, denominator: u64) -> Result<u64> {
    require!(denominator != 0, ErrorCode::InvalidPrice);
    let product = u128::from(left)
        .checked_mul(u128::from(right))
        .ok_or_else(|| error!(ErrorCode::ArithmeticOverflow))?;
    let denominator = u128::from(denominator);
    let quotient = product / denominator;
    let rounded = if product % denominator == 0 {
        quotient
    } else {
        quotient
            .checked_add(1)
            .ok_or_else(|| error!(ErrorCode::ArithmeticOverflow))?
    };
    u64::try_from(rounded).map_err(|_| error!(ErrorCode::ArithmeticOverflow))
}

pub fn gcd(mut left: u64, mut right: u64) -> u64 {
    while right != 0 {
        let remainder = left % right;
        left = right;
        right = remainder;
    }
    left
}

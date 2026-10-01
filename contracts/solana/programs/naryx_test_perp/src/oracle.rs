use anchor_lang::prelude::*;

use crate::{
    constants::{
        BPS_DENOMINATOR, MAX_ORACLE_EXPONENT_MAGNITUDE, PRICE_UPDATE_V2_DISCRIMINATOR,
        PYTH_RECEIVER_PROGRAM_ID,
    },
    error::TestPerpError,
    TestPerpMarket,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PriceMessage {
    pub feed_id: [u8; 32],
    pub price: i64,
    pub conf: u64,
    pub exponent: i32,
    pub publish_time: i64,
}

/// Decodes a Pyth Solana Receiver `PriceUpdateV2` account and keeps only fully verified updates.
/// Layout: discriminator, write authority, verification level (Partial is tag 0 plus a u8,
/// Full is tag 1), then the price message, then the posted slot.
pub fn decode_price_update(data: &[u8]) -> Result<PriceMessage> {
    require!(
        data.get(..8) == Some(PRICE_UPDATE_V2_DISCRIMINATOR.as_slice()),
        TestPerpError::OracleDataInvalid
    );
    let mut offset = 8 + 32;
    match data.get(offset) {
        Some(1) => offset += 1,
        Some(0) => return err!(TestPerpError::OracleNotFullyVerified),
        _ => return err!(TestPerpError::OracleDataInvalid),
    }
    let message = data
        .get(offset..offset + 32 + 8 + 8 + 4 + 8 + 8 + 8 + 8 + 8)
        .ok_or_else(|| error!(TestPerpError::OracleDataInvalid))?;
    let mut feed_id = [0u8; 32];
    feed_id.copy_from_slice(&message[..32]);
    let read8 = |at: usize| -> [u8; 8] { message[at..at + 8].try_into().unwrap() };
    Ok(PriceMessage {
        feed_id,
        price: i64::from_le_bytes(read8(32)),
        conf: u64::from_le_bytes(read8(40)),
        exponent: i32::from_le_bytes(message[48..52].try_into().unwrap()),
        publish_time: i64::from_le_bytes(read8(52)),
    })
}

/// Returns the oracle price in collateral atoms per base lot, rounded down.
pub fn oracle_price_per_lot(
    market: &TestPerpMarket,
    oracle: &AccountInfo,
    now: i64,
) -> Result<u64> {
    require_keys_eq!(
        *oracle.owner,
        PYTH_RECEIVER_PROGRAM_ID,
        TestPerpError::OracleOwnerInvalid
    );
    require_keys_eq!(
        oracle.key(),
        market.oracle,
        TestPerpError::OracleAccountMismatch
    );
    let data = oracle.try_borrow_data()?;
    let message = decode_price_update(&data)?;
    validate_message(market, &message, now)?;
    price_per_lot(market, &message)
}

pub fn validate_message(market: &TestPerpMarket, message: &PriceMessage, now: i64) -> Result<()> {
    require!(
        message.feed_id == market.feed_id,
        TestPerpError::OracleFeedMismatch
    );
    require!(message.price > 0, TestPerpError::OraclePriceInvalid);
    require!(
        message
            .publish_time
            .saturating_add(i64::from(market.max_price_age_seconds))
            >= now,
        TestPerpError::OracleStale
    );
    let price = message.price as u128;
    require!(
        (message.conf as u128) * u128::from(BPS_DENOMINATOR)
            <= price * u128::from(market.max_confidence_bps),
        TestPerpError::OracleConfidenceTooWide
    );
    Ok(())
}

fn price_per_lot(market: &TestPerpMarket, message: &PriceMessage) -> Result<u64> {
    let scale = message
        .exponent
        .checked_add(i32::from(market.collateral_decimals))
        .and_then(|value| value.checked_sub(i32::from(market.base_decimals)))
        .filter(|value| value.abs() <= MAX_ORACLE_EXPONENT_MAGNITUDE * 2)
        .ok_or_else(|| error!(TestPerpError::OracleDataInvalid))?;
    let numerator = (message.price as u128)
        .checked_mul(u128::from(market.base_lot_atoms))
        .ok_or_else(|| error!(TestPerpError::ArithmeticOverflow))?;
    let factor = 10u128
        .checked_pow(scale.unsigned_abs())
        .ok_or_else(|| error!(TestPerpError::ArithmeticOverflow))?;
    let value = if scale >= 0 {
        numerator
            .checked_mul(factor)
            .ok_or_else(|| error!(TestPerpError::ArithmeticOverflow))?
    } else {
        numerator / factor
    };
    let value = u64::try_from(value).map_err(|_| error!(TestPerpError::ArithmeticOverflow))?;
    require!(value > 0, TestPerpError::OraclePriceInvalid);
    Ok(value)
}

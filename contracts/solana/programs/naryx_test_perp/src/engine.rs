use anchor_lang::prelude::*;

use crate::{
    constants::{BPS_DENOMINATOR, FUNDING_RATE_SCALE},
    error::TestPerpError,
    OrderSide, TestPerpMarket, TestPerpPosition,
};

fn overflow() -> Error {
    error!(TestPerpError::ArithmeticOverflow)
}

pub fn mul_div_floor(a: u128, b: u128, d: u128) -> Result<u128> {
    a.checked_mul(b)
        .and_then(|value| value.checked_div(d))
        .ok_or_else(overflow)
}

pub fn mul_div_ceil(a: u128, b: u128, d: u128) -> Result<u128> {
    let product = a.checked_mul(b).ok_or_else(overflow)?;
    require!(d != 0, TestPerpError::ArithmeticOverflow);
    Ok(product.div_ceil(d))
}

fn ceil_div_signed(a: i128, d: i128) -> i128 {
    let quotient = a / d;
    if a % d != 0 && a > 0 {
        quotient + 1
    } else {
        quotient
    }
}

/// Executable price in collateral atoms per base lot. Spread and size impact always move the
/// price against the taker, and rounding also favors the venue.
pub fn fill_price_per_lot(
    market: &TestPerpMarket,
    oracle_per_lot: u64,
    base_lots: u64,
    side: OrderSide,
) -> Result<u64> {
    let impact_units = base_lots.div_ceil(market.impact_unit_lots);
    let impact = impact_units
        .checked_mul(u64::from(market.impact_bps_per_unit))
        .ok_or_else(overflow)?;
    let slippage = impact
        .checked_add(u64::from(market.half_spread_bps))
        .ok_or_else(overflow)?;
    require!(
        slippage <= u64::from(market.max_slippage_bps),
        TestPerpError::SlippageTooLarge
    );
    let oracle = u128::from(oracle_per_lot);
    let denominator = u128::from(BPS_DENOMINATOR);
    let price = match side {
        OrderSide::Ask => mul_div_floor(oracle, denominator - u128::from(slippage), denominator)?,
        OrderSide::Bid => mul_div_ceil(oracle, denominator + u128::from(slippage), denominator)?,
    };
    let price = u64::try_from(price).map_err(|_| overflow())?;
    require!(price > 0, TestPerpError::OraclePriceInvalid);
    Ok(price)
}

pub fn notional(price_per_lot: u64, base_lots: u64) -> Result<u64> {
    price_per_lot.checked_mul(base_lots).ok_or_else(overflow)
}

pub fn bps_ceil(amount: u64, bps: u16) -> Result<u64> {
    let value = mul_div_ceil(
        u128::from(amount),
        u128::from(bps),
        u128::from(BPS_DENOMINATOR),
    )?;
    u64::try_from(value).map_err(|_| overflow())
}

pub fn accrue_funding(market: &mut TestPerpMarket, oracle_per_lot: u64, now: i64) -> Result<()> {
    if now > market.last_funding_timestamp {
        let elapsed = i128::from(now - market.last_funding_timestamp);
        let delta = i128::from(market.funding_rate_per_second)
            .checked_mul(elapsed)
            .and_then(|value| value.checked_mul(i128::from(oracle_per_lot)))
            .ok_or_else(overflow)?;
        market.cumulative_funding_index = market
            .cumulative_funding_index
            .checked_add(delta)
            .ok_or_else(overflow)?;
        market.last_funding_timestamp = now;
    }
    Ok(())
}

/// Funding owed by the position since its last settlement. Positive means the trader pays.
/// A positive rate makes longs pay shorts. Rounds toward the trader paying more.
pub fn settle_funding(position: &mut TestPerpPosition, market_index: i128) -> Result<i128> {
    let delta = market_index
        .checked_sub(position.entry_funding_index)
        .ok_or_else(overflow)?;
    let owed = i128::from(position.base_lots)
        .checked_mul(delta)
        .map(|value| ceil_div_signed(value, FUNDING_RATE_SCALE))
        .ok_or_else(overflow)?;
    position.entry_funding_index = market_index;
    Ok(owed)
}

pub struct FillOutcome {
    /// Realized trader PnL in collateral atoms.
    pub realized_pnl: i128,
    pub increased_exposure: bool,
}

pub fn apply_fill(
    position: &mut TestPerpPosition,
    side: OrderSide,
    base_lots: u64,
    price_per_lot: u64,
) -> Result<FillOutcome> {
    let signed_lots = i64::try_from(base_lots).map_err(|_| overflow())?;
    let direction: i64 = match side {
        OrderSide::Bid => 1,
        OrderSide::Ask => -1,
    };
    let current = position.base_lots;
    if current == 0 || current.signum() == direction {
        position.entry_notional_atoms = position
            .entry_notional_atoms
            .checked_add(notional(price_per_lot, base_lots)?)
            .ok_or_else(overflow)?;
        position.base_lots = current
            .checked_add(direction * signed_lots)
            .ok_or_else(overflow)?;
        return Ok(FillOutcome {
            realized_pnl: 0,
            increased_exposure: true,
        });
    }

    let open_lots = current.unsigned_abs();
    let close_lots = base_lots.min(open_lots);
    let reopen_lots = base_lots - close_lots;
    let entry = u128::from(position.entry_notional_atoms);
    // The closed cost basis rounds against the trader: up for longs, down for shorts.
    let basis = if current > 0 {
        mul_div_ceil(entry, u128::from(close_lots), u128::from(open_lots))?
    } else {
        mul_div_floor(entry, u128::from(close_lots), u128::from(open_lots))?
    };
    let exit_value = i128::from(notional(price_per_lot, close_lots)?);
    let basis_i = i128::try_from(basis).map_err(|_| overflow())?;
    let realized_pnl = if current > 0 {
        exit_value - basis_i
    } else {
        basis_i - exit_value
    };
    position.entry_notional_atoms = u64::try_from(entry - basis).map_err(|_| overflow())?;
    position.base_lots = current + direction * close_lots as i64;
    if reopen_lots > 0 {
        position.entry_notional_atoms = notional(price_per_lot, reopen_lots)?;
        position.base_lots = direction * reopen_lots as i64;
    }
    Ok(FillOutcome {
        realized_pnl,
        increased_exposure: reopen_lots > 0,
    })
}

pub fn equity(position: &TestPerpPosition, oracle_per_lot: u64) -> Result<i128> {
    let mark = i128::from(notional(oracle_per_lot, position.base_lots.unsigned_abs())?);
    let entry = i128::from(position.entry_notional_atoms);
    let unrealized = if position.base_lots >= 0 {
        mark - entry
    } else {
        entry - mark
    };
    Ok(i128::from(position.collateral_atoms) + unrealized)
}

pub fn margin_requirement(
    position: &TestPerpPosition,
    oracle_per_lot: u64,
    margin_bps: u16,
) -> Result<i128> {
    let mark = notional(oracle_per_lot, position.base_lots.unsigned_abs())?;
    Ok(i128::from(bps_ceil(mark, margin_bps)?))
}

/// Token movements produced by one settlement.
#[derive(Default, Debug, PartialEq, Eq)]
pub struct Settlement {
    pub to_insurance: u64,
    pub from_insurance: u64,
    pub to_fee_vault: u64,
}

/// Applies a net trader-to-house flow (positive means the trader pays) and then a fee to the
/// position collateral. The insurance vault is the venue counterparty: it pays trader gains and
/// funding credits and receives trader losses. A loss beyond collateral floors collateral at
/// zero and is recorded as bad debt absorbed by the insurance vault.
pub fn apply_settlement(
    market: &mut TestPerpMarket,
    position: &mut TestPerpPosition,
    house_flow: i128,
    fee: u64,
) -> Result<Settlement> {
    let mut settlement = Settlement::default();
    if house_flow < 0 {
        let credit = u64::try_from(-house_flow).map_err(|_| overflow())?;
        position.collateral_atoms = position
            .collateral_atoms
            .checked_add(credit)
            .ok_or_else(overflow)?;
        settlement.from_insurance = credit;
    } else if house_flow > 0 {
        let debit = u64::try_from(house_flow).map_err(|_| overflow())?;
        let paid = debit.min(position.collateral_atoms);
        position.collateral_atoms -= paid;
        market.bad_debt_atoms = market
            .bad_debt_atoms
            .checked_add(debit - paid)
            .ok_or_else(overflow)?;
        settlement.to_insurance = paid;
    }
    let fee_paid = fee.min(position.collateral_atoms);
    position.collateral_atoms -= fee_paid;
    settlement.to_fee_vault = fee_paid;
    require!(
        position.collateral_atoms <= i64::MAX as u64,
        TestPerpError::ArithmeticOverflow
    );
    Ok(settlement)
}

pub fn update_open_interest(market: &mut TestPerpMarket, before: i64, after: i64) -> Result<()> {
    let remove = |value: i64, market: &mut TestPerpMarket| {
        if value > 0 {
            market.open_interest_long_lots -= value as u64;
        } else {
            market.open_interest_short_lots -= value.unsigned_abs();
        }
    };
    remove(before, market);
    if after > 0 {
        market.open_interest_long_lots = market
            .open_interest_long_lots
            .checked_add(after as u64)
            .ok_or_else(overflow)?;
    } else {
        market.open_interest_short_lots = market
            .open_interest_short_lots
            .checked_add(after.unsigned_abs())
            .ok_or_else(overflow)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn position() -> TestPerpPosition {
        TestPerpPosition {
            market: Pubkey::default(),
            owner: Pubkey::default(),
            delegate: Pubkey::default(),
            collateral_atoms: 1_000,
            base_lots: 0,
            entry_notional_atoms: 0,
            entry_funding_index: 0,
            bump: 0,
        }
    }

    #[test]
    fn realized_pnl_rounds_against_trader_and_flip_reopens() {
        let mut short = position();
        apply_fill(&mut short, OrderSide::Ask, 3, 10).unwrap();
        assert_eq!((short.base_lots, short.entry_notional_atoms), (-3, 30));
        // Partial cover of 1 of 3 lots with entry 30: basis floors to 10 for a short.
        let outcome = apply_fill(&mut short, OrderSide::Bid, 1, 7).unwrap();
        assert_eq!(outcome.realized_pnl, 3);
        assert!(!outcome.increased_exposure);
        // Flip through zero: close 2 lots, open 1 long at the same price.
        let outcome = apply_fill(&mut short, OrderSide::Bid, 3, 12).unwrap();
        assert_eq!(outcome.realized_pnl, 20 - 24);
        assert!(outcome.increased_exposure);
        assert_eq!((short.base_lots, short.entry_notional_atoms), (1, 12));
    }

    #[test]
    fn loss_beyond_collateral_floors_at_zero_and_records_bad_debt() {
        let mut market = TestPerpMarket::default();
        let mut trader = position();
        let settlement = apply_settlement(&mut market, &mut trader, 1_200, 5).unwrap();
        assert_eq!(trader.collateral_atoms, 0);
        assert_eq!(market.bad_debt_atoms, 200);
        assert_eq!(
            settlement,
            Settlement {
                to_insurance: 1_000,
                from_insurance: 0,
                to_fee_vault: 0
            }
        );
    }
}

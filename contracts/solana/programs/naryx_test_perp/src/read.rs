use anchor_lang::prelude::*;

use crate::{error::TestPerpError, TestPerpPosition};

/// Reads `(base_lots, collateral_quote_lots)` from a position account, mirroring the Rise
/// adapter's reader. One collateral quote lot is one collateral atom.
pub fn read_position_and_collateral(account: &AccountInfo) -> Result<(i64, i64)> {
    require_keys_eq!(
        *account.owner,
        crate::ID,
        TestPerpError::InvalidPositionAccount
    );
    let data = account.try_borrow_data()?;
    let position = TestPerpPosition::try_deserialize(&mut &data[..])
        .map_err(|_| error!(TestPerpError::InvalidPositionAccount))?;
    let collateral = i64::try_from(position.collateral_atoms)
        .map_err(|_| error!(TestPerpError::ArithmeticOverflow))?;
    Ok((position.base_lots, collateral))
}

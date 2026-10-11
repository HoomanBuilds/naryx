pub mod constants;
pub mod error;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("EbY7MezVnmueWnyUb5QXe6jr4Cxe95Znh1FhZiPf633c");

#[program]
pub mod naryx_inventory_adapter {
    use super::*;

    pub fn initialize_package_inventory(
        ctx: Context<InitializePackageInventory>,
        package_id: [u8; 32],
    ) -> Result<()> {
        initialize::initialize_handler(ctx, package_id)
    }

    pub fn execute_bound_strategy_leg(
        ctx: Context<ExecutePackageInventory>,
        context: StrategyLegContext,
        payload: Vec<u8>,
    ) -> Result<()> {
        execute::execute_handler(ctx, context, payload)
    }
}

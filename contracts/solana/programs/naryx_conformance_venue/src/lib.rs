pub mod constants;
pub mod error;
pub mod instructions;
pub mod math;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("ERGvPwyenaZDcAr9cyni7paeXPQ72NKC75ozz1fjCY7y");

#[program]
pub mod naryx_conformance_venue {
    use super::*;

    pub fn initialize_market(
        ctx: Context<InitializeMarket>,
        price_quote_atoms: u64,
        price_base_atoms: u64,
        spot_fee_bps: u16,
        initial_margin_bps: u16,
        max_spot_base_atoms: u64,
        max_perp_base_atoms: u64,
    ) -> Result<()> {
        initialize_market::handler(
            ctx,
            price_quote_atoms,
            price_base_atoms,
            spot_fee_bps,
            initial_margin_bps,
            max_spot_base_atoms,
            max_perp_base_atoms,
        )
    }

    pub fn set_paused(ctx: Context<SetPaused>, paused: bool) -> Result<()> {
        set_paused::handler(ctx, paused)
    }

    pub fn spot_buy_exact_output(
        ctx: Context<SpotBuyExactOutput>,
        base_atoms_out: u64,
        max_quote_atoms_in: u64,
    ) -> Result<()> {
        spot_buy_exact_output::handler(ctx, base_atoms_out, max_quote_atoms_in)
    }

    pub fn spot_sell_exact_input(
        ctx: Context<SpotSellExactInput>,
        base_atoms_in: u64,
        min_quote_atoms_out: u64,
    ) -> Result<()> {
        spot_sell_exact_input::handler(ctx, base_atoms_in, min_quote_atoms_out)
    }

    pub fn initialize_position(ctx: Context<InitializePosition>) -> Result<()> {
        initialize_position::handler(ctx)
    }

    pub fn open_short_exact(
        ctx: Context<OpenShortExact>,
        base_atoms: u64,
        max_collateral_quote_atoms: u64,
    ) -> Result<()> {
        open_short_exact::handler(ctx, base_atoms, max_collateral_quote_atoms)
    }

    pub fn close_short_exact(
        ctx: Context<CloseShortExact>,
        base_atoms: u64,
        min_collateral_return_atoms: u64,
    ) -> Result<()> {
        close_short_exact::handler(ctx, base_atoms, min_collateral_return_atoms)
    }
}

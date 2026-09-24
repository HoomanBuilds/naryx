use anchor_lang::prelude::*;

#[event]
pub struct ReservationFunded {
    pub reservation_class: Pubkey,
    pub reservation_id: [u8; 32],
    pub order_hash: [u8; 32],
    pub route_hash: [u8; 32],
    pub solver: Pubkey,
    pub strategy_authority: Pubkey,
    pub base_atoms: u64,
    pub quote_atoms: u64,
    pub expiry_slot: u64,
}

#[event]
pub struct ReservationFinalized {
    pub reservation_class: Pubkey,
    pub reservation_id: [u8; 32],
    pub quote_hash: [u8; 32],
}

#[event]
pub struct ReservationConsumed {
    pub reservation_class: Pubkey,
    pub reservation_id: [u8; 32],
    pub quote_hash: [u8; 32],
    pub base_atoms: u64,
    pub quote_atoms: u64,
}

#[event]
pub struct ReservationReleased {
    pub reservation_class: Pubkey,
    pub reservation_id: [u8; 32],
    pub base_atoms: u64,
}

use anchor_lang::prelude::*;
use naryx_core::{DomainRef, ProtocolId};

use crate::{
    constants::{RESERVATION_ACTION_ENTRY, RESERVATION_VERSION},
    error::ErrorCode,
};

#[account]
#[derive(InitSpace)]
pub struct ReservationClass {
    pub version: u16,
    pub domain: DomainRef,
    pub domain_identity: [u8; 32],
    pub base_mint: Pubkey,
    pub quote_mint: Pubkey,
    pub core_program: Pubkey,
    pub core_program_data: Pubkey,
    pub core_code_identity: [u8; 32],
    pub consumer_program: Pubkey,
    pub consumer_program_data: Pubkey,
    pub consumer_code_identity: [u8; 32],
    pub max_ttl_slots: u64,
    pub max_base_atoms: u64,
    pub max_solver_reserved_base_atoms: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct ReservationCapacity {
    pub reservation_class: Pubkey,
    pub solver: Pubkey,
    pub reserved_base_atoms: u64,
    pub bump: u8,
}

impl ReservationCapacity {
    pub fn reserve(&mut self, amount: u64, maximum: u64) -> Result<()> {
        let next = self
            .reserved_base_atoms
            .checked_add(amount)
            .ok_or_else(|| error!(ErrorCode::ArithmeticFailure))?;
        require!(next <= maximum, ErrorCode::AggregateCapacityExceeded);
        self.reserved_base_atoms = next;
        Ok(())
    }

    pub fn release(&mut self, amount: u64) -> Result<()> {
        self.reserved_base_atoms = self
            .reserved_base_atoms
            .checked_sub(amount)
            .ok_or_else(|| error!(ErrorCode::AggregateCapacityUnderflow))?;
        Ok(())
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace, Debug)]
pub enum ReservationState {
    Funded,
    Live,
    Consumed,
    Released,
}

#[account]
#[derive(InitSpace)]
pub struct FirmReservation {
    pub version: u16,
    pub reservation_class: Pubkey,
    pub domain: DomainRef,
    pub reservation_id: [u8; 32],
    pub solver_id: ProtocolId,
    pub solver: Pubkey,
    pub strategy_authority: Pubkey,
    pub package_nonce: u64,
    pub order_hash: [u8; 32],
    pub quote_hash: [u8; 32],
    pub route_hash: [u8; 32],
    pub reservation_nonce: [u8; 32],
    pub base_mint: Pubkey,
    pub quote_mint: Pubkey,
    pub solver_reclaim_base: Pubkey,
    pub solver_quote: Pubkey,
    pub strategy_base: Pubkey,
    pub strategy_quote: Pubkey,
    pub base_atoms: u64,
    pub quote_atoms: u64,
    pub expiry_slot: u64,
    pub action: u8,
    pub state: ReservationState,
    pub bump: u8,
    pub vault_bump: u8,
}

impl FirmReservation {
    pub fn is_open(&self) -> bool {
        matches!(
            self.state,
            ReservationState::Funded | ReservationState::Live
        )
    }

    pub fn finalize(
        &mut self,
        reservation_class: Pubkey,
        quote_hash: [u8; 32],
        current_slot: u64,
    ) -> Result<()> {
        self.require_current_entry()?;
        self.require_class(reservation_class)?;
        require!(quote_hash != [0u8; 32], ErrorCode::CommitmentZero);
        require!(
            self.state == ReservationState::Funded,
            ErrorCode::ReservationStateInvalid
        );
        require!(
            current_slot < self.expiry_slot,
            ErrorCode::ReservationExpired
        );
        self.quote_hash = quote_hash;
        self.state = ReservationState::Live;
        Ok(())
    }

    pub fn consume(
        &mut self,
        reservation_class: Pubkey,
        package_nonce: u64,
        order_hash: [u8; 32],
        quote_hash: [u8; 32],
        route_hash: [u8; 32],
        current_slot: u64,
    ) -> Result<()> {
        self.require_current_entry()?;
        self.require_class(reservation_class)?;
        require!(
            self.state == ReservationState::Live,
            ErrorCode::ReservationStateInvalid
        );
        require!(
            current_slot < self.expiry_slot,
            ErrorCode::ReservationExpired
        );
        require!(
            package_nonce == self.package_nonce
                && order_hash == self.order_hash
                && quote_hash == self.quote_hash
                && route_hash == self.route_hash,
            ErrorCode::AccountBindingMismatch
        );
        self.state = ReservationState::Consumed;
        Ok(())
    }

    pub fn release(&mut self, reservation_class: Pubkey, current_slot: u64) -> Result<()> {
        self.require_current_entry()?;
        self.require_class(reservation_class)?;
        require!(self.is_open(), ErrorCode::ReservationStateInvalid);
        require!(
            current_slot >= self.expiry_slot,
            ErrorCode::ReservationNotExpired
        );
        self.state = ReservationState::Released;
        Ok(())
    }

    pub fn require_class(&self, reservation_class: Pubkey) -> Result<()> {
        require_keys_eq!(
            self.reservation_class,
            reservation_class,
            ErrorCode::AccountBindingMismatch
        );
        Ok(())
    }

    pub fn require_current_entry(&self) -> Result<()> {
        require!(self.is_current_entry(), ErrorCode::ClassParameterInvalid);
        Ok(())
    }
}

pub fn validate_entry_deltas(
    base_atoms: u64,
    quote_atoms: u64,
    strategy_base_before: u64,
    strategy_base_after: u64,
    strategy_quote_before: u64,
    strategy_quote_after: u64,
    solver_quote_before: u64,
    solver_quote_after: u64,
    vault_before: u64,
    vault_after: u64,
) -> Result<()> {
    require!(
        strategy_base_after.checked_sub(strategy_base_before) == Some(base_atoms)
            && strategy_quote_before.checked_sub(strategy_quote_after) == Some(quote_atoms)
            && solver_quote_after.checked_sub(solver_quote_before) == Some(quote_atoms)
            && vault_before.checked_sub(vault_after) == Some(base_atoms)
            && vault_after == 0,
        ErrorCode::TokenDeltaMismatch
    );
    Ok(())
}

#[account]
#[derive(InitSpace)]
pub struct LivePair {
    pub reservation_class: Pubkey,
    pub solver: Pubkey,
    pub strategy_authority: Pubkey,
    pub reservation_id: [u8; 32],
    pub bump: u8,
}

impl ReservationClass {
    pub fn is_current_entry(&self) -> bool {
        self.version == RESERVATION_VERSION
    }
}

impl FirmReservation {
    pub fn is_current_entry(&self) -> bool {
        self.version == RESERVATION_VERSION && self.action == RESERVATION_ACTION_ENTRY
    }
}

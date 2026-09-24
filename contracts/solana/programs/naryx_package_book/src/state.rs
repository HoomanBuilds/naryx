use anchor_lang::prelude::*;
use naryx_core::{DomainRef, ProtocolId};
use solana_sha256_hasher::hashv;

use crate::{
    constants::{
        DOMAIN_REF_IDENTITY_DOMAIN, LEVEL_ACTIVE, LEVEL_INACTIVE, MAX_QUOTE_LEVELS,
        PACKAGE_BOOK_VERSION, QUOTE_MODE_EXECUTION_COMMITMENT, QUOTE_MODE_FIRM_ONCHAIN,
        QUOTE_SIDE_ASK, QUOTE_SIDE_BID,
    },
    error::ErrorCode,
};

#[account]
#[derive(InitSpace)]
pub struct PackageBookClass {
    pub version: u16,
    pub domain: DomainRef,
    pub domain_identity_hash: [u8; 32],
    pub domain_manifest_version: u32,
    pub domain_manifest_hash: [u8; 32],
    pub core_program: Pubkey,
    pub core_program_data: Pubkey,
    pub core_code_identity: [u8; 32],
    pub consumer_program: Pubkey,
    pub consumer_program_data: Pubkey,
    pub consumer_code_identity: [u8; 32],
    pub max_heartbeat_ttl_slots: u64,
    pub max_level_ttl_slots: u64,
    pub max_abs_reference_price: i128,
    pub max_abs_reference_offset: i128,
    pub max_fee_atoms: u64,
    pub firm_onchain_enabled: bool,
    pub bump: u8,
}

pub fn domain_ref_identity(domain: &DomainRef) -> [u8; 32] {
    let canonical = domain.canonical_bytes();
    hashv(&[DOMAIN_REF_IDENTITY_DOMAIN, canonical.as_ref()]).to_bytes()
}

#[zero_copy]
pub struct QuoteLevel {
    pub settlement_class_identity_hash: [u8; 32],
    pub reservation_policy_hash: [u8; 32],
    pub reference_offset: i128,
    pub level_id: u64,
    pub epoch: u64,
    pub level_sequence: u64,
    pub min_package_size_units: u64,
    pub max_package_size_units: u64,
    pub max_fee_atoms: u64,
    pub expiry_slot: u64,
    pub remaining_capacity: u64,
    pub active: u8,
    pub side: u8,
    pub quote_mode: u8,
    pub reserved: [u8; 13],
}

impl QuoteLevel {
    pub const EMPTY: Self = Self {
        settlement_class_identity_hash: [0u8; 32],
        reservation_policy_hash: [0u8; 32],
        reference_offset: 0,
        level_id: 0,
        epoch: 0,
        level_sequence: 0,
        min_package_size_units: 0,
        max_package_size_units: 0,
        max_fee_atoms: 0,
        expiry_slot: 0,
        remaining_capacity: 0,
        active: LEVEL_INACTIVE,
        side: 0,
        quote_mode: 0,
        reserved: [0u8; 13],
    };
}

#[account(zero_copy)]
pub struct QuoteLevelPage {
    pub levels: [QuoteLevel; MAX_QUOTE_LEVELS],
    pub shard: Pubkey,
    pub version: u16,
    pub bump: u8,
    pub reserved: [u8; 13],
}

#[account]
#[derive(InitSpace)]
pub struct PackageQuoteShard {
    pub version: u16,
    pub domain: DomainRef,
    pub package_book_class: Pubkey,
    pub solver: Pubkey,
    pub solver_id: ProtocolId,
    pub series_manifest_hash: [u8; 32],
    pub execution_class_manifest_hash: [u8; 32],
    pub core_program: Pubkey,
    pub core_program_data: Pubkey,
    pub core_code_identity: [u8; 32],
    pub consumer_program: Pubkey,
    pub consumer_program_data: Pubkey,
    pub consumer_code_identity: [u8; 32],
    pub reference_package_price: i128,
    pub reference_state_hash: [u8; 32],
    pub reference_sequence: u64,
    pub shard_sequence: u64,
    pub heartbeat_expiry_slot: u64,
    pub epoch: u64,
    pub killed: bool,
    pub level_count: u16,
    pub level_page_bump: u8,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub struct QuoteLevelUpdate {
    pub slot_index: u8,
    pub expected_level_sequence: u64,
    pub new_level_sequence: u64,
    pub level_id: u64,
    pub side: u8,
    pub min_package_size_units: u64,
    pub max_package_size_units: u64,
    pub reference_offset: i128,
    pub max_fee_atoms: u64,
    pub settlement_class_identity_hash: [u8; 32],
    pub quote_mode: u8,
    pub reservation_policy_hash: [u8; 32],
    pub expiry_slot: u64,
    pub remaining_capacity: u64,
}

impl PackageBookClass {
    pub fn validate_reference_price(&self, value: i128) -> Result<()> {
        let magnitude = value
            .checked_abs()
            .ok_or_else(|| error!(ErrorCode::ArithmeticFailure))?;
        require!(
            magnitude <= self.max_abs_reference_price,
            ErrorCode::ReferencePriceOutOfBounds
        );
        Ok(())
    }

    pub fn validate_heartbeat(&self, current_slot: u64, expiry_slot: u64) -> Result<()> {
        let maximum = current_slot
            .checked_add(self.max_heartbeat_ttl_slots)
            .ok_or_else(|| error!(ErrorCode::ArithmeticFailure))?;
        require!(
            expiry_slot > current_slot && expiry_slot <= maximum,
            ErrorCode::HeartbeatInvalid
        );
        Ok(())
    }
}

impl PackageQuoteShard {
    pub fn next_shard_sequence(&self, expected: u64) -> Result<u64> {
        require!(expected == self.shard_sequence, ErrorCode::SequenceMismatch);
        self.shard_sequence
            .checked_add(1)
            .ok_or_else(|| error!(ErrorCode::SequenceOverflow))
    }

    pub fn update_reference(
        &mut self,
        class: &PackageBookClass,
        expected_reference_sequence: u64,
        expected_shard_sequence: u64,
        reference_package_price: i128,
        reference_state_hash: [u8; 32],
        heartbeat_expiry_slot: u64,
        current_slot: u64,
    ) -> Result<()> {
        require!(
            expected_reference_sequence == self.reference_sequence,
            ErrorCode::SequenceMismatch
        );
        require!(
            reference_state_hash != [0u8; 32],
            ErrorCode::ReferenceStateHashZero
        );
        class.validate_reference_price(reference_package_price)?;
        class.validate_heartbeat(current_slot, heartbeat_expiry_slot)?;
        let next_reference_sequence = self
            .reference_sequence
            .checked_add(1)
            .ok_or_else(|| error!(ErrorCode::SequenceOverflow))?;
        let next_shard_sequence = self.next_shard_sequence(expected_shard_sequence)?;
        self.reference_sequence = next_reference_sequence;
        self.shard_sequence = next_shard_sequence;
        self.reference_package_price = reference_package_price;
        self.reference_state_hash = reference_state_hash;
        self.heartbeat_expiry_slot = heartbeat_expiry_slot;
        Ok(())
    }

    pub fn validate_fresh(&self, current_slot: u64) -> Result<()> {
        require!(
            current_slot < self.heartbeat_expiry_slot,
            ErrorCode::HeartbeatInvalid
        );
        Ok(())
    }

    pub fn validate_level(
        &self,
        class: &PackageBookClass,
        update: &QuoteLevelUpdate,
        current_slot: u64,
    ) -> Result<()> {
        require!(update.level_id != 0, ErrorCode::LevelParameterInvalid);
        require!(
            update.side == QUOTE_SIDE_BID || update.side == QUOTE_SIDE_ASK,
            ErrorCode::LevelParameterInvalid
        );
        require!(
            update.min_package_size_units != 0
                && update.min_package_size_units <= update.max_package_size_units
                && update.remaining_capacity >= update.min_package_size_units
                && update.max_package_size_units <= update.remaining_capacity,
            ErrorCode::LevelParameterInvalid
        );
        let offset_magnitude = update
            .reference_offset
            .checked_abs()
            .ok_or_else(|| error!(ErrorCode::ArithmeticFailure))?;
        require!(
            offset_magnitude <= class.max_abs_reference_offset,
            ErrorCode::LevelParameterInvalid
        );
        self.reference_package_price
            .checked_add(update.reference_offset)
            .ok_or_else(|| error!(ErrorCode::ArithmeticFailure))?;
        require!(
            update.max_fee_atoms <= class.max_fee_atoms,
            ErrorCode::LevelParameterInvalid
        );
        require!(
            update.settlement_class_identity_hash != [0u8; 32],
            ErrorCode::IdentityHashZero
        );
        match update.quote_mode {
            QUOTE_MODE_EXECUTION_COMMITMENT => require!(
                update.reservation_policy_hash == [0u8; 32],
                ErrorCode::LevelParameterInvalid
            ),
            QUOTE_MODE_FIRM_ONCHAIN => {
                require!(class.firm_onchain_enabled, ErrorCode::FirmOnchainDisabled);
                require!(
                    update.reservation_policy_hash != [0u8; 32],
                    ErrorCode::LevelParameterInvalid
                );
            }
            _ => return err!(ErrorCode::QuoteModeUnsupported),
        }
        let maximum_expiry = current_slot
            .checked_add(class.max_level_ttl_slots)
            .ok_or_else(|| error!(ErrorCode::ArithmeticFailure))?;
        require!(
            update.expiry_slot > current_slot
                && update.expiry_slot <= maximum_expiry
                && update.expiry_slot <= self.heartbeat_expiry_slot,
            ErrorCode::LevelParameterInvalid
        );
        Ok(())
    }

    pub fn upsert_level(
        &mut self,
        levels: &mut [QuoteLevel; MAX_QUOTE_LEVELS],
        class: &PackageBookClass,
        update: QuoteLevelUpdate,
        current_slot: u64,
    ) -> Result<()> {
        let index = usize::from(update.slot_index);
        require!(index < MAX_QUOTE_LEVELS, ErrorCode::LevelSlotInvalid);
        self.validate_level(class, &update, current_slot)?;
        let previous = levels[index];
        let active = previous.active == LEVEL_ACTIVE && previous.epoch == self.epoch;
        if active {
            require!(
                previous.level_id == update.level_id
                    && previous.level_sequence == update.expected_level_sequence,
                ErrorCode::SequenceMismatch
            );
            require!(
                update.new_level_sequence
                    == previous
                        .level_sequence
                        .checked_add(1)
                        .ok_or_else(|| error!(ErrorCode::SequenceOverflow))?,
                ErrorCode::SequenceMismatch
            );
        } else {
            require!(
                update.expected_level_sequence == 0 && update.new_level_sequence == 1,
                ErrorCode::SequenceMismatch
            );
            self.level_count = self
                .level_count
                .checked_add(1)
                .ok_or_else(|| error!(ErrorCode::ArithmeticFailure))?;
        }
        levels[index] = QuoteLevel {
            settlement_class_identity_hash: update.settlement_class_identity_hash,
            reservation_policy_hash: update.reservation_policy_hash,
            reference_offset: update.reference_offset,
            level_id: update.level_id,
            epoch: self.epoch,
            level_sequence: update.new_level_sequence,
            min_package_size_units: update.min_package_size_units,
            max_package_size_units: update.max_package_size_units,
            max_fee_atoms: update.max_fee_atoms,
            expiry_slot: update.expiry_slot,
            remaining_capacity: update.remaining_capacity,
            active: LEVEL_ACTIVE,
            side: update.side,
            quote_mode: update.quote_mode,
            reserved: [0u8; 13],
        };
        Ok(())
    }

    pub fn cancel_level(
        &mut self,
        levels: &mut [QuoteLevel; MAX_QUOTE_LEVELS],
        slot_index: u8,
        level_id: u64,
        expected_level_sequence: u64,
    ) -> Result<()> {
        let index = usize::from(slot_index);
        require!(index < MAX_QUOTE_LEVELS, ErrorCode::LevelSlotInvalid);
        let level = &mut levels[index];
        require!(
            level.active == LEVEL_ACTIVE
                && level.epoch == self.epoch
                && level.level_id == level_id
                && level.level_sequence == expected_level_sequence,
            ErrorCode::LevelInactive
        );
        level.active = LEVEL_INACTIVE;
        self.level_count = self
            .level_count
            .checked_sub(1)
            .ok_or_else(|| error!(ErrorCode::ArithmeticFailure))?;
        Ok(())
    }

    pub fn cancel_all(&mut self) -> Result<()> {
        self.epoch = self
            .epoch
            .checked_add(1)
            .ok_or_else(|| error!(ErrorCode::SequenceOverflow))?;
        self.level_count = 0;
        Ok(())
    }

    pub fn consume_level(
        &mut self,
        levels: &mut [QuoteLevel; MAX_QUOTE_LEVELS],
        slot_index: u8,
        level_id: u64,
        expected_level_sequence: u64,
        package_size_units: u64,
        current_slot: u64,
    ) -> Result<QuoteLevel> {
        let index = usize::from(slot_index);
        require!(index < MAX_QUOTE_LEVELS, ErrorCode::LevelSlotInvalid);
        let level = &mut levels[index];
        require!(
            level.active == LEVEL_ACTIVE
                && level.epoch == self.epoch
                && level.level_id == level_id
                && level.level_sequence == expected_level_sequence,
            ErrorCode::LevelInactive
        );
        require!(current_slot < level.expiry_slot, ErrorCode::LevelExpired);
        require!(
            package_size_units >= level.min_package_size_units
                && package_size_units <= level.max_package_size_units
                && package_size_units <= level.remaining_capacity,
            ErrorCode::CapacityInsufficient
        );
        level.remaining_capacity = level
            .remaining_capacity
            .checked_sub(package_size_units)
            .ok_or_else(|| error!(ErrorCode::ArithmeticFailure))?;
        let consumed = *level;
        if level.remaining_capacity < level.min_package_size_units {
            level.active = LEVEL_INACTIVE;
            self.level_count = self
                .level_count
                .checked_sub(1)
                .ok_or_else(|| error!(ErrorCode::ArithmeticFailure))?;
        }
        Ok(consumed)
    }

    pub fn is_v1(&self) -> bool {
        self.version == PACKAGE_BOOK_VERSION
    }
}

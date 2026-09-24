use anchor_lang::prelude::*;

use crate::{
    constants::{
        ADAPTER_RESOURCE_SEED, ASSET_RESOURCE_SEED, MARKET_RESOURCE_SEED, VENUE_RESOURCE_SEED,
    },
    error::ErrorCode,
    wire::{DomainRef, ProtocolId, HASH_BYTE_LENGTH},
};

pub const SPOT_ADAPTER_CLASS_ID: &str = "naryx.solana.spot-exact";
pub const FIRM_RESERVATION_SPOT_ADAPTER_CLASS_ID: &str = "naryx.solana.spot-firm-reservation";
pub const PERP_ADAPTER_CLASS_ID: &str = "naryx.solana.perp-exact";
pub const CASH_AND_CARRY_TEMPLATE_ID: &str = "cash-and-carry-v1";
pub const SUPPORTED_ADAPTER_CLASS_VERSION: u32 = 1;
pub const SUPPORTED_TEMPLATE_VERSION: u32 = 1;
pub const SUPPORTED_SETTLEMENT_VERSION: u32 = 1;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace, Debug)]
pub enum ResourceKind {
    Asset,
    Venue,
    Market,
    Adapter,
}

impl ResourceKind {
    pub fn seed(self) -> &'static [u8] {
        match self {
            Self::Asset => ASSET_RESOURCE_SEED,
            Self::Venue => VENUE_RESOURCE_SEED,
            Self::Market => MARKET_RESOURCE_SEED,
            Self::Adapter => ADAPTER_RESOURCE_SEED,
        }
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace, Debug)]
pub enum ExecutionRole {
    None,
    Spot,
    Perp,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace, Debug)]
pub enum Lifecycle {
    Active,
    EntryPaused,
    ExitOnly,
    AllPaused,
    Deprecated,
}

impl Lifecycle {
    pub fn permissions(self) -> u8 {
        match self {
            Self::Active => 0b11,
            Self::EntryPaused | Self::ExitOnly => 0b10,
            Self::AllPaused | Self::Deprecated => 0,
        }
    }

    pub fn allows_entry(self) -> bool {
        self.permissions() & 0b01 != 0
    }

    pub fn allows_exit(self) -> bool {
        self.permissions() & 0b10 != 0
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace, Debug)]
pub enum SettlementClass {
    AtomicPostcondition,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, InitSpace, Debug)]
pub struct ManifestRef {
    pub subject_id: [u8; HASH_BYTE_LENGTH],
    pub manifest_version: u32,
    pub manifest_hash: [u8; HASH_BYTE_LENGTH],
}

impl ManifestRef {
    pub fn validate(&self) -> Result<()> {
        require!(
            self.subject_id != [0u8; HASH_BYTE_LENGTH],
            ErrorCode::ResourceSubjectZero
        );
        require!(
            self.manifest_version != 0,
            ErrorCode::ResourceManifestVersionZero
        );
        require!(
            self.manifest_hash != [0u8; HASH_BYTE_LENGTH],
            ErrorCode::ResourceManifestHashZero
        );
        Ok(())
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, InitSpace, Debug)]
pub struct DescriptorRef {
    pub id: ProtocolId,
    pub version: u32,
    pub manifest_hash: [u8; HASH_BYTE_LENGTH],
}

impl DescriptorRef {
    pub fn new(id: &str, version: u32, manifest_hash: [u8; HASH_BYTE_LENGTH]) -> Result<Self> {
        require!(version != 0, ErrorCode::ResourceDescriptorVersionZero);
        require!(
            manifest_hash != [0u8; HASH_BYTE_LENGTH],
            ErrorCode::ResourceDescriptorHashZero
        );
        Ok(Self {
            id: ProtocolId::new(id)?,
            version,
            manifest_hash,
        })
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, InitSpace, Debug)]
pub struct SettlementRef {
    pub class: SettlementClass,
    pub version: u32,
    pub manifest_hash: [u8; HASH_BYTE_LENGTH],
}

impl SettlementRef {
    pub fn validate(&self) -> Result<()> {
        require!(
            self.version == SUPPORTED_SETTLEMENT_VERSION,
            ErrorCode::ResourceSettlementUnsupported
        );
        require!(
            self.manifest_hash != [0u8; HASH_BYTE_LENGTH],
            ErrorCode::ResourceDescriptorHashZero
        );
        Ok(())
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, InitSpace, Debug)]
pub struct QuoteLimit {
    pub quote_asset: ManifestRef,
    pub quote_decimals: u8,
    pub maximum_notional_atoms: u64,
}

impl QuoteLimit {
    pub fn validate(&self, quote_asset: &ManifestRef, quote_decimals: u8) -> Result<()> {
        self.quote_asset.validate()?;
        require!(
            self.quote_asset == *quote_asset && self.quote_decimals == quote_decimals,
            ErrorCode::ResourceQuoteLimitMismatch
        );
        require!(
            self.maximum_notional_atoms != 0,
            ErrorCode::ResourceMaximumNotionalZero
        );
        Ok(())
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, InitSpace, Debug)]
pub struct ResourceControl {
    pub lifecycle: Lifecycle,
    pub quote_limit: Option<QuoteLimit>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, InitSpace, Debug)]
pub struct MarketUnits {
    pub base_decimals: u8,
    pub quote_decimals: u8,
    pub base_lot_atoms: u64,
    pub quote_tick_atoms_per_base_lot: u64,
    pub minimum_quote_notional_atoms: u64,
    pub multiplier_numerator: u64,
    pub multiplier_denominator: u64,
}

impl MarketUnits {
    pub fn validate(&self, base_decimals: u8, quote_decimals: u8) -> Result<()> {
        require!(
            self.base_decimals == base_decimals && self.quote_decimals == quote_decimals,
            ErrorCode::ResourceDecimalsMismatch
        );
        require!(
            self.base_lot_atoms != 0
                && self.quote_tick_atoms_per_base_lot != 0
                && self.minimum_quote_notional_atoms != 0
                && self.multiplier_numerator != 0
                && self.multiplier_denominator != 0,
            ErrorCode::ResourceMarketUnitZero
        );
        require!(
            gcd(self.multiplier_numerator, self.multiplier_denominator) == 1,
            ErrorCode::ResourceMarketMultiplierNotReduced
        );
        Ok(())
    }
}

fn gcd(mut left: u64, mut right: u64) -> u64 {
    while right != 0 {
        let remainder = left % right;
        left = right;
        right = remainder;
    }
    left
}

impl ResourceControl {
    pub fn fail_closed() -> Self {
        Self {
            lifecycle: Lifecycle::AllPaused,
            quote_limit: None,
        }
    }

    pub fn validate_for(&self, manifest: &ResourceManifest) -> Result<()> {
        match manifest.kind {
            ResourceKind::Asset => require!(
                self.quote_limit.is_none(),
                ErrorCode::ResourceQuoteLimitUnexpected
            ),
            ResourceKind::Venue | ResourceKind::Market | ResourceKind::Adapter => {
                self.quote_limit
                    .as_ref()
                    .ok_or_else(|| error!(ErrorCode::ResourceQuoteLimitMissing))?
                    .validate(
                        manifest
                            .quote_asset
                            .as_ref()
                            .ok_or_else(|| error!(ErrorCode::ResourceReferenceShape))?,
                        manifest.quote_decimals,
                    )?;
            }
        }
        Ok(())
    }

    pub fn is_immediate_tightening_of(&self, current: &Self) -> bool {
        if self.lifecycle.permissions() | current.lifecycle.permissions()
            != current.lifecycle.permissions()
        {
            return false;
        }
        match (&self.quote_limit, &current.quote_limit) {
            (None, None) => true,
            (Some(next), Some(active)) => {
                next.quote_asset == active.quote_asset
                    && next.quote_decimals == active.quote_decimals
                    && next.maximum_notional_atoms <= active.maximum_notional_atoms
            }
            _ => false,
        }
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, InitSpace, Debug)]
pub struct PendingControl {
    pub control: ResourceControl,
    pub activation_slot: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, InitSpace, Debug)]
pub struct ResourceManifest {
    pub kind: ResourceKind,
    pub domain: DomainRef,
    pub identity: ManifestRef,
    pub subject_address: Pubkey,
    pub program_id: Pubkey,
    pub program_data: Pubkey,
    pub code_identity: [u8; HASH_BYTE_LENGTH],
    pub decimals: u8,
    pub quote_decimals: u8,
    pub role: ExecutionRole,
    pub adapter_class: Option<DescriptorRef>,
    pub venue: Option<ManifestRef>,
    pub market: Option<ManifestRef>,
    pub base_asset: Option<ManifestRef>,
    pub quote_asset: Option<ManifestRef>,
    pub allowed_template: Option<DescriptorRef>,
    pub settlement: Option<SettlementRef>,
    pub market_units: Option<MarketUnits>,
}

#[account]
#[derive(InitSpace)]
pub struct ResourceRecord {
    pub manifest: ResourceManifest,
    pub control: ResourceControl,
    pub pending_control: Option<PendingControl>,
    pub active: bool,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct ResourceIndex {
    pub kind: ResourceKind,
    pub subject_id: [u8; HASH_BYTE_LENGTH],
    pub latest_version: u32,
    pub active_record: Pubkey,
    pub active_identity: Option<ManifestRef>,
    pub pending_record: Pubkey,
    pub pending_identity: Option<ManifestRef>,
    pub activation_slot: Option<u64>,
    pub bump: u8,
}

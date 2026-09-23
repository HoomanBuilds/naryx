use anchor_lang::prelude::*;
use solana_sha256_hasher::hashv;

use super::{DomainRef, ProtocolId, HASH_BYTE_LENGTH};
use crate::error::ErrorCode;

const ORDER_HASH_DOMAIN: &[u8] = b"CON/v1/order";

macro_rules! wire_enum {
    ($name:ident { $($variant:ident = $value:expr),+ $(,)? }) => {
        #[derive(Clone, Copy, Debug, PartialEq, Eq)]
        #[repr(u8)]
        pub enum $name {
            $($variant = $value),+
        }

        impl $name {
            fn discriminant(self) -> u8 {
                self as u8
            }
        }

        impl TryFrom<u8> for $name {
            type Error = anchor_lang::error::Error;

            fn try_from(value: u8) -> Result<Self> {
                match value {
                    $($value => Ok(Self::$variant),)+
                    _ => err!(ErrorCode::WireEnumUnknown),
                }
            }
        }
    };
}

wire_enum!(ExpiryUnit {
    SolanaSlot = 1,
    EvmUnixSeconds = 2,
    HyperliquidUnixMilliseconds = 3,
});
wire_enum!(Direction {
    LongSpotShortPerp = 1,
});
wire_enum!(PackageAction {
    Entry = 1,
    Exit = 2,
});
wire_enum!(PackageOrderType {
    Limit = 1,
    MarketableLimit = 2,
    PostOnly = 3,
    Conditional = 4,
    Scheduled = 5,
    PackageTwap = 6,
});
wire_enum!(PackageTimeInForce {
    Ioc = 1,
    Fok = 2,
    Gtc = 3,
    Gtd = 4,
});
wire_enum!(PartialFillPolicy {
    ExactAllLegs = 1,
});
wire_enum!(QuantityPolicyClass {
    ExactAtomic = 1,
    ExactNet = 2,
    BoundedNet = 3,
});
wire_enum!(RoundingDirection {
    Floor = 1,
    Ceil = 2,
    TowardZero = 3,
    AwayFromZero = 4,
});
wire_enum!(SettlementClass {
    AtomicPostcondition = 1,
    BatchedIocWithRecovery = 2,
});
wire_enum!(RecoveryAction {
    CancelOpenOrders = 1,
    CompleteSpot = 2,
    CompletePerp = 3,
    RollbackSpot = 4,
    RollbackPerp = 5,
});

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct U256([u8; 32]);

impl U256 {
    pub fn from_be_bytes(value: [u8; 32]) -> Self {
        Self(value)
    }

    pub fn try_from_be_slice(value: &[u8]) -> Result<Self> {
        let bytes: [u8; 32] = value
            .try_into()
            .map_err(|_| error!(ErrorCode::WireIntegerWidth))?;
        Ok(Self(bytes))
    }

    pub fn from_u64(value: u64) -> Self {
        let mut bytes = [0u8; 32];
        bytes[24..].copy_from_slice(&value.to_be_bytes());
        Self(bytes)
    }

    pub fn to_be_bytes(self) -> [u8; 32] {
        self.0
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ManifestHash([u8; HASH_BYTE_LENGTH]);

impl ManifestHash {
    pub fn new(value: [u8; HASH_BYTE_LENGTH]) -> Result<Self> {
        require!(
            value != [0u8; HASH_BYTE_LENGTH],
            ErrorCode::WireManifestHashZero
        );
        Ok(Self(value))
    }

    pub fn bytes(self) -> [u8; HASH_BYTE_LENGTH] {
        self.0
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CommitmentHash([u8; HASH_BYTE_LENGTH]);

impl CommitmentHash {
    pub fn new(value: [u8; HASH_BYTE_LENGTH]) -> Result<Self> {
        require!(
            value != [0u8; HASH_BYTE_LENGTH],
            ErrorCode::WireCommitmentHashZero
        );
        Ok(Self(value))
    }

    pub fn bytes(self) -> [u8; HASH_BYTE_LENGTH] {
        self.0
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AssetRef {
    asset_id: ProtocolId,
    asset_manifest_hash: ManifestHash,
    decimals: u8,
}

impl AssetRef {
    pub fn new(
        asset_id: &str,
        asset_manifest_hash: [u8; HASH_BYTE_LENGTH],
        decimals: u8,
    ) -> Result<Self> {
        Ok(Self {
            asset_id: ProtocolId::new(asset_id)?,
            asset_manifest_hash: ManifestHash::new(asset_manifest_hash)?,
            decimals,
        })
    }

    pub fn asset_id(&self) -> &str {
        self.asset_id.as_str()
    }

    pub fn asset_manifest_hash(&self) -> [u8; HASH_BYTE_LENGTH] {
        self.asset_manifest_hash.bytes()
    }

    pub fn decimals(&self) -> u8 {
        self.decimals
    }

    fn encode(&self, out: &mut Vec<u8>) {
        out.extend_from_slice(&self.asset_id.canonical_bytes());
        out.extend_from_slice(&self.asset_manifest_hash.0);
        out.push(self.decimals);
    }

    fn canonical_bytes(&self) -> Vec<u8> {
        let mut out = Vec::new();
        self.encode(&mut out);
        out
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AssetAmount {
    asset: AssetRef,
    atoms: i128,
}

impl AssetAmount {
    pub fn new(asset: AssetRef, atoms: i128) -> Self {
        Self { asset, atoms }
    }

    pub fn asset(&self) -> &AssetRef {
        &self.asset
    }

    pub fn atoms(&self) -> i128 {
        self.atoms
    }

    fn encode(&self, out: &mut Vec<u8>) {
        self.asset.encode(out);
        out.extend_from_slice(&self.atoms.to_be_bytes());
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExactPrice {
    base_asset: AssetRef,
    quote_asset: AssetRef,
    quote_atoms: u128,
    base_atoms: u128,
    rounding_direction: RoundingDirection,
}

impl ExactPrice {
    pub fn new(
        base_asset: AssetRef,
        quote_asset: AssetRef,
        quote_atoms: u128,
        base_atoms: u128,
        rounding_direction: RoundingDirection,
    ) -> Result<Self> {
        require!(quote_atoms != 0, ErrorCode::WirePositiveValueZero);
        require!(base_atoms != 0, ErrorCode::WirePositiveValueZero);
        require!(
            gcd(quote_atoms, base_atoms) == 1,
            ErrorCode::WireFractionNotReduced
        );
        Ok(Self {
            base_asset,
            quote_asset,
            quote_atoms,
            base_atoms,
            rounding_direction,
        })
    }

    fn encode(&self, out: &mut Vec<u8>) {
        self.base_asset.encode(out);
        self.quote_asset.encode(out);
        out.extend_from_slice(&self.quote_atoms.to_be_bytes());
        out.extend_from_slice(&self.base_atoms.to_be_bytes());
        out.push(self.rounding_direction.discriminant());
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExactSignedRate {
    base_asset: AssetRef,
    quote_asset: AssetRef,
    quote_atoms: i128,
    base_atoms: u128,
    rounding_direction: RoundingDirection,
}

impl ExactSignedRate {
    pub fn new(
        base_asset: AssetRef,
        quote_asset: AssetRef,
        quote_atoms: i128,
        base_atoms: u128,
        rounding_direction: RoundingDirection,
    ) -> Result<Self> {
        require!(base_atoms != 0, ErrorCode::WirePositiveValueZero);
        require!(
            quote_atoms != 0 || base_atoms == 1,
            ErrorCode::WireFractionNotReduced
        );
        require!(
            gcd(quote_atoms.unsigned_abs(), base_atoms) == 1,
            ErrorCode::WireFractionNotReduced
        );
        Ok(Self {
            base_asset,
            quote_asset,
            quote_atoms,
            base_atoms,
            rounding_direction,
        })
    }

    fn encode(&self, out: &mut Vec<u8>) {
        self.base_asset.encode(out);
        self.quote_asset.encode(out);
        out.extend_from_slice(&self.quote_atoms.to_be_bytes());
        out.extend_from_slice(&self.base_atoms.to_be_bytes());
        out.push(self.rounding_direction.discriminant());
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FeeCap {
    asset: AssetRef,
    max_atoms: i128,
}

impl FeeCap {
    pub fn new(asset: AssetRef, max_atoms: i128) -> Self {
        Self { asset, max_atoms }
    }

    fn encode(&self, out: &mut Vec<u8>) {
        self.asset.encode(out);
        out.extend_from_slice(&self.max_atoms.to_be_bytes());
    }

    fn key(&self) -> Vec<u8> {
        self.asset.canonical_bytes()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AdapterRef {
    adapter_id: ProtocolId,
    adapter_manifest_version: u32,
    adapter_manifest_hash: ManifestHash,
}

impl AdapterRef {
    pub fn new(
        adapter_id: &str,
        adapter_manifest_version: u32,
        adapter_manifest_hash: [u8; HASH_BYTE_LENGTH],
    ) -> Result<Self> {
        require!(adapter_manifest_version != 0, ErrorCode::WireVersionZero);
        Ok(Self {
            adapter_id: ProtocolId::new(adapter_id)?,
            adapter_manifest_version,
            adapter_manifest_hash: ManifestHash::new(adapter_manifest_hash)?,
        })
    }

    fn encode(&self, out: &mut Vec<u8>) {
        out.extend_from_slice(&self.adapter_id.canonical_bytes());
        out.extend_from_slice(&self.adapter_manifest_version.to_be_bytes());
        out.extend_from_slice(&self.adapter_manifest_hash.0);
    }

    fn key(&self) -> Vec<u8> {
        let mut out = Vec::new();
        self.encode(&mut out);
        out
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PackageOrderInput {
    pub version: u32,
    pub environment: ProtocolId,
    pub domain: DomainRef,
    pub template_id: ProtocolId,
    pub template_version: u32,
    pub package_template_manifest_hash: ManifestHash,
    pub owner: ProtocolId,
    pub settlement_account: ProtocolId,
    pub nonce: U256,
    pub expiry_unit: ExpiryUnit,
    pub expiry_value: u64,
    pub direction: Direction,
    pub action: PackageAction,
    pub package_order_type: PackageOrderType,
    pub package_time_in_force: PackageTimeInForce,
    pub partial_fill_policy: PartialFillPolicy,
    pub activation_condition_hash: Option<CommitmentHash>,
    pub execution_schedule_hash: Option<CommitmentHash>,
    pub quantity: AssetAmount,
    pub hyperliquid_quantity_policy: Option<QuantityPolicyClass>,
    pub hyperliquid_gross_spot_quantity: Option<AssetAmount>,
    pub hyperliquid_min_net_spot_delta: Option<AssetAmount>,
    pub hyperliquid_max_net_spot_delta: Option<AssetAmount>,
    pub hyperliquid_max_terminal_residual_base_quantity: Option<AssetAmount>,
    pub hyperliquid_residual_valuation_schema_version: Option<u32>,
    pub hyperliquid_residual_valuation_reference_price: Option<ExactPrice>,
    pub hyperliquid_max_terminal_residual_quote_value: Option<AssetAmount>,
    pub expected_pre_strategy_spot_quantity: Option<AssetAmount>,
    pub hyperliquid_recovery_expiry_unit: Option<ExpiryUnit>,
    pub hyperliquid_max_recovery_action_expiry_value: Option<u64>,
    pub hyperliquid_recovery_deadline_value: Option<u64>,
    pub hyperliquid_min_recovery_window_ms: Option<u64>,
    pub exit_outcome_schema_version: u32,
    pub entry_receipt_hash: Option<CommitmentHash>,
    pub expected_pre_position_size: AssetAmount,
    pub expected_pre_position_entry_notional: AssetAmount,
    pub max_entry_spread: Option<ExactSignedRate>,
    pub min_exit_quote_outcome: Option<AssetAmount>,
    pub max_spot_quote_in: Option<AssetAmount>,
    pub min_spot_quote_out: Option<AssetAmount>,
    pub hyperliquid_min_perp_sell_price: Option<ExactPrice>,
    pub hyperliquid_max_perp_buy_price: Option<ExactPrice>,
    pub max_margin_added: AssetAmount,
    pub min_venue_reserve_returned: AssetAmount,
    pub min_wallet_quote_balance_delta: AssetAmount,
    pub max_venue_fee_atoms_by_asset: Vec<FeeCap>,
    pub max_protocol_fee: AssetAmount,
    pub max_solver_fee: AssetAmount,
    pub max_priority_fee: AssetAmount,
    pub max_recovery_cost_atoms_by_asset: Vec<FeeCap>,
    pub permitted_spot_adapters: Vec<AdapterRef>,
    pub permitted_perp_adapters: Vec<AdapterRef>,
    pub settlement_class: SettlementClass,
    pub max_recovery_spot_buy_price: Option<ExactPrice>,
    pub min_recovery_spot_sell_price: Option<ExactPrice>,
    pub min_recovery_perp_sell_price: Option<ExactPrice>,
    pub max_recovery_perp_buy_price: Option<ExactPrice>,
    pub max_aggregate_recovery_loss_quote: AssetAmount,
    pub max_residual_base_quantity: AssetAmount,
    pub allowed_recovery_actions: Vec<RecoveryAction>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PackageOrder(PackageOrderInput);

impl PackageOrder {
    pub fn new(input: PackageOrderInput) -> Result<Self> {
        require!(input.version != 0, ErrorCode::WireVersionZero);
        require!(input.template_version != 0, ErrorCode::WireVersionZero);
        if let Some(version) = input.hyperliquid_residual_valuation_schema_version {
            require!(version != 0, ErrorCode::WireVersionZero);
        }
        if let Some(window) = input.hyperliquid_min_recovery_window_ms {
            require!(window != 0, ErrorCode::WireRecoveryWindowZero);
        }
        require_canonical(&input.max_venue_fee_atoms_by_asset, FeeCap::key, false)?;
        require_canonical(&input.max_recovery_cost_atoms_by_asset, FeeCap::key, false)?;
        require_canonical(&input.permitted_spot_adapters, AdapterRef::key, true)?;
        require_canonical(&input.permitted_perp_adapters, AdapterRef::key, true)?;
        require_u32_len(input.allowed_recovery_actions.len())?;
        Ok(Self(input))
    }

    pub fn canonical_bytes(&self) -> Result<Vec<u8>> {
        let value = &self.0;
        let mut out = Vec::new();
        out.extend_from_slice(&value.version.to_be_bytes());
        out.extend_from_slice(&value.environment.canonical_bytes());
        out.extend_from_slice(&value.domain.canonical_bytes());
        out.extend_from_slice(&value.template_id.canonical_bytes());
        out.extend_from_slice(&value.template_version.to_be_bytes());
        out.extend_from_slice(&value.package_template_manifest_hash.0);
        out.extend_from_slice(&value.owner.canonical_bytes());
        out.extend_from_slice(&value.settlement_account.canonical_bytes());
        out.extend_from_slice(&value.nonce.0);
        out.push(value.expiry_unit.discriminant());
        out.extend_from_slice(&value.expiry_value.to_be_bytes());
        out.push(value.direction.discriminant());
        out.push(value.action.discriminant());
        out.push(value.package_order_type.discriminant());
        out.push(value.package_time_in_force.discriminant());
        out.push(value.partial_fill_policy.discriminant());
        encode_optional(
            &mut out,
            &value.activation_condition_hash,
            |target, item| target.extend_from_slice(&item.0),
        );
        encode_optional(&mut out, &value.execution_schedule_hash, |target, item| {
            target.extend_from_slice(&item.0)
        });
        value.quantity.encode(&mut out);
        encode_optional(
            &mut out,
            &value.hyperliquid_quantity_policy,
            |target, item| target.push(item.discriminant()),
        );
        encode_optional_amount(&mut out, &value.hyperliquid_gross_spot_quantity);
        encode_optional_amount(&mut out, &value.hyperliquid_min_net_spot_delta);
        encode_optional_amount(&mut out, &value.hyperliquid_max_net_spot_delta);
        encode_optional_amount(
            &mut out,
            &value.hyperliquid_max_terminal_residual_base_quantity,
        );
        encode_optional(
            &mut out,
            &value.hyperliquid_residual_valuation_schema_version,
            |target, item| target.extend_from_slice(&item.to_be_bytes()),
        );
        encode_optional_price(
            &mut out,
            &value.hyperliquid_residual_valuation_reference_price,
        );
        encode_optional_amount(
            &mut out,
            &value.hyperliquid_max_terminal_residual_quote_value,
        );
        encode_optional_amount(&mut out, &value.expected_pre_strategy_spot_quantity);
        encode_optional(
            &mut out,
            &value.hyperliquid_recovery_expiry_unit,
            |target, item| target.push(item.discriminant()),
        );
        encode_optional(
            &mut out,
            &value.hyperliquid_max_recovery_action_expiry_value,
            |target, item| target.extend_from_slice(&item.to_be_bytes()),
        );
        encode_optional(
            &mut out,
            &value.hyperliquid_recovery_deadline_value,
            |target, item| target.extend_from_slice(&item.to_be_bytes()),
        );
        encode_optional(
            &mut out,
            &value.hyperliquid_min_recovery_window_ms,
            |target, item| target.extend_from_slice(&item.to_be_bytes()),
        );
        out.extend_from_slice(&value.exit_outcome_schema_version.to_be_bytes());
        encode_optional(&mut out, &value.entry_receipt_hash, |target, item| {
            target.extend_from_slice(&item.0)
        });
        value.expected_pre_position_size.encode(&mut out);
        value.expected_pre_position_entry_notional.encode(&mut out);
        encode_optional(&mut out, &value.max_entry_spread, |target, item| {
            item.encode(target)
        });
        encode_optional_amount(&mut out, &value.min_exit_quote_outcome);
        encode_optional_amount(&mut out, &value.max_spot_quote_in);
        encode_optional_amount(&mut out, &value.min_spot_quote_out);
        encode_optional_price(&mut out, &value.hyperliquid_min_perp_sell_price);
        encode_optional_price(&mut out, &value.hyperliquid_max_perp_buy_price);
        value.max_margin_added.encode(&mut out);
        value.min_venue_reserve_returned.encode(&mut out);
        value.min_wallet_quote_balance_delta.encode(&mut out);
        encode_array(
            &mut out,
            &value.max_venue_fee_atoms_by_asset,
            FeeCap::encode,
        )?;
        value.max_protocol_fee.encode(&mut out);
        value.max_solver_fee.encode(&mut out);
        value.max_priority_fee.encode(&mut out);
        encode_array(
            &mut out,
            &value.max_recovery_cost_atoms_by_asset,
            FeeCap::encode,
        )?;
        encode_array(&mut out, &value.permitted_spot_adapters, AdapterRef::encode)?;
        encode_array(&mut out, &value.permitted_perp_adapters, AdapterRef::encode)?;
        out.push(value.settlement_class.discriminant());
        encode_optional_price(&mut out, &value.max_recovery_spot_buy_price);
        encode_optional_price(&mut out, &value.min_recovery_spot_sell_price);
        encode_optional_price(&mut out, &value.min_recovery_perp_sell_price);
        encode_optional_price(&mut out, &value.max_recovery_perp_buy_price);
        value.max_aggregate_recovery_loss_quote.encode(&mut out);
        value.max_residual_base_quantity.encode(&mut out);
        encode_array(&mut out, &value.allowed_recovery_actions, |item, target| {
            target.push(item.discriminant())
        })?;
        Ok(out)
    }

    pub fn hash(&self) -> Result<[u8; HASH_BYTE_LENGTH]> {
        Ok(hashv(&[ORDER_HASH_DOMAIN, &self.canonical_bytes()?]).to_bytes())
    }
}

fn gcd(mut left: u128, mut right: u128) -> u128 {
    while right != 0 {
        let remainder = left % right;
        left = right;
        right = remainder;
    }
    left
}

fn require_u32_len(length: usize) -> Result<u32> {
    u32::try_from(length).map_err(|_| error!(ErrorCode::WireCollectionTooLong))
}

fn require_canonical<T>(items: &[T], key: fn(&T) -> Vec<u8>, nonempty: bool) -> Result<()> {
    if nonempty {
        require!(!items.is_empty(), ErrorCode::WireCollectionEmpty);
    }
    require_u32_len(items.len())?;
    for pair in items.windows(2) {
        match key(&pair[0]).cmp(&key(&pair[1])) {
            core::cmp::Ordering::Less => {}
            core::cmp::Ordering::Equal => return err!(ErrorCode::WireCollectionDuplicate),
            core::cmp::Ordering::Greater => return err!(ErrorCode::WireCollectionNotCanonical),
        }
    }
    Ok(())
}

fn encode_optional<T>(out: &mut Vec<u8>, value: &Option<T>, encode: impl FnOnce(&mut Vec<u8>, &T)) {
    match value {
        None => out.push(0),
        Some(item) => {
            out.push(1);
            encode(out, item);
        }
    }
}

fn encode_optional_amount(out: &mut Vec<u8>, value: &Option<AssetAmount>) {
    encode_optional(out, value, |target, item| item.encode(target));
}

fn encode_optional_price(out: &mut Vec<u8>, value: &Option<ExactPrice>) {
    encode_optional(out, value, |target, item| item.encode(target));
}

fn encode_array<T>(
    out: &mut Vec<u8>,
    items: &[T],
    encode: impl Fn(&T, &mut Vec<u8>),
) -> Result<()> {
    out.extend_from_slice(&require_u32_len(items.len())?.to_be_bytes());
    for item in items {
        encode(item, out);
    }
    Ok(())
}

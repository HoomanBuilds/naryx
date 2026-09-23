use anchor_lang::prelude::*;
use solana_sha256_hasher::hashv;

use super::{
    AdapterRef, AssetAmount, AssetRef, CommitmentHash, Direction, DomainRef, ExactPrice,
    ExpiryUnit, FeeCap, ManifestHash, PackageAction, PackageTimeInForce, PartialFillPolicy,
    ProtocolId, QuantityPolicyClass, RecoveryAction, SettlementClass, HASH_BYTE_LENGTH, U256,
};
use crate::error::ErrorCode;

const ROUTE_VERSION: u32 = 1;
const ROUTE_HASH_DOMAIN: &[u8] = b"CON/v1/route";
const ROUTE_ACCOUNTS_HASH_DOMAIN: &[u8] = b"CON/v1/route-accounts";

macro_rules! route_wire_enum {
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

route_wire_enum!(ExecutionPlanKind {
    SvmAtomicCpi = 1,
    EvmAtomicBatch = 2,
    HypercoreBatchedIoc = 3,
});
route_wire_enum!(LegRole { Spot = 1, Perpetual = 2 });
route_wire_enum!(TradeSide { Buy = 1, Sell = 2 });
route_wire_enum!(LateBoundFieldKind {
    RouteHash = 1,
    QuoteHash = 2,
    SolverSignature = 3,
    OwnerAuthorization = 4,
});
route_wire_enum!(Comparator { Eq = 1, Lte = 2, Gte = 3 });
route_wire_enum!(FeeCategory { Protocol = 1, Solver = 2, Builder = 3 });
route_wire_enum!(StateValueKind {
    SignedAssetAmount = 1,
    UnsignedU256 = 2,
    CommitmentHash = 3,
    ProtocolId = 4,
    Boolean = 5,
});

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VersionedManifestRef {
    subject_id: ProtocolId,
    manifest_version: u32,
    manifest_hash: ManifestHash,
}

impl VersionedManifestRef {
    pub fn new(
        subject_id: &str,
        manifest_version: u32,
        manifest_hash: [u8; HASH_BYTE_LENGTH],
    ) -> Result<Self> {
        require!(manifest_version != 0, ErrorCode::WireVersionZero);
        Ok(Self {
            subject_id: ProtocolId::new(subject_id)?,
            manifest_version,
            manifest_hash: ManifestHash::new(manifest_hash)?,
        })
    }

    fn encode(&self, out: &mut Vec<u8>) {
        out.extend_from_slice(&self.subject_id.canonical_bytes());
        out.extend_from_slice(&self.manifest_version.to_be_bytes());
        out.extend_from_slice(&self.manifest_hash.bytes());
    }

    fn key(&self) -> Vec<u8> {
        let mut out = Vec::new();
        self.encode(&mut out);
        out
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PositiveAssetAmount {
    pub asset: AssetRef,
    pub atoms: u128,
}

impl PositiveAssetAmount {
    pub fn new(asset: AssetRef, atoms: u128) -> Result<Self> {
        require!(atoms != 0, ErrorCode::WirePositiveValueZero);
        Ok(Self { asset, atoms })
    }

    fn encode(&self, out: &mut Vec<u8>) {
        self.asset.encode(out);
        out.extend_from_slice(&self.atoms.to_be_bytes());
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UnsignedAssetAmount {
    pub asset: AssetRef,
    pub atoms: u128,
}

impl UnsignedAssetAmount {
    pub fn new(asset: AssetRef, atoms: u128) -> Self {
        Self { asset, atoms }
    }

    fn encode(&self, out: &mut Vec<u8>) {
        self.asset.encode(out);
        out.extend_from_slice(&self.atoms.to_be_bytes());
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeAssetValue {
    pub asset: AssetRef,
    pub atoms: U256,
}

impl NativeAssetValue {
    fn encode(&self, out: &mut Vec<u8>) {
        self.asset.encode(out);
        out.extend_from_slice(&self.atoms.to_be_bytes());
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RouteAccountBinding {
    pub route_binding_id: ProtocolId,
    pub adapter: Option<AdapterRef>,
    pub adapter_binding_id: Option<ProtocolId>,
    pub account_identity: ProtocolId,
    pub owner_identity: Option<ProtocolId>,
    pub authority_identity: Option<ProtocolId>,
    pub code_identity: Option<ProtocolId>,
}

impl RouteAccountBinding {
    pub fn new(
        route_binding_id: &str,
        adapter: Option<AdapterRef>,
        adapter_binding_id: Option<&str>,
        account_identity: &str,
        owner_identity: Option<&str>,
        authority_identity: Option<&str>,
        code_identity: Option<&str>,
    ) -> Result<Self> {
        require!(
            adapter.is_some() == adapter_binding_id.is_some(),
            ErrorCode::WireOptionalShape
        );
        Ok(Self {
            route_binding_id: ProtocolId::new(route_binding_id)?,
            adapter,
            adapter_binding_id: adapter_binding_id.map(ProtocolId::new).transpose()?,
            account_identity: ProtocolId::new(account_identity)?,
            owner_identity: owner_identity.map(ProtocolId::new).transpose()?,
            authority_identity: authority_identity.map(ProtocolId::new).transpose()?,
            code_identity: code_identity.map(ProtocolId::new).transpose()?,
        })
    }

    fn key(&self) -> Vec<u8> {
        self.route_binding_id.canonical_bytes()
    }

    fn validate(&self) -> Result<()> {
        require!(
            self.adapter.is_some() == self.adapter_binding_id.is_some(),
            ErrorCode::WireOptionalShape
        );
        Ok(())
    }

    fn encode(&self, out: &mut Vec<u8>) {
        out.extend_from_slice(&self.route_binding_id.canonical_bytes());
        encode_optional(out, &self.adapter, AdapterRef::encode);
        encode_optional(out, &self.adapter_binding_id, |id, target| {
            target.extend_from_slice(&id.canonical_bytes())
        });
        out.extend_from_slice(&self.account_identity.canonical_bytes());
        encode_optional(out, &self.owner_identity, |id, target| {
            target.extend_from_slice(&id.canonical_bytes())
        });
        encode_optional(out, &self.authority_identity, |id, target| {
            target.extend_from_slice(&id.canonical_bytes())
        });
        encode_optional(out, &self.code_identity, |id, target| {
            target.extend_from_slice(&id.canonical_bytes())
        });
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RouteServiceCharge {
    pub fee_category: FeeCategory,
    pub asset: AssetRef,
    pub atoms: i128,
    pub recipient_identity: ProtocolId,
    pub collection_authority: ProtocolId,
    pub collection_mode_id: ProtocolId,
    pub collection_action_sequence: Option<u32>,
}

impl RouteServiceCharge {
    pub fn new(
        fee_category: FeeCategory,
        asset: AssetRef,
        atoms: i128,
        recipient_identity: &str,
        collection_authority: &str,
        collection_mode_id: &str,
        collection_action_sequence: Option<u32>,
    ) -> Result<Self> {
        require!(atoms != 0, ErrorCode::WirePositiveValueZero);
        Ok(Self {
            fee_category,
            asset,
            atoms,
            recipient_identity: ProtocolId::new(recipient_identity)?,
            collection_authority: ProtocolId::new(collection_authority)?,
            collection_mode_id: ProtocolId::new(collection_mode_id)?,
            collection_action_sequence,
        })
    }

    fn key(&self) -> Vec<u8> {
        let mut out = vec![self.fee_category.discriminant()];
        self.asset.encode(&mut out);
        out
    }

    fn validate(&self) -> Result<()> {
        require!(self.atoms != 0, ErrorCode::WirePositiveValueZero);
        Ok(())
    }

    fn encode(&self, out: &mut Vec<u8>) {
        out.push(self.fee_category.discriminant());
        self.asset.encode(out);
        out.extend_from_slice(&self.atoms.to_be_bytes());
        out.extend_from_slice(&self.recipient_identity.canonical_bytes());
        out.extend_from_slice(&self.collection_authority.canonical_bytes());
        out.extend_from_slice(&self.collection_mode_id.canonical_bytes());
        encode_optional(out, &self.collection_action_sequence, |sequence, target| {
            target.extend_from_slice(&sequence.to_be_bytes())
        });
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LegExecution {
    pub leg_index: u8,
    pub leg_role: LegRole,
    pub action_sequence: u32,
    pub adapter: AdapterRef,
    pub venue: VersionedManifestRef,
    pub market: VersionedManifestRef,
    pub base_asset: AssetRef,
    pub quote_asset: AssetRef,
    pub side: TradeSide,
    pub quantity: PositiveAssetAmount,
    pub limit_price: ExactPrice,
    pub time_in_force: PackageTimeInForce,
    pub reduce_only: bool,
}

impl LegExecution {
    pub fn validate(&self) -> Result<()> {
        require!(self.quantity.atoms != 0, ErrorCode::WirePositiveValueZero);
        require!(
            self.quantity.asset == self.base_asset,
            ErrorCode::WireAssetMismatch
        );
        require!(
            self.limit_price.base_asset() == &self.base_asset
                && self.limit_price.quote_asset() == &self.quote_asset,
            ErrorCode::WireAssetMismatch
        );
        Ok(())
    }

    fn encode(&self, out: &mut Vec<u8>) {
        out.push(self.leg_index);
        out.push(self.leg_role.discriminant());
        out.extend_from_slice(&self.action_sequence.to_be_bytes());
        self.adapter.encode(out);
        self.venue.encode(out);
        self.market.encode(out);
        self.base_asset.encode(out);
        self.quote_asset.encode(out);
        out.push(self.side.discriminant());
        self.quantity.encode(out);
        self.limit_price.encode(out);
        out.push(self.time_in_force.discriminant());
        out.push(u8::from(self.reduce_only));
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ActionAccountMeta {
    pub route_binding_id: ProtocolId,
    pub is_signer: bool,
    pub is_writable: bool,
}

impl ActionAccountMeta {
    pub fn new(route_binding_id: &str, is_signer: bool, is_writable: bool) -> Result<Self> {
        Ok(Self {
            route_binding_id: ProtocolId::new(route_binding_id)?,
            is_signer,
            is_writable,
        })
    }

    fn encode(&self, out: &mut Vec<u8>) {
        out.extend_from_slice(&self.route_binding_id.canonical_bytes());
        out.push(u8::from(self.is_signer));
        out.push(u8::from(self.is_writable));
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LateBoundField {
    pub kind: LateBoundFieldKind,
    pub offset: u32,
    pub length: u32,
}

impl LateBoundField {
    pub fn new(kind: LateBoundFieldKind, offset: u32, length: u32) -> Result<Self> {
        require!(length != 0, ErrorCode::WirePositiveValueZero);
        Ok(Self {
            kind,
            offset,
            length,
        })
    }

    fn encode(&self, out: &mut Vec<u8>) {
        out.push(self.kind.discriminant());
        out.extend_from_slice(&self.offset.to_be_bytes());
        out.extend_from_slice(&self.length.to_be_bytes());
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PayloadTemplateCommitment {
    pub codec_id: ProtocolId,
    pub template_length: u32,
    pub template_hash: CommitmentHash,
    pub late_bound_fields: Vec<LateBoundField>,
}

impl PayloadTemplateCommitment {
    pub fn new(
        codec_id: &str,
        template_length: u32,
        template_hash: [u8; HASH_BYTE_LENGTH],
        mut late_bound_fields: Vec<LateBoundField>,
    ) -> Result<Self> {
        late_bound_fields.sort_by_key(|field| field.offset);
        validate_late_bound_fields(&late_bound_fields, template_length)?;
        Ok(Self {
            codec_id: ProtocolId::new(codec_id)?,
            template_length,
            template_hash: CommitmentHash::new(template_hash)?,
            late_bound_fields,
        })
    }

    fn encode(&self, out: &mut Vec<u8>) -> Result<()> {
        out.extend_from_slice(&self.codec_id.canonical_bytes());
        out.extend_from_slice(&self.template_length.to_be_bytes());
        out.extend_from_slice(&self.template_hash.bytes());
        encode_array(out, &self.late_bound_fields, LateBoundField::encode)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ActionCommitment {
    pub sequence: u32,
    pub action_class_id: ProtocolId,
    pub leg_index: Option<u8>,
    pub adapter: Option<AdapterRef>,
    pub target_binding_id: ProtocolId,
    pub authority_binding_id: ProtocolId,
    pub account_metas: Vec<ActionAccountMeta>,
    pub native_value: Option<NativeAssetValue>,
    pub payload: PayloadTemplateCommitment,
    pub fee_recipient_binding_id: Option<ProtocolId>,
}

impl ActionCommitment {
    pub fn validate(&mut self) -> Result<()> {
        require_u32_len(self.account_metas.len())?;
        for (index, meta) in self.account_metas.iter().enumerate() {
            if self.account_metas[..index]
                .iter()
                .any(|prior| prior.route_binding_id == meta.route_binding_id)
            {
                return err!(ErrorCode::WireCollectionDuplicate);
            }
        }
        self.payload
            .late_bound_fields
            .sort_by_key(|field| field.offset);
        validate_late_bound_fields(
            &self.payload.late_bound_fields,
            self.payload.template_length,
        )
    }

    fn encode(&self, out: &mut Vec<u8>) -> Result<()> {
        out.extend_from_slice(&self.sequence.to_be_bytes());
        out.extend_from_slice(&self.action_class_id.canonical_bytes());
        encode_optional(out, &self.leg_index, |index, target| target.push(*index));
        encode_optional(out, &self.adapter, AdapterRef::encode);
        out.extend_from_slice(&self.target_binding_id.canonical_bytes());
        out.extend_from_slice(&self.authority_binding_id.canonical_bytes());
        encode_array(out, &self.account_metas, ActionAccountMeta::encode)?;
        encode_optional(out, &self.native_value, NativeAssetValue::encode);
        self.payload.encode(out)?;
        encode_optional(out, &self.fee_recipient_binding_id, |id, target| {
            target.extend_from_slice(&id.canonical_bytes())
        });
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StateValue {
    SignedAssetAmount(AssetAmount),
    UnsignedU256(U256),
    CommitmentHash(CommitmentHash),
    ProtocolId(ProtocolId),
    Boolean(bool),
}

impl StateValue {
    fn encode(&self, out: &mut Vec<u8>) {
        match self {
            Self::SignedAssetAmount(value) => {
                out.push(StateValueKind::SignedAssetAmount.discriminant());
                value.encode(out);
            }
            Self::UnsignedU256(value) => {
                out.push(StateValueKind::UnsignedU256.discriminant());
                out.extend_from_slice(&value.to_be_bytes());
            }
            Self::CommitmentHash(value) => {
                out.push(StateValueKind::CommitmentHash.discriminant());
                out.extend_from_slice(&value.bytes());
            }
            Self::ProtocolId(value) => {
                out.push(StateValueKind::ProtocolId.discriminant());
                out.extend_from_slice(&value.canonical_bytes());
            }
            Self::Boolean(value) => {
                out.push(StateValueKind::Boolean.discriminant());
                out.push(u8::from(*value));
            }
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StateConstraint {
    pub constraint_id: ProtocolId,
    pub rule_id: ProtocolId,
    pub account_binding_id: ProtocolId,
    pub component_id: ProtocolId,
    pub comparator: Comparator,
    pub value: StateValue,
    pub evidence_requirement_id: ProtocolId,
}

impl StateConstraint {
    fn key(&self) -> Vec<u8> {
        self.constraint_id.canonical_bytes()
    }

    fn encode(&self, out: &mut Vec<u8>) {
        out.extend_from_slice(&self.constraint_id.canonical_bytes());
        out.extend_from_slice(&self.rule_id.canonical_bytes());
        out.extend_from_slice(&self.account_binding_id.canonical_bytes());
        out.extend_from_slice(&self.component_id.canonical_bytes());
        out.push(self.comparator.discriminant());
        self.value.encode(out);
        out.extend_from_slice(&self.evidence_requirement_id.canonical_bytes());
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EvidenceRequirements {
    pub schema_version: u32,
    pub profile_id: ProtocolId,
    pub required_pre_state_component_ids: Vec<ProtocolId>,
    pub required_post_state_component_ids: Vec<ProtocolId>,
    pub required_action_evidence_type_ids: Vec<ProtocolId>,
    pub state_reference_schema_hash: ManifestHash,
    pub receipt_schema_hash: ManifestHash,
    pub outcome_schema_hash: ManifestHash,
}

impl EvidenceRequirements {
    pub fn new(
        schema_version: u32,
        profile_id: &str,
        mut required_pre_state_component_ids: Vec<ProtocolId>,
        mut required_post_state_component_ids: Vec<ProtocolId>,
        mut required_action_evidence_type_ids: Vec<ProtocolId>,
        state_reference_schema_hash: [u8; HASH_BYTE_LENGTH],
        receipt_schema_hash: [u8; HASH_BYTE_LENGTH],
        outcome_schema_hash: [u8; HASH_BYTE_LENGTH],
    ) -> Result<Self> {
        require!(schema_version != 0, ErrorCode::WireVersionZero);
        canonicalize(
            &mut required_pre_state_component_ids,
            |id| id.canonical_bytes(),
            true,
        )?;
        canonicalize(
            &mut required_post_state_component_ids,
            |id| id.canonical_bytes(),
            true,
        )?;
        canonicalize(
            &mut required_action_evidence_type_ids,
            |id| id.canonical_bytes(),
            true,
        )?;
        Ok(Self {
            schema_version,
            profile_id: ProtocolId::new(profile_id)?,
            required_pre_state_component_ids,
            required_post_state_component_ids,
            required_action_evidence_type_ids,
            state_reference_schema_hash: ManifestHash::new(state_reference_schema_hash)?,
            receipt_schema_hash: ManifestHash::new(receipt_schema_hash)?,
            outcome_schema_hash: ManifestHash::new(outcome_schema_hash)?,
        })
    }

    fn encode(&self, out: &mut Vec<u8>) -> Result<()> {
        out.extend_from_slice(&self.schema_version.to_be_bytes());
        out.extend_from_slice(&self.profile_id.canonical_bytes());
        encode_array(out, &self.required_pre_state_component_ids, |id, target| {
            target.extend_from_slice(&id.canonical_bytes())
        })?;
        encode_array(
            out,
            &self.required_post_state_component_ids,
            |id, target| target.extend_from_slice(&id.canonical_bytes()),
        )?;
        encode_array(
            out,
            &self.required_action_evidence_type_ids,
            |id, target| target.extend_from_slice(&id.canonical_bytes()),
        )?;
        out.extend_from_slice(&self.state_reference_schema_hash.bytes());
        out.extend_from_slice(&self.receipt_schema_hash.bytes());
        out.extend_from_slice(&self.outcome_schema_hash.bytes());
        Ok(())
    }

    fn validate(&mut self) -> Result<()> {
        require!(self.schema_version != 0, ErrorCode::WireVersionZero);
        canonicalize(
            &mut self.required_pre_state_component_ids,
            |id| id.canonical_bytes(),
            true,
        )?;
        canonicalize(
            &mut self.required_post_state_component_ids,
            |id| id.canonical_bytes(),
            true,
        )?;
        canonicalize(
            &mut self.required_action_evidence_type_ids,
            |id| id.canonical_bytes(),
            true,
        )
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RecoveryActionSlot {
    pub sequence: u32,
    pub action: RecoveryAction,
    pub target_leg: u8,
    pub adapter: AdapterRef,
    pub markets: Vec<VersionedManifestRef>,
    pub max_quantity: Option<PositiveAssetAmount>,
    pub limit_price: Option<ExactPrice>,
    pub reduce_only: Option<bool>,
    pub time_in_force: Option<PackageTimeInForce>,
}

impl RecoveryActionSlot {
    fn validate(&mut self) -> Result<()> {
        canonicalize(&mut self.markets, VersionedManifestRef::key, true)?;
        let cancel = self.action == RecoveryAction::CancelOpenOrders;
        let trade_fields = self.max_quantity.is_some()
            && self.limit_price.is_some()
            && self.reduce_only.is_some()
            && self.time_in_force.is_some();
        if cancel {
            require!(
                self.max_quantity.is_none()
                    && self.limit_price.is_none()
                    && self.reduce_only.is_none()
                    && self.time_in_force.is_none(),
                ErrorCode::WireRecoveryShape
            );
        } else {
            require!(trade_fields, ErrorCode::WireRecoveryShape);
            require!(
                self.max_quantity
                    .as_ref()
                    .is_some_and(|quantity| quantity.atoms != 0),
                ErrorCode::WirePositiveValueZero
            );
            require!(
                self.time_in_force == Some(PackageTimeInForce::Ioc),
                ErrorCode::WireRecoveryShape
            );
        }
        Ok(())
    }

    fn encode(&self, out: &mut Vec<u8>) -> Result<()> {
        out.extend_from_slice(&self.sequence.to_be_bytes());
        out.push(self.action.discriminant());
        out.push(self.target_leg);
        self.adapter.encode(out);
        encode_array(out, &self.markets, VersionedManifestRef::encode)?;
        encode_optional(out, &self.max_quantity, PositiveAssetAmount::encode);
        encode_optional(out, &self.limit_price, ExactPrice::encode);
        encode_optional(out, &self.reduce_only, |value, target| {
            target.push(u8::from(*value))
        });
        encode_optional(out, &self.time_in_force, |value, target| {
            target.push(value.discriminant())
        });
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RecoveryPlan {
    pub policy_version: u32,
    pub controller_id: ProtocolId,
    pub controller_code_hash: ManifestHash,
    pub authority_mode_id: ProtocolId,
    pub recovery_expiry_unit: ExpiryUnit,
    pub max_action_expiry_value: u64,
    pub deadline_value: u64,
    pub min_recovery_window_ms: u64,
    pub max_recovery_cost_caps: Vec<FeeCap>,
    pub max_aggregate_recovery_loss: UnsignedAssetAmount,
    pub max_intermediate_residual: UnsignedAssetAmount,
    pub max_terminal_residual: UnsignedAssetAmount,
    pub reconciled_state_schema_hash: ManifestHash,
    pub action_builder_code_hash: ManifestHash,
    pub action_slots: Vec<RecoveryActionSlot>,
}

impl RecoveryPlan {
    fn validate(&mut self) -> Result<()> {
        require!(self.policy_version != 0, ErrorCode::WireVersionZero);
        require!(
            self.min_recovery_window_ms != 0,
            ErrorCode::WireRecoveryWindowZero
        );
        require!(
            self.max_action_expiry_value < self.deadline_value
                && self.deadline_value - self.max_action_expiry_value
                    >= self.min_recovery_window_ms,
            ErrorCode::WireRecoveryTimingInvalid
        );
        canonicalize(&mut self.max_recovery_cost_caps, FeeCap::key, true)?;
        require!(
            self.max_recovery_cost_caps
                .iter()
                .all(|cap| cap.max_atoms() >= 0),
            ErrorCode::WireRecoveryShape
        );
        require!(
            !self.action_slots.is_empty(),
            ErrorCode::WireCollectionEmpty
        );
        require_u32_len(self.action_slots.len())?;
        for (index, slot) in self.action_slots.iter_mut().enumerate() {
            require!(
                slot.sequence as usize == index,
                ErrorCode::WireSequenceInvalid
            );
            slot.validate()?;
        }
        Ok(())
    }

    fn encode(&self, out: &mut Vec<u8>) -> Result<()> {
        out.extend_from_slice(&self.policy_version.to_be_bytes());
        out.extend_from_slice(&self.controller_id.canonical_bytes());
        out.extend_from_slice(&self.controller_code_hash.bytes());
        out.extend_from_slice(&self.authority_mode_id.canonical_bytes());
        out.push(self.recovery_expiry_unit.discriminant());
        out.extend_from_slice(&self.max_action_expiry_value.to_be_bytes());
        out.extend_from_slice(&self.deadline_value.to_be_bytes());
        out.extend_from_slice(&self.min_recovery_window_ms.to_be_bytes());
        encode_array(out, &self.max_recovery_cost_caps, FeeCap::encode)?;
        self.max_aggregate_recovery_loss.encode(out);
        self.max_intermediate_residual.encode(out);
        self.max_terminal_residual.encode(out);
        out.extend_from_slice(&self.reconciled_state_schema_hash.bytes());
        out.extend_from_slice(&self.action_builder_code_hash.bytes());
        out.extend_from_slice(&require_u32_len(self.action_slots.len())?.to_be_bytes());
        for slot in &self.action_slots {
            slot.encode(out)?;
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RoutePayloadInput {
    pub version: u32,
    pub environment: ProtocolId,
    pub domain: DomainRef,
    pub order_hash: CommitmentHash,
    pub template_id: ProtocolId,
    pub template_version: u32,
    pub package_template_manifest_hash: ManifestHash,
    pub template_registry_record_hash: CommitmentHash,
    pub owner: ProtocolId,
    pub settlement_account: ProtocolId,
    pub solver: ProtocolId,
    pub direction: Direction,
    pub action: PackageAction,
    pub quantity_policy_class: QuantityPolicyClass,
    pub partial_fill_policy: PartialFillPolicy,
    pub settlement_class: SettlementClass,
    pub execution_plan_kind: ExecutionPlanKind,
    pub route_expiry_unit: ExpiryUnit,
    pub route_expiry_value: u64,
    pub fee_policy_version: u32,
    pub fee_policy_manifest_hash: ManifestHash,
    pub account_bindings: Vec<RouteAccountBinding>,
    pub service_charges: Vec<RouteServiceCharge>,
    pub preconditions: Vec<StateConstraint>,
    pub legs: Vec<LegExecution>,
    pub actions: Vec<ActionCommitment>,
    pub postconditions: Vec<StateConstraint>,
    pub evidence_requirements: EvidenceRequirements,
    pub recovery_plan: Option<RecoveryPlan>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RoutePayload(RoutePayloadInput);

impl RoutePayload {
    pub fn new(mut input: RoutePayloadInput) -> Result<Self> {
        require!(
            input.version == ROUTE_VERSION,
            ErrorCode::WireVersionUnsupported
        );
        require!(input.template_version != 0, ErrorCode::WireVersionZero);
        require!(input.fee_policy_version != 0, ErrorCode::WireVersionZero);
        validate_plan_shape(&input)?;
        for binding in &input.account_bindings {
            binding.validate()?;
        }
        for charge in &input.service_charges {
            charge.validate()?;
        }
        canonicalize(&mut input.account_bindings, RouteAccountBinding::key, true)?;
        canonicalize(&mut input.service_charges, RouteServiceCharge::key, false)?;
        canonicalize(&mut input.preconditions, StateConstraint::key, false)?;
        canonicalize(&mut input.postconditions, StateConstraint::key, false)?;
        validate_legs(&input.legs)?;
        validate_actions(&mut input.actions)?;
        input.evidence_requirements.validate()?;
        if input.execution_plan_kind == ExecutionPlanKind::HypercoreBatchedIoc {
            require!(
                input
                    .legs
                    .iter()
                    .all(|leg| leg.time_in_force == PackageTimeInForce::Ioc),
                ErrorCode::WireRoutePlanShape
            );
        }
        if let Some(recovery) = input.recovery_plan.as_mut() {
            recovery.validate()?;
        }
        validate_references(&input)?;
        Ok(Self(input))
    }

    pub fn canonical_bytes(&self) -> Result<Vec<u8>> {
        let value = &self.0;
        let mut out = Vec::new();
        out.extend_from_slice(&value.version.to_be_bytes());
        out.extend_from_slice(&value.environment.canonical_bytes());
        out.extend_from_slice(&value.domain.canonical_bytes());
        out.extend_from_slice(&value.order_hash.bytes());
        out.extend_from_slice(&value.template_id.canonical_bytes());
        out.extend_from_slice(&value.template_version.to_be_bytes());
        out.extend_from_slice(&value.package_template_manifest_hash.bytes());
        out.extend_from_slice(&value.template_registry_record_hash.bytes());
        out.extend_from_slice(&value.owner.canonical_bytes());
        out.extend_from_slice(&value.settlement_account.canonical_bytes());
        out.extend_from_slice(&value.solver.canonical_bytes());
        out.push(value.direction.discriminant());
        out.push(value.action.discriminant());
        out.push(value.quantity_policy_class.discriminant());
        out.push(value.partial_fill_policy.discriminant());
        out.push(value.settlement_class.discriminant());
        out.push(value.execution_plan_kind.discriminant());
        out.push(value.route_expiry_unit.discriminant());
        out.extend_from_slice(&value.route_expiry_value.to_be_bytes());
        out.extend_from_slice(&value.fee_policy_version.to_be_bytes());
        out.extend_from_slice(&value.fee_policy_manifest_hash.bytes());
        encode_array(
            &mut out,
            &value.account_bindings,
            RouteAccountBinding::encode,
        )?;
        encode_array(&mut out, &value.service_charges, RouteServiceCharge::encode)?;
        encode_array(&mut out, &value.preconditions, StateConstraint::encode)?;
        encode_array(&mut out, &value.legs, LegExecution::encode)?;
        out.extend_from_slice(&require_u32_len(value.actions.len())?.to_be_bytes());
        for action in &value.actions {
            action.encode(&mut out)?;
        }
        encode_array(&mut out, &value.postconditions, StateConstraint::encode)?;
        value.evidence_requirements.encode(&mut out)?;
        match &value.recovery_plan {
            None => out.push(0),
            Some(recovery) => {
                out.push(1);
                recovery.encode(&mut out)?;
            }
        }
        Ok(out)
    }

    pub fn hash(&self) -> Result<[u8; HASH_BYTE_LENGTH]> {
        Ok(hashv(&[ROUTE_HASH_DOMAIN, &self.canonical_bytes()?]).to_bytes())
    }

    pub fn accounts_hash(&self) -> Result<[u8; HASH_BYTE_LENGTH]> {
        let mut payload = Vec::new();
        encode_array(
            &mut payload,
            &self.0.account_bindings,
            RouteAccountBinding::encode,
        )?;
        Ok(hashv(&[ROUTE_ACCOUNTS_HASH_DOMAIN, &payload]).to_bytes())
    }
}

pub fn payload_template_hash(
    payload: &[u8],
    late_bound_fields: &[LateBoundField],
) -> Result<[u8; HASH_BYTE_LENGTH]> {
    let template_length =
        u32::try_from(payload.len()).map_err(|_| error!(ErrorCode::WireCollectionTooLong))?;
    let mut fields = late_bound_fields.to_vec();
    fields.sort_by_key(|field| field.offset);
    validate_late_bound_fields(&fields, template_length)?;
    let mut template = payload.to_vec();
    for field in fields {
        let start = field.offset as usize;
        let end = start + field.length as usize;
        template[start..end].fill(0);
    }
    Ok(hashv(&[&template]).to_bytes())
}

fn validate_plan_shape(input: &RoutePayloadInput) -> Result<()> {
    let expected_clock = match input.execution_plan_kind {
        ExecutionPlanKind::SvmAtomicCpi => ExpiryUnit::SolanaSlot,
        ExecutionPlanKind::EvmAtomicBatch => ExpiryUnit::EvmUnixSeconds,
        ExecutionPlanKind::HypercoreBatchedIoc => ExpiryUnit::HyperliquidUnixMilliseconds,
    };
    require!(
        input.route_expiry_unit == expected_clock,
        ErrorCode::WireRouteClockMismatch
    );
    if input.execution_plan_kind != ExecutionPlanKind::HypercoreBatchedIoc {
        require!(
            input.settlement_class == SettlementClass::AtomicPostcondition
                && input.quantity_policy_class == QuantityPolicyClass::ExactAtomic
                && input.recovery_plan.is_none(),
            ErrorCode::WireRoutePlanShape
        );
    } else {
        require!(
            input.settlement_class == SettlementClass::BatchedIocWithRecovery
                && input.quantity_policy_class != QuantityPolicyClass::ExactAtomic
                && input.recovery_plan.is_some(),
            ErrorCode::WireRoutePlanShape
        );
    }
    Ok(())
}

fn validate_legs(legs: &[LegExecution]) -> Result<()> {
    require!(legs.len() == 2, ErrorCode::WireRouteLegShape);
    for (index, leg) in legs.iter().enumerate() {
        require!(
            leg.leg_index as usize == index,
            ErrorCode::WireSequenceInvalid
        );
        leg.validate()?;
    }
    require!(
        legs.iter()
            .filter(|leg| leg.leg_role == LegRole::Spot)
            .count()
            == 1
            && legs
                .iter()
                .filter(|leg| leg.leg_role == LegRole::Perpetual)
                .count()
                == 1,
        ErrorCode::WireRouteLegShape
    );
    Ok(())
}

fn validate_actions(actions: &mut [ActionCommitment]) -> Result<()> {
    require!(!actions.is_empty(), ErrorCode::WireCollectionEmpty);
    require_u32_len(actions.len())?;
    for (index, action) in actions.iter_mut().enumerate() {
        require!(
            action.sequence as usize == index,
            ErrorCode::WireSequenceInvalid
        );
        action.validate()?;
    }
    Ok(())
}

fn validate_references(input: &RoutePayloadInput) -> Result<()> {
    let has_binding = |id: &ProtocolId| {
        input
            .account_bindings
            .iter()
            .any(|binding| &binding.route_binding_id == id)
    };
    let mut used: Vec<ProtocolId> = Vec::new();
    let mut require_binding = |id: &ProtocolId| -> Result<()> {
        require!(has_binding(id), ErrorCode::WireRouteReferenceUnknown);
        if !used.contains(id) {
            used.push(id.clone());
        }
        Ok(())
    };
    for action in &input.actions {
        require_binding(&action.target_binding_id)?;
        require_binding(&action.authority_binding_id)?;
        if let Some(id) = &action.fee_recipient_binding_id {
            require_binding(id)?;
        }
        for meta in &action.account_metas {
            require_binding(&meta.route_binding_id)?;
        }
        if let Some(leg_index) = action.leg_index {
            require!(
                (leg_index as usize) < input.legs.len(),
                ErrorCode::WireRouteReferenceUnknown
            );
        }
    }
    for constraint in input.preconditions.iter().chain(&input.postconditions) {
        require_binding(&constraint.account_binding_id)?;
    }
    require!(
        input
            .account_bindings
            .iter()
            .all(|binding| used.contains(&binding.route_binding_id)),
        ErrorCode::WireRouteBindingUnused
    );
    require!(
        input
            .legs
            .iter()
            .all(|leg| (leg.action_sequence as usize) < input.actions.len()),
        ErrorCode::WireRouteReferenceUnknown
    );
    require!(
        input.service_charges.iter().all(|charge| charge
            .collection_action_sequence
            .map(|sequence| (sequence as usize) < input.actions.len())
            .unwrap_or(true)),
        ErrorCode::WireRouteReferenceUnknown
    );
    if let Some(recovery) = &input.recovery_plan {
        require!(
            recovery.recovery_expiry_unit == ExpiryUnit::HyperliquidUnixMilliseconds,
            ErrorCode::WireRouteClockMismatch
        );
        require!(
            input
                .route_expiry_value
                .checked_add(recovery.min_recovery_window_ms)
                .is_some_and(|end| end <= recovery.deadline_value),
            ErrorCode::WireRecoveryTimingInvalid
        );
        for slot in &recovery.action_slots {
            require!(
                (slot.target_leg as usize) < input.legs.len(),
                ErrorCode::WireRouteReferenceUnknown
            );
            let leg = &input.legs[slot.target_leg as usize];
            if let Some(quantity) = &slot.max_quantity {
                require!(
                    quantity.asset == leg.base_asset,
                    ErrorCode::WireAssetMismatch
                );
            }
            if let Some(price) = &slot.limit_price {
                require!(
                    price.base_asset() == &leg.base_asset
                        && price.quote_asset() == &leg.quote_asset,
                    ErrorCode::WireAssetMismatch
                );
            }
        }
    }
    Ok(())
}

fn validate_late_bound_fields(fields: &[LateBoundField], template_length: u32) -> Result<()> {
    let mut end = 0u32;
    for field in fields {
        require!(field.length != 0, ErrorCode::WirePositiveValueZero);
        require!(field.offset >= end, ErrorCode::WirePayloadRangeOverlap);
        let field_end = field
            .offset
            .checked_add(field.length)
            .ok_or_else(|| error!(ErrorCode::WirePayloadRangeInvalid))?;
        require!(
            field_end <= template_length,
            ErrorCode::WirePayloadRangeInvalid
        );
        end = field_end;
    }
    Ok(())
}

fn canonicalize<T>(items: &mut [T], key: fn(&T) -> Vec<u8>, nonempty: bool) -> Result<()> {
    if nonempty {
        require!(!items.is_empty(), ErrorCode::WireCollectionEmpty);
    }
    require_u32_len(items.len())?;
    items.sort_by_key(key);
    for pair in items.windows(2) {
        require!(
            key(&pair[0]) != key(&pair[1]),
            ErrorCode::WireCollectionDuplicate
        );
    }
    Ok(())
}

fn require_u32_len(length: usize) -> Result<u32> {
    u32::try_from(length).map_err(|_| error!(ErrorCode::WireCollectionTooLong))
}

fn encode_optional<T>(out: &mut Vec<u8>, value: &Option<T>, encode: impl Fn(&T, &mut Vec<u8>)) {
    match value {
        None => out.push(0),
        Some(item) => {
            out.push(1);
            encode(item, out);
        }
    }
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

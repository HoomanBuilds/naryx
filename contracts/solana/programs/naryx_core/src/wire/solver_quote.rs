use anchor_lang::prelude::*;
use solana_sha256_hasher::hashv;

use super::{
    AssetAmount, AssetRef, CommitmentHash, DomainRef, ExactSignedRate, ExpiryUnit, FeeCap,
    ManifestHash, ProtocolId, HASH_BYTE_LENGTH, U256,
};
use crate::error::ErrorCode;

const VERSION: u32 = 1;
const QUOTE_HASH_DOMAIN: &[u8] = b"CON/v1/quote";
const SOLVER_SIGNATURE_DOMAIN: &[u8] = b"CON/v1/solver-signature";
const SECP256K1_ORDER: [u8; 32] = [
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xfe,
    0xba, 0xae, 0xdc, 0xe6, 0xaf, 0x48, 0xa0, 0x3b, 0xbf, 0xd2, 0x5e, 0x8c, 0xd0, 0x36, 0x41, 0x41,
];
const SECP256K1_HALF_ORDER: [u8; 32] = [
    0x7f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0x5d, 0x57, 0x6e, 0x73, 0x57, 0xa4, 0x50, 0x1d, 0xdf, 0xe9, 0x2f, 0x46, 0x68, 0x1b, 0x20, 0xa0,
];

macro_rules! quote_enum {
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

quote_enum!(SolverSignatureScheme {
    Ed25519 = 1,
    Secp256k1Recoverable = 2,
});
quote_enum!(QuoteMode {
    Implied = 1,
    ExecutionCommitment = 2,
    FirmSimulated = 3,
    FirmOnchain = 4,
});

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum QuotedOutcome {
    EntrySpread(ExactSignedRate),
    ExitQuoteOutcome(AssetAmount),
}

impl QuotedOutcome {
    fn encode(&self, out: &mut Vec<u8>) {
        match self {
            Self::EntrySpread(rate) => {
                out.push(1);
                rate.encode(out);
            }
            Self::ExitQuoteOutcome(amount) => {
                out.push(2);
                amount.encode(out);
            }
        }
    }

    fn assets<'a>(&'a self, gross: &'a AssetAmount) -> (&'a AssetRef, &'a AssetRef) {
        match self {
            Self::EntrySpread(rate) => (rate.base_asset(), rate.quote_asset()),
            Self::ExitQuoteOutcome(amount) => (gross.asset(), amount.asset()),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SolverQuoteInput {
    pub version: u32,
    pub environment: ProtocolId,
    pub domain: DomainRef,
    pub order_hash: CommitmentHash,
    pub solver_id: ProtocolId,
    pub solver_capability_manifest_hash: ManifestHash,
    pub solver_signature_scheme: SolverSignatureScheme,
    pub solver_verification_key: Vec<u8>,
    pub quote_mode: QuoteMode,
    pub route_hash: CommitmentHash,
    pub quoted_outcome: QuotedOutcome,
    pub expected_spot_notional: AssetAmount,
    pub expected_perp_notional: AssetAmount,
    pub expected_gross_spot_quantity: AssetAmount,
    pub expected_net_spot_quantity: AssetAmount,
    pub expected_base_asset_fee: AssetAmount,
    pub expected_terminal_residual_base_quantity: Option<AssetAmount>,
    pub expected_terminal_residual_quote_value: Option<AssetAmount>,
    pub expected_margin_delta: AssetAmount,
    pub expected_raw_fill_fees_by_asset: Vec<AssetAmount>,
    pub expected_builder_fees_by_asset: Vec<AssetAmount>,
    pub expected_normalized_venue_fees_by_asset: Vec<AssetAmount>,
    pub solver_fee: AssetAmount,
    pub protocol_fee: AssetAmount,
    pub expected_priority_fee: AssetAmount,
    pub max_recovery_cost_atoms_by_asset: Vec<FeeCap>,
    pub fee_policy_version: u32,
    pub fee_policy_manifest_hash: ManifestHash,
    pub valid_until_unit: ExpiryUnit,
    pub valid_until_value: u64,
    pub reservation_id: Option<CommitmentHash>,
    pub quote_nonce: U256,
    pub signature: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SolverQuote(SolverQuoteInput);

impl SolverQuote {
    pub fn new(input: SolverQuoteInput) -> Result<Self> {
        require!(input.version == VERSION, ErrorCode::WireVersionMismatch);
        require!(
            input.expected_spot_notional.atoms() > 0,
            ErrorCode::WirePositiveValueZero
        );
        require!(
            input.expected_perp_notional.atoms() > 0,
            ErrorCode::WirePositiveValueZero
        );
        require!(
            input.expected_gross_spot_quantity.atoms() > 0,
            ErrorCode::WirePositiveValueZero
        );
        require!(
            input.quote_nonce.to_be_bytes() != [0u8; 32],
            ErrorCode::WireNonceZero
        );
        require!(input.fee_policy_version != 0, ErrorCode::WireVersionZero);

        let (base_asset, quote_asset) = input
            .quoted_outcome
            .assets(&input.expected_gross_spot_quantity);
        require_asset(&input.expected_spot_notional, quote_asset)?;
        require_asset(&input.expected_perp_notional, quote_asset)?;
        require_asset(&input.expected_gross_spot_quantity, base_asset)?;
        require_asset(&input.expected_net_spot_quantity, base_asset)?;
        require_asset(&input.expected_base_asset_fee, base_asset)?;
        require_asset(&input.expected_margin_delta, quote_asset)?;
        require_asset(&input.solver_fee, quote_asset)?;
        require_asset(&input.protocol_fee, quote_asset)?;

        require_canonical_amounts(&input.expected_raw_fill_fees_by_asset)?;
        require_canonical_amounts(&input.expected_builder_fees_by_asset)?;
        require_canonical_amounts(&input.expected_normalized_venue_fees_by_asset)?;
        require_same_asset_keys(
            &input.expected_raw_fill_fees_by_asset,
            &input.expected_builder_fees_by_asset,
        )?;
        require_same_asset_keys(
            &input.expected_raw_fill_fees_by_asset,
            &input.expected_normalized_venue_fees_by_asset,
        )?;
        for ((raw, builder), normalized) in input
            .expected_raw_fill_fees_by_asset
            .iter()
            .zip(&input.expected_builder_fees_by_asset)
            .zip(&input.expected_normalized_venue_fees_by_asset)
        {
            let combined = normalized
                .atoms()
                .checked_add(builder.atoms())
                .ok_or_else(|| error!(ErrorCode::WireFeeArithmeticOverflow))?;
            require!(combined == raw.atoms(), ErrorCode::WireFeeConservation);
        }
        let raw_base_fee = input
            .expected_raw_fill_fees_by_asset
            .iter()
            .find(|fee| fee.asset() == base_asset);
        require!(
            raw_base_fee.map(AssetAmount::atoms) == Some(input.expected_base_asset_fee.atoms()),
            ErrorCode::WireBaseFeeMismatch
        );

        require_canonical_caps(&input.max_recovery_cost_atoms_by_asset)?;
        let residual_base = input.expected_terminal_residual_base_quantity.as_ref();
        let residual_quote = input.expected_terminal_residual_quote_value.as_ref();
        require!(
            residual_base.is_some() == residual_quote.is_some(),
            ErrorCode::WireResidualShape
        );
        if let (Some(base), Some(quote)) = (residual_base, residual_quote) {
            require_asset(base, base_asset)?;
            require_asset(quote, quote_asset)?;
            require!(
                !input.max_recovery_cost_atoms_by_asset.is_empty(),
                ErrorCode::WireResidualShape
            );
        } else {
            require!(
                input.max_recovery_cost_atoms_by_asset.is_empty(),
                ErrorCode::WireResidualShape
            );
        }

        let is_firm = matches!(
            input.quote_mode,
            QuoteMode::FirmSimulated | QuoteMode::FirmOnchain
        );
        require!(
            is_firm == input.reservation_id.is_some(),
            ErrorCode::WireReservationRule
        );
        if is_firm {
            require!(
                matches!(input.quoted_outcome, QuotedOutcome::EntrySpread(_))
                    && residual_base.is_none(),
                ErrorCode::WireFirmQuoteShape
            );
        }
        validate_signature_material(
            input.solver_signature_scheme,
            &input.solver_verification_key,
            &input.signature,
        )?;

        Ok(Self(input))
    }

    pub fn unsigned_canonical_bytes(&self) -> Result<Vec<u8>> {
        let value = &self.0;
        let mut out = Vec::new();
        out.extend_from_slice(&value.version.to_be_bytes());
        out.extend_from_slice(&value.environment.canonical_bytes());
        out.extend_from_slice(&value.domain.canonical_bytes());
        out.extend_from_slice(&value.order_hash.bytes());
        out.extend_from_slice(&value.solver_id.canonical_bytes());
        out.extend_from_slice(&value.solver_capability_manifest_hash.bytes());
        out.push(value.solver_signature_scheme.discriminant());
        encode_byte_string(&mut out, &value.solver_verification_key)?;
        out.push(value.quote_mode.discriminant());
        out.extend_from_slice(&value.route_hash.bytes());
        value.quoted_outcome.encode(&mut out);
        value.expected_spot_notional.encode(&mut out);
        value.expected_perp_notional.encode(&mut out);
        value.expected_gross_spot_quantity.encode(&mut out);
        value.expected_net_spot_quantity.encode(&mut out);
        value.expected_base_asset_fee.encode(&mut out);
        encode_optional_amount(&mut out, &value.expected_terminal_residual_base_quantity);
        encode_optional_amount(&mut out, &value.expected_terminal_residual_quote_value);
        value.expected_margin_delta.encode(&mut out);
        encode_array(
            &mut out,
            &value.expected_raw_fill_fees_by_asset,
            AssetAmount::encode,
        )?;
        encode_array(
            &mut out,
            &value.expected_builder_fees_by_asset,
            AssetAmount::encode,
        )?;
        encode_array(
            &mut out,
            &value.expected_normalized_venue_fees_by_asset,
            AssetAmount::encode,
        )?;
        value.solver_fee.encode(&mut out);
        value.protocol_fee.encode(&mut out);
        value.expected_priority_fee.encode(&mut out);
        encode_array(
            &mut out,
            &value.max_recovery_cost_atoms_by_asset,
            FeeCap::encode,
        )?;
        out.extend_from_slice(&value.fee_policy_version.to_be_bytes());
        out.extend_from_slice(&value.fee_policy_manifest_hash.bytes());
        out.push(value.valid_until_unit.discriminant());
        out.extend_from_slice(&value.valid_until_value.to_be_bytes());
        encode_optional_hash(&mut out, &value.reservation_id);
        out.extend_from_slice(&value.quote_nonce.to_be_bytes());
        Ok(out)
    }

    pub fn canonical_bytes(&self) -> Result<Vec<u8>> {
        let mut out = self.unsigned_canonical_bytes()?;
        encode_byte_string(&mut out, &self.0.signature)?;
        Ok(out)
    }

    pub fn quote_hash(&self) -> Result<[u8; HASH_BYTE_LENGTH]> {
        let order_hash = self.0.order_hash.bytes();
        let route_hash = self.0.route_hash.bytes();
        let unsigned = self.unsigned_canonical_bytes()?;
        Ok(hashv(&[QUOTE_HASH_DOMAIN, &order_hash, &route_hash, &unsigned]).to_bytes())
    }

    pub fn solver_signature_digest(&self) -> Result<[u8; HASH_BYTE_LENGTH]> {
        let quote_hash = self.quote_hash()?;
        Ok(hashv(&[SOLVER_SIGNATURE_DOMAIN, &quote_hash]).to_bytes())
    }
}

fn require_asset(amount: &AssetAmount, expected: &AssetRef) -> Result<()> {
    require!(amount.asset() == expected, ErrorCode::WireAssetMismatch);
    Ok(())
}

fn require_canonical_amounts(values: &[AssetAmount]) -> Result<()> {
    require_u32_len(values.len())?;
    for pair in values.windows(2) {
        match pair[0]
            .asset()
            .canonical_bytes()
            .cmp(&pair[1].asset().canonical_bytes())
        {
            core::cmp::Ordering::Less => {}
            core::cmp::Ordering::Equal => return err!(ErrorCode::WireCollectionDuplicate),
            core::cmp::Ordering::Greater => return err!(ErrorCode::WireCollectionNotCanonical),
        }
    }
    Ok(())
}

fn require_same_asset_keys(left: &[AssetAmount], right: &[AssetAmount]) -> Result<()> {
    require!(left.len() == right.len(), ErrorCode::WireFeeKeyMismatch);
    for (left_item, right_item) in left.iter().zip(right) {
        require!(
            left_item.asset() == right_item.asset(),
            ErrorCode::WireFeeKeyMismatch
        );
    }
    Ok(())
}

fn require_canonical_caps(values: &[FeeCap]) -> Result<()> {
    require_u32_len(values.len())?;
    for cap in values {
        require!(cap.max_atoms() >= 0, ErrorCode::WireRecoveryCapNegative);
    }
    for pair in values.windows(2) {
        match pair[0].key().cmp(&pair[1].key()) {
            core::cmp::Ordering::Less => {}
            core::cmp::Ordering::Equal => return err!(ErrorCode::WireCollectionDuplicate),
            core::cmp::Ordering::Greater => return err!(ErrorCode::WireCollectionNotCanonical),
        }
    }
    Ok(())
}

fn validate_signature_material(
    scheme: SolverSignatureScheme,
    verification_key: &[u8],
    signature: &[u8],
) -> Result<()> {
    match scheme {
        SolverSignatureScheme::Ed25519 => {
            require!(verification_key.len() == 32, ErrorCode::WireSignatureShape);
            require!(signature.len() == 64, ErrorCode::WireSignatureShape);
        }
        SolverSignatureScheme::Secp256k1Recoverable => {
            require!(verification_key.len() == 20, ErrorCode::WireSignatureShape);
            require!(signature.len() == 65, ErrorCode::WireSignatureShape);
            let r: [u8; 32] = signature[..32]
                .try_into()
                .map_err(|_| error!(ErrorCode::WireSignatureShape))?;
            let s: [u8; 32] = signature[32..64]
                .try_into()
                .map_err(|_| error!(ErrorCode::WireSignatureShape))?;
            require!(
                r != [0u8; 32] && r < SECP256K1_ORDER,
                ErrorCode::WireSecpScalarInvalid
            );
            require!(s != [0u8; 32], ErrorCode::WireSecpScalarInvalid);
            require!(s <= SECP256K1_HALF_ORDER, ErrorCode::WireSecpHighS);
            require!(
                signature[64] == 0 || signature[64] == 1,
                ErrorCode::WireSecpRecoveryId
            );
        }
    }
    Ok(())
}

fn require_u32_len(length: usize) -> Result<u32> {
    u32::try_from(length).map_err(|_| error!(ErrorCode::WireCollectionTooLong))
}

fn encode_byte_string(out: &mut Vec<u8>, value: &[u8]) -> Result<()> {
    out.extend_from_slice(&require_u32_len(value.len())?.to_be_bytes());
    out.extend_from_slice(value);
    Ok(())
}

fn encode_optional_amount(out: &mut Vec<u8>, value: &Option<AssetAmount>) {
    match value {
        None => out.push(0),
        Some(amount) => {
            out.push(1);
            amount.encode(out);
        }
    }
}

fn encode_optional_hash(out: &mut Vec<u8>, value: &Option<CommitmentHash>) {
    match value {
        None => out.push(0),
        Some(hash) => {
            out.push(1);
            out.extend_from_slice(&hash.bytes());
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

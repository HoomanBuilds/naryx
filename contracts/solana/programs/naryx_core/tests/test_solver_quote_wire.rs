use {
    anchor_lang::error::Error,
    naryx_core::{
        error::ErrorCode,
        wire::{
            AssetAmount, AssetRef, CommitmentHash, DomainRef, ExactSignedRate, ExpiryUnit, FeeCap,
            ManifestHash, ProtocolId, QuoteMode, QuotedOutcome, RoundingDirection, SolverQuote,
            SolverQuoteInput, SolverSignatureScheme, U256,
        },
    },
};

const FIXTURE: &str =
    include_str!("../../../../../packages/protocol-types/fixtures/solver-quote.json");

fn fixture_string(field: &str) -> String {
    let marker = format!("\"{field}\": \"");
    let start = FIXTURE.find(&marker).unwrap() + marker.len();
    let tail = &FIXTURE[start..];
    tail[..tail.find('"').unwrap()].to_string()
}

fn decode_hex(value: &str) -> Vec<u8> {
    assert_eq!(value.len() % 2, 0);
    (0..value.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&value[index..index + 2], 16).unwrap())
        .collect()
}

fn hash32(value: &str) -> [u8; 32] {
    decode_hex(value).try_into().unwrap()
}

fn asset(id: &str, byte: u8, decimals: u8) -> AssetRef {
    AssetRef::new(id, [byte; 32], decimals).unwrap()
}

fn fixture_assets() -> (AssetRef, AssetRef) {
    (
        asset("svm:test-domain-1:sol", 0x44, 9),
        asset("svm:test-domain-1:usdc", 0x55, 6),
    )
}

fn fixture_input() -> SolverQuoteInput {
    let (sol, usdc) = fixture_assets();
    SolverQuoteInput {
        version: 1,
        environment: ProtocolId::new("testnet").unwrap(),
        domain: DomainRef::new("svm:test-domain-1", 1, [0x33; 32]).unwrap(),
        order_hash: CommitmentHash::new([0x11; 32]).unwrap(),
        solver_id: ProtocolId::new("solver-alpha").unwrap(),
        solver_capability_manifest_hash: ManifestHash::new([0x66; 32]).unwrap(),
        solver_signature_scheme: SolverSignatureScheme::Ed25519,
        solver_verification_key: vec![0x88; 32],
        quote_mode: QuoteMode::Implied,
        route_hash: CommitmentHash::new([0x22; 32]).unwrap(),
        quoted_outcome: QuotedOutcome::EntrySpread(
            ExactSignedRate::new(
                sol.clone(),
                usdc.clone(),
                -5,
                1,
                RoundingDirection::TowardZero,
            )
            .unwrap(),
        ),
        expected_spot_notional: AssetAmount::new(usdc.clone(), 100_000_000),
        expected_perp_notional: AssetAmount::new(usdc.clone(), 99_500_000),
        expected_gross_spot_quantity: AssetAmount::new(sol.clone(), 1_000_000_000),
        expected_net_spot_quantity: AssetAmount::new(sol.clone(), 999_999_000),
        expected_base_asset_fee: AssetAmount::new(sol.clone(), 1_000),
        expected_terminal_residual_base_quantity: None,
        expected_terminal_residual_quote_value: None,
        expected_margin_delta: AssetAmount::new(usdc.clone(), 20_000_000),
        expected_raw_fill_fees_by_asset: vec![
            AssetAmount::new(sol.clone(), 1_000),
            AssetAmount::new(usdc.clone(), 30_000),
        ],
        expected_builder_fees_by_asset: vec![
            AssetAmount::new(sol.clone(), 0),
            AssetAmount::new(usdc.clone(), 5_000),
        ],
        expected_normalized_venue_fees_by_asset: vec![
            AssetAmount::new(sol.clone(), 1_000),
            AssetAmount::new(usdc.clone(), 25_000),
        ],
        solver_fee: AssetAmount::new(usdc.clone(), 10_000),
        protocol_fee: AssetAmount::new(usdc.clone(), 0),
        expected_priority_fee: AssetAmount::new(sol, 5_000),
        max_recovery_cost_atoms_by_asset: vec![],
        fee_policy_version: 1,
        fee_policy_manifest_hash: ManifestHash::new([0x77; 32]).unwrap(),
        valid_until_unit: ExpiryUnit::SolanaSlot,
        valid_until_value: 123_456,
        reservation_id: None,
        quote_nonce: U256::from_u64(1),
        signature: vec![0x99; 64],
    }
}

#[test]
fn solver_quote_matches_typescript_golden_vector() {
    let quote = SolverQuote::new(fixture_input()).unwrap();

    assert_eq!(
        quote.unsigned_canonical_bytes().unwrap(),
        decode_hex(&fixture_string("unsignedCanonicalHex"))
    );
    assert_eq!(
        quote.canonical_bytes().unwrap(),
        decode_hex(&fixture_string("canonicalHex"))
    );
    assert_eq!(
        quote.quote_hash().unwrap(),
        hash32(&fixture_string("quoteHashHex"))
    );
    assert_eq!(
        quote.solver_signature_digest().unwrap(),
        hash32(&fixture_string("solverSignatureDigestHex"))
    );
}

#[test]
fn fee_sets_and_conservation_fail_closed() {
    let (_, usdc) = fixture_assets();

    let mut mismatched_keys = fixture_input();
    mismatched_keys.expected_builder_fees_by_asset.pop();
    assert_eq!(
        SolverQuote::new(mismatched_keys).unwrap_err(),
        Error::from(ErrorCode::WireFeeKeyMismatch)
    );

    let mut unconserved = fixture_input();
    unconserved.expected_builder_fees_by_asset[1] = AssetAmount::new(usdc.clone(), 5_001);
    assert_eq!(
        SolverQuote::new(unconserved).unwrap_err(),
        Error::from(ErrorCode::WireFeeConservation)
    );

    let mut overflow = fixture_input();
    overflow.expected_builder_fees_by_asset[1] = AssetAmount::new(usdc.clone(), 1);
    overflow.expected_normalized_venue_fees_by_asset[1] = AssetAmount::new(usdc.clone(), i128::MAX);
    assert_eq!(
        SolverQuote::new(overflow).unwrap_err(),
        Error::from(ErrorCode::WireFeeArithmeticOverflow)
    );

    let mut wrong_base_fee = fixture_input();
    let (sol, _) = fixture_assets();
    wrong_base_fee.expected_base_asset_fee = AssetAmount::new(sol, 999);
    assert_eq!(
        SolverQuote::new(wrong_base_fee).unwrap_err(),
        Error::from(ErrorCode::WireBaseFeeMismatch)
    );
}

#[test]
fn signature_shapes_and_secp_rules_fail_closed() {
    let mut short_ed25519 = fixture_input();
    short_ed25519.signature.pop();
    assert_eq!(
        SolverQuote::new(short_ed25519).unwrap_err(),
        Error::from(ErrorCode::WireSignatureShape)
    );

    let mut secp = fixture_input();
    secp.solver_signature_scheme = SolverSignatureScheme::Secp256k1Recoverable;
    secp.solver_verification_key = vec![0x42; 20];
    secp.signature = vec![0u8; 65];
    secp.signature[31] = 1;
    secp.signature[63] = 1;
    SolverQuote::new(secp.clone()).unwrap();

    let mut zero_r = secp.clone();
    zero_r.signature[31] = 0;
    assert_eq!(
        SolverQuote::new(zero_r).unwrap_err(),
        Error::from(ErrorCode::WireSecpScalarInvalid)
    );

    let mut high_s = secp.clone();
    high_s.signature[32..64].copy_from_slice(&hash32(
        "7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a1",
    ));
    assert_eq!(
        SolverQuote::new(high_s).unwrap_err(),
        Error::from(ErrorCode::WireSecpHighS)
    );

    let mut bad_recovery = secp;
    bad_recovery.signature[64] = 2;
    assert_eq!(
        SolverQuote::new(bad_recovery).unwrap_err(),
        Error::from(ErrorCode::WireSecpRecoveryId)
    );
}

#[test]
fn residual_and_firm_reservation_shapes_fail_closed() {
    let (sol, usdc) = fixture_assets();

    let mut incomplete_residual = fixture_input();
    incomplete_residual.expected_terminal_residual_base_quantity =
        Some(AssetAmount::new(sol.clone(), 1));
    assert_eq!(
        SolverQuote::new(incomplete_residual).unwrap_err(),
        Error::from(ErrorCode::WireResidualShape)
    );

    let mut residual_without_cap = fixture_input();
    residual_without_cap.expected_terminal_residual_base_quantity =
        Some(AssetAmount::new(sol.clone(), 1));
    residual_without_cap.expected_terminal_residual_quote_value =
        Some(AssetAmount::new(usdc.clone(), 1));
    assert_eq!(
        SolverQuote::new(residual_without_cap).unwrap_err(),
        Error::from(ErrorCode::WireResidualShape)
    );

    let mut residual = fixture_input();
    residual.expected_terminal_residual_base_quantity = Some(AssetAmount::new(sol.clone(), 1));
    residual.expected_terminal_residual_quote_value = Some(AssetAmount::new(usdc.clone(), 1));
    residual.max_recovery_cost_atoms_by_asset = vec![FeeCap::new(sol.clone(), 10)];
    SolverQuote::new(residual).unwrap();

    let mut firm_residual = fixture_input();
    firm_residual.quote_mode = QuoteMode::FirmSimulated;
    firm_residual.reservation_id = Some(CommitmentHash::new([0xaa; 32]).unwrap());
    firm_residual.expected_terminal_residual_base_quantity = Some(AssetAmount::new(sol.clone(), 1));
    firm_residual.expected_terminal_residual_quote_value = Some(AssetAmount::new(usdc.clone(), 1));
    firm_residual.max_recovery_cost_atoms_by_asset = vec![FeeCap::new(sol.clone(), 10)];
    assert_eq!(
        SolverQuote::new(firm_residual).unwrap_err(),
        Error::from(ErrorCode::WireFirmQuoteShape)
    );

    let mut negative_cap = fixture_input();
    negative_cap.expected_terminal_residual_base_quantity = Some(AssetAmount::new(sol.clone(), 1));
    negative_cap.expected_terminal_residual_quote_value = Some(AssetAmount::new(usdc, 1));
    negative_cap.max_recovery_cost_atoms_by_asset = vec![FeeCap::new(sol, -1)];
    assert_eq!(
        SolverQuote::new(negative_cap).unwrap_err(),
        Error::from(ErrorCode::WireRecoveryCapNegative)
    );

    let mut firm_missing_reservation = fixture_input();
    firm_missing_reservation.quote_mode = QuoteMode::FirmOnchain;
    assert_eq!(
        SolverQuote::new(firm_missing_reservation).unwrap_err(),
        Error::from(ErrorCode::WireReservationRule)
    );

    let mut nonfirm_with_reservation = fixture_input();
    nonfirm_with_reservation.reservation_id = Some(CommitmentHash::new([0xaa; 32]).unwrap());
    assert_eq!(
        SolverQuote::new(nonfirm_with_reservation).unwrap_err(),
        Error::from(ErrorCode::WireReservationRule)
    );

    let mut firm = fixture_input();
    firm.quote_mode = QuoteMode::FirmSimulated;
    firm.reservation_id = Some(CommitmentHash::new([0xaa; 32]).unwrap());
    SolverQuote::new(firm).unwrap();
}

#[test]
fn version_nonce_and_canonical_fee_order_fail_closed() {
    let mut wrong_version = fixture_input();
    wrong_version.version = 2;
    assert_eq!(
        SolverQuote::new(wrong_version).unwrap_err(),
        Error::from(ErrorCode::WireVersionMismatch)
    );

    let mut zero_nonce = fixture_input();
    zero_nonce.quote_nonce = U256::from_be_bytes([0u8; 32]);
    assert_eq!(
        SolverQuote::new(zero_nonce).unwrap_err(),
        Error::from(ErrorCode::WireNonceZero)
    );

    let mut duplicate = fixture_input();
    duplicate.expected_raw_fill_fees_by_asset[1] =
        duplicate.expected_raw_fill_fees_by_asset[0].clone();
    assert_eq!(
        SolverQuote::new(duplicate).unwrap_err(),
        Error::from(ErrorCode::WireCollectionDuplicate)
    );

    let mut noncanonical = fixture_input();
    noncanonical.expected_raw_fill_fees_by_asset.swap(0, 1);
    assert_eq!(
        SolverQuote::new(noncanonical).unwrap_err(),
        Error::from(ErrorCode::WireCollectionNotCanonical)
    );
}

use {
    anchor_lang::error::Error,
    naryx_core::{
        error::ErrorCode,
        wire::{
            AdapterRef, AssetAmount, AssetRef, CommitmentHash, Direction, DomainRef, ExactPrice,
            ExactSignedRate, ExpiryUnit, FeeCap, ManifestHash, PackageAction, PackageOrder,
            PackageOrderInput, PackageOrderType, PackageTimeInForce, PartialFillPolicy, ProtocolId,
            RecoveryAction, RoundingDirection, SettlementClass, U256,
        },
    },
};

const FIXTURE: &str =
    include_str!("../../../../../packages/protocol-types/fixtures/package-order-atomic.json");

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

fn asset(id: &str, hash: &str, decimals: u8) -> AssetRef {
    AssetRef::new(id, hash32(hash), decimals).unwrap()
}

fn fixture_input() -> PackageOrderInput {
    let domain_hash = fixture_string("domainManifestHash");
    let template_hash = fixture_string("packageTemplateManifestHash");
    let sol_hash = "55cc45c79c5212638127ac63de7cf3d1f26b64d38969f9695230b75f4561af91";
    let usdc_hash = "66aacda362a4631cff1aa1341209f1900c151ba747473842072e19c8d3f305fd";
    let sol = asset("svm:test-domain-1:sol", sol_hash, 9);
    let usdc = asset("svm:test-domain-1:usdc", usdc_hash, 6);

    PackageOrderInput {
        version: 1,
        environment: ProtocolId::new("testnet").unwrap(),
        domain: DomainRef::new("svm:test-domain-1", 1, hash32(&domain_hash)).unwrap(),
        template_id: ProtocolId::new("cash-and-carry-v1").unwrap(),
        template_version: 1,
        package_template_manifest_hash: ManifestHash::new(hash32(&template_hash)).unwrap(),
        owner: ProtocolId::new("owner-wallet-1").unwrap(),
        settlement_account: ProtocolId::new("strategy-account-1").unwrap(),
        nonce: U256::from_u64(42),
        expiry_unit: ExpiryUnit::SolanaSlot,
        expiry_value: 500_000_000,
        direction: Direction::LongSpotShortPerp,
        action: PackageAction::Entry,
        package_order_type: PackageOrderType::MarketableLimit,
        package_time_in_force: PackageTimeInForce::Fok,
        partial_fill_policy: PartialFillPolicy::ExactAllLegs,
        activation_condition_hash: None,
        execution_schedule_hash: None,
        quantity: AssetAmount::new(sol.clone(), 1_000_000_000),
        hyperliquid_quantity_policy: None,
        hyperliquid_gross_spot_quantity: None,
        hyperliquid_min_net_spot_delta: None,
        hyperliquid_max_net_spot_delta: None,
        hyperliquid_max_terminal_residual_base_quantity: None,
        hyperliquid_residual_valuation_schema_version: None,
        hyperliquid_residual_valuation_reference_price: None,
        hyperliquid_max_terminal_residual_quote_value: None,
        expected_pre_strategy_spot_quantity: None,
        hyperliquid_recovery_expiry_unit: None,
        hyperliquid_max_recovery_action_expiry_value: None,
        hyperliquid_recovery_deadline_value: None,
        hyperliquid_min_recovery_window_ms: None,
        exit_outcome_schema_version: 0,
        entry_receipt_hash: None,
        expected_pre_position_size: AssetAmount::new(sol.clone(), 0),
        expected_pre_position_entry_notional: AssetAmount::new(usdc.clone(), 0),
        max_entry_spread: Some(
            ExactSignedRate::new(sol.clone(), usdc.clone(), 1, 400, RoundingDirection::Ceil)
                .unwrap(),
        ),
        min_exit_quote_outcome: None,
        max_spot_quote_in: Some(AssetAmount::new(usdc.clone(), 150_000_000)),
        min_spot_quote_out: None,
        hyperliquid_min_perp_sell_price: None,
        hyperliquid_max_perp_buy_price: None,
        max_margin_added: AssetAmount::new(usdc.clone(), 20_000_000),
        min_venue_reserve_returned: AssetAmount::new(usdc.clone(), 0),
        min_wallet_quote_balance_delta: AssetAmount::new(usdc.clone(), 0),
        max_venue_fee_atoms_by_asset: vec![FeeCap::new(usdc.clone(), 1_000_000)],
        max_protocol_fee: AssetAmount::new(usdc.clone(), 200_000),
        max_solver_fee: AssetAmount::new(usdc.clone(), 300_000),
        max_priority_fee: AssetAmount::new(usdc.clone(), 100_000),
        max_recovery_cost_atoms_by_asset: vec![],
        permitted_spot_adapters: vec![AdapterRef::new(
            "solana-spot-adapter-v1",
            1,
            hash32("771a42794cd60bc63a3327e4cc10224a898f724fab16604695e36839d1d689e9"),
        )
        .unwrap()],
        permitted_perp_adapters: vec![AdapterRef::new(
            "solana-perp-adapter-v1",
            1,
            hash32("88296d890af07873ec5722464e8688ca92520cd3237d708f1d5ca25478dd0075"),
        )
        .unwrap()],
        settlement_class: SettlementClass::AtomicPostcondition,
        max_recovery_spot_buy_price: None,
        min_recovery_spot_sell_price: None,
        min_recovery_perp_sell_price: None,
        max_recovery_perp_buy_price: None,
        max_aggregate_recovery_loss_quote: AssetAmount::new(usdc, 0),
        max_residual_base_quantity: AssetAmount::new(sol, 0),
        allowed_recovery_actions: vec![],
    }
}

#[test]
fn package_order_matches_typescript_golden_vector() {
    let order = PackageOrder::new(fixture_input()).unwrap();

    assert_eq!(
        order.canonical_bytes().unwrap(),
        decode_hex(&fixture_string("canonicalHex"))
    );
    assert_eq!(order.hash().unwrap(), hash32(&fixture_string("digestHex")));
}

#[test]
fn u256_and_enum_boundaries_fail_closed() {
    let max = U256::from_be_bytes([0xff; 32]);
    assert_eq!(max.to_be_bytes(), [0xff; 32]);
    assert_eq!(
        U256::try_from_be_slice(&[0u8; 31]).unwrap_err(),
        Error::from(ErrorCode::WireIntegerWidth)
    );
    assert_eq!(
        U256::try_from_be_slice(&[0u8; 33]).unwrap_err(),
        Error::from(ErrorCode::WireIntegerWidth)
    );
    assert_eq!(
        PackageOrderType::try_from(0).unwrap_err(),
        Error::from(ErrorCode::WireEnumUnknown)
    );
    assert_eq!(
        ExpiryUnit::try_from(4).unwrap_err(),
        Error::from(ErrorCode::WireEnumUnknown)
    );
    assert_eq!(
        RecoveryAction::try_from(6).unwrap_err(),
        Error::from(ErrorCode::WireEnumUnknown)
    );
}

#[test]
fn structural_versions_hashes_and_exact_ratios_fail_closed() {
    assert_eq!(
        ManifestHash::new([0u8; 32]).unwrap_err(),
        Error::from(ErrorCode::WireManifestHashZero)
    );
    assert_eq!(
        CommitmentHash::new([0u8; 32]).unwrap_err(),
        Error::from(ErrorCode::WireCommitmentHashZero)
    );

    let mut zero_version = fixture_input();
    zero_version.version = 0;
    assert_eq!(
        PackageOrder::new(zero_version).unwrap_err(),
        Error::from(ErrorCode::WireVersionZero)
    );
    let base = asset("base", &"11".repeat(32), 9);
    let quote = asset("quote", &"22".repeat(32), 6);
    assert_eq!(
        ExactPrice::new(base.clone(), quote.clone(), 0, 1, RoundingDirection::Floor).unwrap_err(),
        Error::from(ErrorCode::WirePositiveValueZero)
    );
    assert_eq!(
        ExactPrice::new(base.clone(), quote.clone(), 2, 4, RoundingDirection::Floor).unwrap_err(),
        Error::from(ErrorCode::WireFractionNotReduced)
    );
    assert_eq!(
        ExactSignedRate::new(base, quote, 0, 2, RoundingDirection::TowardZero).unwrap_err(),
        Error::from(ErrorCode::WireFractionNotReduced)
    );
}

#[test]
fn canonical_sets_and_required_adapter_sets_fail_closed() {
    let first_asset = asset("asset-a", &"11".repeat(32), 6);
    let second_asset = asset("asset-b", &"22".repeat(32), 6);

    let mut descending = fixture_input();
    descending.max_venue_fee_atoms_by_asset = vec![
        FeeCap::new(second_asset.clone(), 2),
        FeeCap::new(first_asset.clone(), 1),
    ];
    assert_eq!(
        PackageOrder::new(descending).unwrap_err(),
        Error::from(ErrorCode::WireCollectionNotCanonical)
    );

    let mut duplicate = fixture_input();
    duplicate.max_venue_fee_atoms_by_asset = vec![
        FeeCap::new(first_asset.clone(), 1),
        FeeCap::new(first_asset.clone(), 2),
    ];
    assert_eq!(
        PackageOrder::new(duplicate).unwrap_err(),
        Error::from(ErrorCode::WireCollectionDuplicate)
    );

    let mut empty_adapters = fixture_input();
    empty_adapters.permitted_perp_adapters.clear();
    assert_eq!(
        PackageOrder::new(empty_adapters).unwrap_err(),
        Error::from(ErrorCode::WireCollectionEmpty)
    );

    let mut exposed_hash = first_asset.asset_manifest_hash();
    exposed_hash.fill(0);
    assert_ne!(first_asset.asset_manifest_hash(), exposed_hash);
}

use {
    anchor_lang::error::Error,
    naryx_core::{
        error::ErrorCode,
        wire::{
            payload_template_hash, ActionAccountMeta, ActionCommitment, AdapterRef, AssetAmount,
            AssetRef, CommitmentHash, Comparator, Direction, DomainRef, EvidenceRequirements,
            ExactPrice, ExecutionPlanKind, ExpiryUnit, LateBoundField, LateBoundFieldKind,
            LegExecution, LegRole, ManifestHash, PackageAction, PackageTimeInForce,
            PartialFillPolicy, PayloadTemplateCommitment, PositiveAssetAmount, ProtocolId,
            QuantityPolicyClass, RoundingDirection, RouteAccountBinding, RoutePayload,
            RoutePayloadInput, SettlementClass, StateConstraint, StateValue, TradeSide,
            VersionedManifestRef,
        },
    },
};

const FIXTURE: &str =
    include_str!("../../../../../packages/protocol-types/fixtures/route-payload.json");

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

fn repeated(value: u8) -> [u8; 32] {
    [value; 32]
}

fn id(value: &str) -> ProtocolId {
    ProtocolId::new(value).unwrap()
}

fn asset(value: &str, hash: u8, decimals: u8) -> AssetRef {
    AssetRef::new(value, repeated(hash), decimals).unwrap()
}

fn fixture_input() -> RoutePayloadInput {
    let sol = asset("sol", 0x11, 9);
    let usdc = asset("usdc", 0x22, 6);
    let spot_adapter = AdapterRef::new("phoenix-spot", 1, repeated(0x44)).unwrap();
    let perp_adapter = AdapterRef::new("phoenix-perp", 1, repeated(0x55)).unwrap();
    let spot_price =
        ExactPrice::new(sol.clone(), usdc.clone(), 3, 2, RoundingDirection::Ceil).unwrap();
    let first_payload = {
        let mut bytes = vec![0xaa; 40];
        bytes[..8].copy_from_slice(&[1, 2, 3, 4, 5, 6, 7, 8]);
        bytes
    };
    let first_late_field = LateBoundField::new(LateBoundFieldKind::RouteHash, 8, 32).unwrap();

    RoutePayloadInput {
        version: 1,
        environment: id("devnet"),
        domain: DomainRef::new("solana-devnet", 1, repeated(0x33)).unwrap(),
        order_hash: CommitmentHash::new(repeated(0xaa)).unwrap(),
        template_id: id("cash-and-carry-v1"),
        template_version: 1,
        package_template_manifest_hash: ManifestHash::new(repeated(0xbb)).unwrap(),
        template_registry_record_hash: CommitmentHash::new(repeated(0xcc)).unwrap(),
        owner: id("trader-wallet"),
        settlement_account: id("strategy-account-1"),
        solver: id("solver-alpha"),
        direction: Direction::LongSpotShortPerp,
        action: PackageAction::Entry,
        quantity_policy_class: QuantityPolicyClass::ExactAtomic,
        partial_fill_policy: PartialFillPolicy::ExactAllLegs,
        settlement_class: SettlementClass::AtomicPostcondition,
        execution_plan_kind: ExecutionPlanKind::SvmAtomicCpi,
        route_expiry_unit: ExpiryUnit::SolanaSlot,
        route_expiry_value: 500_000,
        fee_policy_version: 2,
        fee_policy_manifest_hash: ManifestHash::new(repeated(0xdd)).unwrap(),
        account_bindings: vec![
            RouteAccountBinding::new(
                "trader-authority",
                None,
                None,
                "trader-wallet",
                None,
                Some("trader-wallet"),
                None,
            )
            .unwrap(),
            RouteAccountBinding::new(
                "spot-program",
                Some(spot_adapter.clone()),
                Some("market-program"),
                "phoenix-program",
                None,
                None,
                Some("phoenix-code-v1"),
            )
            .unwrap(),
            RouteAccountBinding::new(
                "perp-program",
                Some(perp_adapter.clone()),
                Some("market-program"),
                "phoenix-perp-program",
                None,
                None,
                Some("phoenix-perp-code-v1"),
            )
            .unwrap(),
            RouteAccountBinding::new(
                "fee-vault",
                None,
                None,
                "naryx-fee-vault",
                Some("naryx-fee-authority"),
                None,
                None,
            )
            .unwrap(),
        ],
        service_charges: vec![],
        preconditions: vec![StateConstraint {
            constraint_id: id("pre-trader-authorized"),
            rule_id: id("authority-equals-owner-v1"),
            account_binding_id: id("trader-authority"),
            component_id: id("is-authorized"),
            comparator: Comparator::Eq,
            value: StateValue::Boolean(true),
            evidence_requirement_id: id("authority-state"),
        }],
        legs: vec![
            LegExecution {
                leg_index: 0,
                leg_role: LegRole::Spot,
                action_sequence: 0,
                adapter: spot_adapter.clone(),
                venue: VersionedManifestRef::new("phoenix", 1, repeated(0x66)).unwrap(),
                market: VersionedManifestRef::new("sol-usdc-spot", 1, repeated(0x88)).unwrap(),
                base_asset: sol.clone(),
                quote_asset: usdc.clone(),
                side: TradeSide::Buy,
                quantity: PositiveAssetAmount::new(sol.clone(), 1_000_000_000).unwrap(),
                limit_price: spot_price.clone(),
                time_in_force: PackageTimeInForce::Fok,
                reduce_only: false,
            },
            LegExecution {
                leg_index: 1,
                leg_role: LegRole::Perpetual,
                action_sequence: 1,
                adapter: perp_adapter.clone(),
                venue: VersionedManifestRef::new("phoenix-perps", 1, repeated(0x77)).unwrap(),
                market: VersionedManifestRef::new("sol-usdc-perp", 1, repeated(0x99)).unwrap(),
                base_asset: sol.clone(),
                quote_asset: usdc,
                side: TradeSide::Sell,
                quantity: PositiveAssetAmount::new(sol.clone(), 1_000_000_000).unwrap(),
                limit_price: spot_price,
                time_in_force: PackageTimeInForce::Fok,
                reduce_only: false,
            },
        ],
        actions: vec![
            ActionCommitment {
                sequence: 0,
                action_class_id: id("svm-cpi-spot-v1"),
                leg_index: Some(0),
                adapter: Some(spot_adapter),
                target_binding_id: id("spot-program"),
                authority_binding_id: id("trader-authority"),
                account_metas: vec![
                    ActionAccountMeta::new("spot-program", false, false).unwrap(),
                    ActionAccountMeta::new("trader-authority", true, true).unwrap(),
                ],
                native_value: None,
                payload: PayloadTemplateCommitment::new(
                    "svm-instruction-v1",
                    40,
                    payload_template_hash(&first_payload, &[first_late_field.clone()]).unwrap(),
                    vec![first_late_field],
                )
                .unwrap(),
                fee_recipient_binding_id: Some(id("fee-vault")),
            },
            ActionCommitment {
                sequence: 1,
                action_class_id: id("svm-cpi-perp-v1"),
                leg_index: Some(1),
                adapter: Some(perp_adapter),
                target_binding_id: id("perp-program"),
                authority_binding_id: id("trader-authority"),
                account_metas: vec![
                    ActionAccountMeta::new("perp-program", false, false).unwrap(),
                    ActionAccountMeta::new("trader-authority", true, true).unwrap(),
                ],
                native_value: None,
                payload: PayloadTemplateCommitment::new(
                    "svm-instruction-v1",
                    3,
                    payload_template_hash(&[9, 8, 7], &[]).unwrap(),
                    vec![],
                )
                .unwrap(),
                fee_recipient_binding_id: None,
            },
        ],
        postconditions: vec![
            StateConstraint {
                constraint_id: id("post-perp-position"),
                rule_id: id("position-delta-v1"),
                account_binding_id: id("perp-program"),
                component_id: id("base-position-delta"),
                comparator: Comparator::Eq,
                value: StateValue::SignedAssetAmount(AssetAmount::new(sol.clone(), -1_000_000_000)),
                evidence_requirement_id: id("perp-position-state"),
            },
            StateConstraint {
                constraint_id: id("post-spot-balance"),
                rule_id: id("balance-delta-v1"),
                account_binding_id: id("spot-program"),
                component_id: id("base-balance-delta"),
                comparator: Comparator::Gte,
                value: StateValue::SignedAssetAmount(AssetAmount::new(sol, 1_000_000_000)),
                evidence_requirement_id: id("spot-balance-state"),
            },
        ],
        evidence_requirements: EvidenceRequirements::new(
            1,
            "svm-atomic-evidence-v1",
            vec![id("authority-state")],
            vec![id("perp-position-state"), id("spot-balance-state")],
            vec![id("cpi-result"), id("transaction-signature")],
            repeated(0xee),
            repeated(0xff),
            {
                let mut hash = [0u8; 32];
                hash[0] = 1;
                hash
            },
        )
        .unwrap(),
        recovery_plan: None,
    }
}

#[test]
fn route_payload_matches_typescript_golden_vector() {
    let route = RoutePayload::new(fixture_input()).unwrap();

    assert_eq!(
        payload_template_hash(
            &{
                let mut bytes = vec![0xaa; 40];
                bytes[..8].copy_from_slice(&[1, 2, 3, 4, 5, 6, 7, 8]);
                bytes
            },
            &[LateBoundField::new(LateBoundFieldKind::RouteHash, 8, 32).unwrap()]
        )
        .unwrap(),
        hash32(&fixture_string("payloadTemplateHash"))
    );
    assert_eq!(
        route.canonical_bytes().unwrap(),
        decode_hex(&fixture_string("canonicalHex"))
    );
    assert_eq!(route.hash().unwrap(), hash32(&fixture_string("digestHex")));
    assert_eq!(
        route.accounts_hash().unwrap(),
        hash32("c2738d079c61ccb2b7df067aab61f9bb7db67a49c4aad5fcc7b1777caf6eb551")
    );
}

#[test]
fn route_plan_clock_and_nearest_structural_failures_fail_closed() {
    let mut wrong_clock = fixture_input();
    wrong_clock.route_expiry_unit = ExpiryUnit::EvmUnixSeconds;
    assert_eq!(
        RoutePayload::new(wrong_clock).unwrap_err(),
        Error::from(ErrorCode::WireRouteClockMismatch)
    );

    let mut wrong_sequence = fixture_input();
    wrong_sequence.actions[0].sequence = 1;
    assert_eq!(
        RoutePayload::new(wrong_sequence).unwrap_err(),
        Error::from(ErrorCode::WireSequenceInvalid)
    );

    let mut duplicate_binding = fixture_input();
    duplicate_binding.account_bindings[1] = duplicate_binding.account_bindings[0].clone();
    assert_eq!(
        RoutePayload::new(duplicate_binding).unwrap_err(),
        Error::from(ErrorCode::WireCollectionDuplicate)
    );

    let mut unknown_binding = fixture_input();
    unknown_binding.actions[0].target_binding_id = id("missing-binding");
    assert_eq!(
        RoutePayload::new(unknown_binding).unwrap_err(),
        Error::from(ErrorCode::WireRouteReferenceUnknown)
    );
}

#[test]
fn raw_payload_template_hash_zeros_only_valid_declared_ranges() {
    let field = LateBoundField::new(LateBoundFieldKind::RouteHash, 2, 2).unwrap();
    assert_eq!(
        payload_template_hash(&[1, 2, 3, 4, 5, 6], &[field.clone()]).unwrap(),
        payload_template_hash(&[1, 2, 9, 9, 5, 6], &[field]).unwrap()
    );
    assert_eq!(
        payload_template_hash(
            &[1, 2, 3, 4, 5, 6],
            &[
                LateBoundField::new(LateBoundFieldKind::RouteHash, 1, 3).unwrap(),
                LateBoundField::new(LateBoundFieldKind::QuoteHash, 2, 2).unwrap(),
            ],
        )
        .unwrap_err(),
        Error::from(ErrorCode::WirePayloadRangeOverlap)
    );
    assert_eq!(
        payload_template_hash(
            &[1, 2, 3, 4, 5, 6],
            &[LateBoundField::new(LateBoundFieldKind::RouteHash, 5, 2).unwrap()],
        )
        .unwrap_err(),
        Error::from(ErrorCode::WirePayloadRangeInvalid)
    );
}

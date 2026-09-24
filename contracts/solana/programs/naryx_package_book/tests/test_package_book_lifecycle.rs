use anchor_lang::{prelude::Pubkey, AnchorSerialize};
use naryx_core::{DomainRef, ProtocolId};
use naryx_package_book::{
    constants::{
        MAX_QUOTE_LEVELS, PACKAGE_BOOK_VERSION, QUOTE_MODE_EXECUTION_COMMITMENT,
        QUOTE_MODE_FIRM_ONCHAIN, QUOTE_SIDE_ASK, QUOTE_SIDE_BID,
    },
    instructions::consume_capacity::{
        fill_commitment, validate_level_expectations, ConsumeCapacityArgs,
    },
    state::{
        domain_ref_identity, PackageBookClass, PackageQuoteShard, QuoteLevel, QuoteLevelUpdate,
    },
};

fn key(byte: u8) -> Pubkey {
    Pubkey::new_from_array([byte; 32])
}

fn class(domain: DomainRef) -> PackageBookClass {
    PackageBookClass {
        version: PACKAGE_BOOK_VERSION,
        domain_identity_hash: domain_ref_identity(&domain),
        domain,
        domain_manifest_version: 1,
        domain_manifest_hash: [13; 32],
        core_program: key(1),
        core_program_data: key(2),
        core_code_identity: [3; 32],
        consumer_program: key(4),
        consumer_program_data: key(5),
        consumer_code_identity: [6; 32],
        max_heartbeat_ttl_slots: 100,
        max_level_ttl_slots: 80,
        max_abs_reference_price: 1_000,
        max_abs_reference_offset: 100,
        max_fee_atoms: 20,
        firm_onchain_enabled: false,
        bump: 1,
    }
}

fn shard(domain: DomainRef) -> PackageQuoteShard {
    PackageQuoteShard {
        version: PACKAGE_BOOK_VERSION,
        domain,
        package_book_class: key(21),
        solver: key(7),
        solver_id: ProtocolId::new("solver:test:one").unwrap(),
        series_manifest_hash: [8; 32],
        execution_class_manifest_hash: [9; 32],
        core_program: key(1),
        core_program_data: key(2),
        core_code_identity: [3; 32],
        consumer_program: key(4),
        consumer_program_data: key(5),
        consumer_code_identity: [6; 32],
        reference_package_price: 100,
        reference_state_hash: [10; 32],
        reference_sequence: 1,
        shard_sequence: 1,
        heartbeat_expiry_slot: 50,
        epoch: 1,
        killed: false,
        level_count: 0,
        level_page_bump: 3,
        bump: 2,
    }
}

fn update(mode: u8) -> QuoteLevelUpdate {
    QuoteLevelUpdate {
        slot_index: 0,
        expected_level_sequence: 0,
        new_level_sequence: 1,
        level_id: 17,
        side: QUOTE_SIDE_BID,
        min_package_size_units: 2,
        max_package_size_units: 5,
        reference_offset: -3,
        max_fee_atoms: 7,
        settlement_class_identity_hash: [11; 32],
        quote_mode: mode,
        reservation_policy_hash: if mode == QUOTE_MODE_FIRM_ONCHAIN {
            [12; 32]
        } else {
            [0; 32]
        },
        expiry_slot: 40,
        remaining_capacity: 10,
    }
}

#[test]
fn quote_shard_lifecycle_is_sequence_safe_and_capacity_bounded() {
    let domain = DomainRef::new("solana:devnet:naryx-core-v1", 1, [13; 32]).unwrap();
    let class = class(domain.clone());
    let mut shard = shard(domain);
    let mut levels = [QuoteLevel::EMPTY; MAX_QUOTE_LEVELS];
    assert_eq!(
        class.domain_identity_hash,
        [
            0xfd, 0x9e, 0x05, 0x2d, 0x64, 0x4e, 0xc2, 0x6a, 0x93, 0x30, 0x85, 0xde, 0x74, 0x57,
            0x77, 0x27, 0x8e, 0x6a, 0xb8, 0xbd, 0xfa, 0x51, 0x3e, 0xfc, 0xeb, 0xee, 0xea, 0x3c,
            0xe7, 0x3e, 0xe0, 0x45,
        ]
    );

    shard
        .update_reference(&class, 1, 1, 105, [14; 32], 60, 10)
        .unwrap();
    assert_eq!(shard.reference_sequence, 2);
    assert_eq!(shard.shard_sequence, 2);
    assert_eq!(shard.level_count, 0);
    assert!(shard
        .update_reference(&class, 1, 2, 106, [15; 32], 61, 11)
        .is_err());

    let next_sequence = shard.next_shard_sequence(2).unwrap();
    shard
        .upsert_level(
            &mut levels,
            &class,
            update(QUOTE_MODE_EXECUTION_COMMITMENT),
            12,
        )
        .unwrap();
    shard.shard_sequence = next_sequence;
    assert_eq!(shard.shard_sequence, 3);
    assert_eq!(shard.level_count, 1);
    assert!(shard.next_shard_sequence(2).is_err());
    assert!(shard
        .validate_level(&class, &update(QUOTE_MODE_FIRM_ONCHAIN), 12)
        .is_err());

    let next_sequence = shard.next_shard_sequence(3).unwrap();
    let consumed = shard.consume_level(&mut levels, 0, 17, 1, 5, 20).unwrap();
    shard.shard_sequence = next_sequence;
    assert_eq!(levels[0].remaining_capacity, 5);
    assert_eq!(shard.level_count, 1);
    assert!(shard.consume_level(&mut levels, 0, 17, 1, 6, 20).is_err());

    let commitment = fill_commitment(
        &shard.domain,
        &key(16),
        &shard.solver,
        &shard.solver_id,
        &key(17),
        &shard.series_manifest_hash,
        &shard.execution_class_manifest_hash,
        &shard.reference_state_hash,
        &consumed,
        shard.reference_sequence,
        shard.shard_sequence,
        5,
        102,
        &[0; 32],
        &[18; 32],
        &[19; 32],
        &[20; 32],
    );
    assert_eq!(
        commitment,
        [
            0x54, 0x56, 0x64, 0x67, 0x15, 0x35, 0x63, 0xc6, 0xbb, 0x72, 0x72, 0xab, 0x38, 0x3a,
            0xa9, 0xe5, 0xfd, 0x8a, 0xcf, 0xfe, 0xad, 0xf7, 0xb1, 0x52, 0x81, 0x57, 0x79, 0x7b,
            0x2f, 0xed, 0x43, 0x7a,
        ]
    );

    let consume = ConsumeCapacityArgs {
        expected_reference_sequence: shard.reference_sequence,
        expected_shard_sequence: shard.shard_sequence,
        slot_index: 0,
        level_id: consumed.level_id,
        expected_level_sequence: consumed.level_sequence,
        expected_side: consumed.side,
        package_size_units: 5,
        expected_package_price: 102,
        expected_max_fee_atoms: consumed.max_fee_atoms,
        expected_expiry_slot: consumed.expiry_slot,
        expected_settlement_class_identity_hash: consumed.settlement_class_identity_hash,
        expected_quote_mode: consumed.quote_mode,
        expected_reservation_policy_hash: consumed.reservation_policy_hash,
        reservation_id: [0; 32],
        order_hash: [18; 32],
        quote_hash: [19; 32],
        route_hash: [20; 32],
    };
    let mut serialized = Vec::new();
    consume.serialize(&mut serialized).unwrap();
    let mut expected = Vec::new();
    expected.extend_from_slice(&consume.expected_reference_sequence.to_le_bytes());
    expected.extend_from_slice(&consume.expected_shard_sequence.to_le_bytes());
    expected.push(consume.slot_index);
    expected.extend_from_slice(&consume.level_id.to_le_bytes());
    expected.extend_from_slice(&consume.expected_level_sequence.to_le_bytes());
    expected.push(consume.expected_side);
    expected.extend_from_slice(&consume.package_size_units.to_le_bytes());
    expected.extend_from_slice(&consume.expected_package_price.to_le_bytes());
    expected.extend_from_slice(&consume.expected_max_fee_atoms.to_le_bytes());
    expected.extend_from_slice(&consume.expected_expiry_slot.to_le_bytes());
    expected.extend_from_slice(&consume.expected_settlement_class_identity_hash);
    expected.push(consume.expected_quote_mode);
    expected.extend_from_slice(&consume.expected_reservation_policy_hash);
    expected.extend_from_slice(&consume.reservation_id);
    expected.extend_from_slice(&consume.order_hash);
    expected.extend_from_slice(&consume.quote_hash);
    expected.extend_from_slice(&consume.route_hash);
    assert_eq!(serialized, expected);
    assert!(validate_level_expectations(&consumed, &consume, 102, false).is_ok());
    let mut wrong = consume;
    wrong.expected_package_price += 1;
    assert!(validate_level_expectations(&consumed, &wrong, 102, false).is_err());
    wrong = consume;
    wrong.expected_level_sequence += 1;
    assert!(validate_level_expectations(&consumed, &wrong, 102, false).is_err());
    wrong = consume;
    wrong.expected_side = QUOTE_SIDE_ASK;
    assert!(validate_level_expectations(&consumed, &wrong, 102, false).is_err());
    wrong = consume;
    wrong.expected_quote_mode = QUOTE_MODE_FIRM_ONCHAIN;
    assert!(validate_level_expectations(&consumed, &wrong, 102, false).is_err());
    wrong = consume;
    wrong.reservation_id = [21; 32];
    assert!(validate_level_expectations(&consumed, &wrong, 102, false).is_err());
    wrong = consume;
    wrong.expected_max_fee_atoms += 1;
    assert!(validate_level_expectations(&consumed, &wrong, 102, false).is_err());

    let next_sequence = shard.next_shard_sequence(4).unwrap();
    shard.cancel_level(&mut levels, 0, 17, 1).unwrap();
    shard.shard_sequence = next_sequence;
    assert_eq!(shard.level_count, 0);
    assert!(shard.cancel_level(&mut levels, 0, 17, 1).is_err());

    let previous_epoch = shard.epoch;
    shard.cancel_all().unwrap();
    assert_eq!(shard.epoch, previous_epoch + 1);
    assert_eq!(shard.level_count, 0);
}

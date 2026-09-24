use anchor_lang::prelude::Pubkey;
use naryx_core::{DomainRef, ProtocolId};
use naryx_inventory_reservation::{
    constants::{
        LIVE_PAIR_SEED, RESERVATION_ACTION_ENTRY, RESERVATION_CAPACITY_SEED,
        RESERVATION_CLASS_SEED, RESERVATION_SEED, RESERVATION_VAULT_SEED, RESERVATION_VERSION,
    },
    instructions::{domain_ref_identity, reservation_id},
    state::{
        validate_entry_deltas, FirmReservation, LivePair, ReservationCapacity, ReservationState,
    },
};

const ORDER_HASH: [u8; 32] = [0x11; 32];
const QUOTE_HASH: [u8; 32] = [0x22; 32];
const ROUTE_HASH: [u8; 32] = [0x33; 32];
const NONCE: [u8; 32] = [0x44; 32];

fn class_pda(
    domain: &DomainRef,
    base_mint: &Pubkey,
    quote_mint: &Pubkey,
    consumer_program: &Pubkey,
) -> Pubkey {
    let domain_identity = domain_ref_identity(domain);
    let manifest_version = domain.domain_manifest_version().to_be_bytes();
    let manifest_hash = domain.domain_manifest_hash();
    Pubkey::find_program_address(
        &[
            RESERVATION_CLASS_SEED,
            domain_identity.as_ref(),
            manifest_version.as_ref(),
            manifest_hash.as_ref(),
            base_mint.as_ref(),
            quote_mint.as_ref(),
            consumer_program.as_ref(),
        ],
        &naryx_inventory_reservation::id(),
    )
    .0
}

fn funded(
    expiry_slot: u64,
    reservation_class: Pubkey,
    domain: DomainRef,
    base_mint: Pubkey,
    quote_mint: Pubkey,
) -> FirmReservation {
    let solver_id = ProtocolId::new("solver:test:one").unwrap();
    let id = reservation_id(&domain, &solver_id, &ORDER_HASH, &NONCE);
    FirmReservation {
        version: RESERVATION_VERSION,
        reservation_class,
        domain,
        reservation_id: id,
        solver_id,
        solver: Pubkey::new_unique(),
        strategy_authority: Pubkey::new_unique(),
        package_nonce: 7,
        order_hash: ORDER_HASH,
        quote_hash: [0u8; 32],
        route_hash: ROUTE_HASH,
        reservation_nonce: NONCE,
        base_mint,
        quote_mint,
        solver_reclaim_base: Pubkey::new_unique(),
        solver_quote: Pubkey::new_unique(),
        strategy_base: Pubkey::new_unique(),
        strategy_quote: Pubkey::new_unique(),
        base_atoms: 10,
        quote_atoms: 25,
        expiry_slot,
        action: RESERVATION_ACTION_ENTRY,
        state: ReservationState::Funded,
        bump: 1,
        vault_bump: 2,
    }
}

#[test]
fn reservation_lifecycle_guards_and_accounting() {
    let historical_domain = DomainRef::new("solana:devnet:naryx-core-v1", 1, [0x55; 32]).unwrap();
    let replacement_domain = DomainRef::new("solana:devnet:naryx-core-v2", 1, [0x55; 32]).unwrap();
    let base_mint = Pubkey::new_unique();
    let alternate_base_mint = Pubkey::new_unique();
    let quote_mint = Pubkey::new_unique();
    let consumer_program = Pubkey::new_unique();
    assert_ne!(
        domain_ref_identity(&historical_domain),
        domain_ref_identity(&replacement_domain)
    );
    let historical_class = class_pda(
        &historical_domain,
        &base_mint,
        &quote_mint,
        &consumer_program,
    );
    let replacement_class = class_pda(
        &replacement_domain,
        &base_mint,
        &quote_mint,
        &consumer_program,
    );
    let alternate_asset_class = class_pda(
        &historical_domain,
        &alternate_base_mint,
        &quote_mint,
        &consumer_program,
    );
    assert_ne!(historical_class, replacement_class);
    assert_ne!(historical_class, alternate_asset_class);

    let mut reservation = funded(
        10,
        historical_class,
        historical_domain.clone(),
        base_mint,
        quote_mint,
    );
    let canonical_id = reservation.reservation_id;
    assert_ne!(canonical_id, [0u8; 32]);
    assert_ne!(
        canonical_id,
        reservation_id(
            &reservation.domain,
            &reservation.solver_id,
            &reservation.order_hash,
            &[0x45; 32],
        )
    );

    let mut capacity = ReservationCapacity {
        reservation_class: historical_class,
        solver: reservation.solver,
        reserved_base_atoms: 0,
        bump: 3,
    };
    let mut alternate_asset_capacity = ReservationCapacity {
        reservation_class: alternate_asset_class,
        solver: reservation.solver,
        reserved_base_atoms: 0,
        bump: 4,
    };
    let historical_live_pair = LivePair {
        reservation_class: historical_class,
        solver: reservation.solver,
        strategy_authority: reservation.strategy_authority,
        reservation_id: reservation.reservation_id,
        bump: 5,
    };
    let alternate_asset_live_pair = LivePair {
        reservation_class: alternate_asset_class,
        solver: reservation.solver,
        strategy_authority: reservation.strategy_authority,
        reservation_id: reservation.reservation_id,
        bump: 6,
    };
    assert_ne!(
        historical_live_pair.reservation_class,
        alternate_asset_live_pair.reservation_class
    );
    let historical_capacity_pda = Pubkey::find_program_address(
        &[
            RESERVATION_CAPACITY_SEED,
            historical_class.as_ref(),
            reservation.solver.as_ref(),
        ],
        &naryx_inventory_reservation::id(),
    )
    .0;
    let alternate_asset_capacity_pda = Pubkey::find_program_address(
        &[
            RESERVATION_CAPACITY_SEED,
            alternate_asset_class.as_ref(),
            reservation.solver.as_ref(),
        ],
        &naryx_inventory_reservation::id(),
    )
    .0;
    assert_ne!(historical_capacity_pda, alternate_asset_capacity_pda);
    for (seed, child_identity) in [
        (RESERVATION_SEED, reservation.reservation_id.as_ref()),
        (LIVE_PAIR_SEED, reservation.strategy_authority.as_ref()),
        (RESERVATION_VAULT_SEED, reservation.reservation_id.as_ref()),
    ] {
        let historical_child = Pubkey::find_program_address(
            &[
                seed,
                historical_class.as_ref(),
                reservation.solver.as_ref(),
                child_identity,
            ],
            &naryx_inventory_reservation::id(),
        )
        .0;
        let alternate_asset_child = Pubkey::find_program_address(
            &[
                seed,
                alternate_asset_class.as_ref(),
                reservation.solver.as_ref(),
                child_identity,
            ],
            &naryx_inventory_reservation::id(),
        )
        .0;
        assert_ne!(historical_child, alternate_asset_child);
    }
    capacity.reserve(reservation.base_atoms, 20).unwrap();
    alternate_asset_capacity.reserve(7, 20).unwrap();
    assert_eq!(capacity.reserved_base_atoms, 10);
    assert_eq!(alternate_asset_capacity.reserved_base_atoms, 7);
    assert!(capacity.reserve(11, 20).is_err());
    assert_eq!(capacity.reserved_base_atoms, 10);

    let mut v1_reservation = funded(
        10,
        historical_class,
        historical_domain.clone(),
        base_mint,
        quote_mint,
    );
    v1_reservation.version = 1;
    assert!(!v1_reservation.is_current_entry());
    assert!(v1_reservation
        .finalize(historical_class, QUOTE_HASH, 9)
        .is_err());
    assert!(v1_reservation
        .consume(historical_class, 7, ORDER_HASH, QUOTE_HASH, ROUTE_HASH, 9)
        .is_err());
    assert!(v1_reservation.release(historical_class, 10).is_err());
    assert_eq!(v1_reservation.state, ReservationState::Funded);

    assert!(reservation
        .finalize(replacement_class, QUOTE_HASH, 9)
        .is_err());
    assert_eq!(reservation.state, ReservationState::Funded);
    assert!(reservation
        .consume(historical_class, 7, ORDER_HASH, QUOTE_HASH, ROUTE_HASH, 9)
        .is_err());
    assert_eq!(reservation.state, ReservationState::Funded);
    reservation
        .finalize(historical_class, QUOTE_HASH, 9)
        .unwrap();
    assert_eq!(reservation.state, ReservationState::Live);
    assert!(reservation
        .finalize(historical_class, QUOTE_HASH, 9)
        .is_err());
    assert!(reservation
        .consume(replacement_class, 7, ORDER_HASH, QUOTE_HASH, ROUTE_HASH, 9)
        .is_err());
    assert_eq!(reservation.state, ReservationState::Live);
    assert!(reservation
        .consume(historical_class, 7, ORDER_HASH, [0x23; 32], ROUTE_HASH, 9)
        .is_err());
    assert_eq!(reservation.state, ReservationState::Live);
    assert!(reservation
        .consume(historical_class, 7, ORDER_HASH, QUOTE_HASH, ROUTE_HASH, 10)
        .is_err());
    reservation
        .consume(historical_class, 7, ORDER_HASH, QUOTE_HASH, ROUTE_HASH, 9)
        .unwrap();
    assert_eq!(reservation.state, ReservationState::Consumed);
    assert!(reservation
        .consume(historical_class, 7, ORDER_HASH, QUOTE_HASH, ROUTE_HASH, 9)
        .is_err());
    capacity.release(reservation.base_atoms).unwrap();
    assert_eq!(capacity.reserved_base_atoms, 0);
    assert!(capacity.release(1).is_err());

    let mut expired = funded(
        10,
        historical_class,
        historical_domain,
        base_mint,
        quote_mint,
    );
    assert!(expired.release(replacement_class, 10).is_err());
    assert!(expired.release(historical_class, 9).is_err());
    assert_eq!(expired.state, ReservationState::Funded);
    expired.release(historical_class, 10).unwrap();
    assert_eq!(expired.state, ReservationState::Released);
    assert!(expired.release(historical_class, 10).is_err());

    validate_entry_deltas(10, 25, 2, 12, 40, 15, 5, 30, 10, 0).unwrap();
    assert!(validate_entry_deltas(10, 25, 2, 11, 40, 15, 5, 30, 10, 0).is_err());
}

#[test]
fn reservation_id_matches_protocol_vector() {
    let domain = DomainRef::new("eip155:8453", 7, [0x11; 32]).unwrap();
    let solver_id = ProtocolId::new("solver-alpha").unwrap();
    let mut nonce = [0u8; 32];
    nonce[31] = 42;
    assert_eq!(
        domain_ref_identity(&domain),
        [
            0x5c, 0x33, 0x67, 0xef, 0x36, 0x47, 0x5e, 0xc1, 0x1a, 0xd5, 0xb3, 0x92, 0xfc, 0x85,
            0xa3, 0x49, 0xb3, 0x7d, 0x2f, 0xda, 0xd6, 0x31, 0xc8, 0xda, 0x83, 0x3a, 0xa0, 0x79,
            0x68, 0x97, 0xc1, 0x4c,
        ]
    );
    assert_eq!(
        reservation_id(&domain, &solver_id, &[0x22; 32], &nonce),
        [
            0x82, 0x41, 0x72, 0x88, 0x52, 0xcb, 0x44, 0x0e, 0x70, 0xea, 0x75, 0x80, 0x18, 0x94,
            0xdd, 0x27, 0x5a, 0xd2, 0x06, 0x10, 0x76, 0xce, 0xee, 0xc9, 0x6b, 0xb4, 0xe6, 0x6b,
            0x78, 0x8d, 0x99, 0xd1,
        ]
    );
}

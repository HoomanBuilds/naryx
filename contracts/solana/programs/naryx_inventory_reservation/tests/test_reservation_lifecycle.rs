use anchor_lang::prelude::Pubkey;
use naryx_core::{DomainRef, ProtocolId};
use naryx_inventory_reservation::{
    constants::{RESERVATION_ACTION_ENTRY, RESERVATION_VERSION},
    instructions::reservation_id,
    state::{validate_entry_deltas, FirmReservation, ReservationCapacity, ReservationState},
};

const ORDER_HASH: [u8; 32] = [0x11; 32];
const QUOTE_HASH: [u8; 32] = [0x22; 32];
const ROUTE_HASH: [u8; 32] = [0x33; 32];
const NONCE: [u8; 32] = [0x44; 32];

fn funded(expiry_slot: u64) -> FirmReservation {
    let domain = DomainRef::new("solana:devnet:naryx-core-v1", 1, [0x55; 32]).unwrap();
    let solver_id = ProtocolId::new("solver:test:one").unwrap();
    let id = reservation_id(&domain, &solver_id, &ORDER_HASH, &NONCE);
    FirmReservation {
        version: RESERVATION_VERSION,
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
        base_mint: Pubkey::new_unique(),
        quote_mint: Pubkey::new_unique(),
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
    let mut reservation = funded(10);
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
        solver: reservation.solver,
        reserved_base_atoms: 0,
        bump: 3,
    };
    capacity.reserve(reservation.base_atoms, 20).unwrap();
    assert_eq!(capacity.reserved_base_atoms, 10);
    assert!(capacity.reserve(11, 20).is_err());
    assert_eq!(capacity.reserved_base_atoms, 10);

    assert!(reservation
        .consume(7, ORDER_HASH, QUOTE_HASH, ROUTE_HASH, 9)
        .is_err());
    assert_eq!(reservation.state, ReservationState::Funded);
    reservation.finalize(QUOTE_HASH, 9).unwrap();
    assert_eq!(reservation.state, ReservationState::Live);
    assert!(reservation.finalize(QUOTE_HASH, 9).is_err());
    assert!(reservation
        .consume(7, ORDER_HASH, [0x23; 32], ROUTE_HASH, 9)
        .is_err());
    assert_eq!(reservation.state, ReservationState::Live);
    assert!(reservation
        .consume(7, ORDER_HASH, QUOTE_HASH, ROUTE_HASH, 10)
        .is_err());
    reservation
        .consume(7, ORDER_HASH, QUOTE_HASH, ROUTE_HASH, 9)
        .unwrap();
    assert_eq!(reservation.state, ReservationState::Consumed);
    assert!(reservation
        .consume(7, ORDER_HASH, QUOTE_HASH, ROUTE_HASH, 9)
        .is_err());
    capacity.release(reservation.base_atoms).unwrap();
    assert_eq!(capacity.reserved_base_atoms, 0);
    assert!(capacity.release(1).is_err());

    let mut expired = funded(10);
    assert!(expired.release(9).is_err());
    assert_eq!(expired.state, ReservationState::Funded);
    expired.release(10).unwrap();
    assert_eq!(expired.state, ReservationState::Released);
    assert!(expired.release(10).is_err());

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
        reservation_id(&domain, &solver_id, &[0x22; 32], &nonce),
        [
            0x82, 0x41, 0x72, 0x88, 0x52, 0xcb, 0x44, 0x0e, 0x70, 0xea, 0x75, 0x80, 0x18, 0x94,
            0xdd, 0x27, 0x5a, 0xd2, 0x06, 0x10, 0x76, 0xce, 0xee, 0xc9, 0x6b, 0xb4, 0xe6, 0x6b,
            0x78, 0x8d, 0x99, 0xd1,
        ]
    );
}

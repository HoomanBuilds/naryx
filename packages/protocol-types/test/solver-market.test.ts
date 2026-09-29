import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  decideRfq,
  disputeBondClaim,
  fileBondClaim,
  generateMakerQuotes,
  makerQuoteSurface,
  openPerformanceBond,
  releasePerformanceBond,
  settleBondClaim,
  toHex,
  type MakerQuoteSurfaceInput,
  type RfqRequest,
  type RfqResponse,
} from '../src/index.js';
import { DOMAIN, USD, key, manifestInput } from './solver-fixtures.js';

const id = (n: number): string => n.toString(16).padStart(64, '0');

describe('multi-dealer RFQ decision', () => {
  const request: RfqRequest = {
    environment: 'local',
    orderHash: id(1),
    domain: DOMAIN,
    templateId: 'cash-and-carry-v1',
    marketId: 'sol-carry',
    notionalAtoms: 500n,
    invitedSolverIds: ['solver-a', 'solver-b', 'solver-c', 'solver-g'],
    responseDeadlineValue: 60n,
    atValue: 50n,
  };
  const manifests = [
    manifestInput(),
    manifestInput({ solverId: 'solver-b', commonControlGroupId: 'org-b' }),
    manifestInput({ solverId: 'solver-c', commonControlGroupId: 'org-a' }),
    manifestInput({ solverId: 'solver-g', commonControlGroupId: 'org-g' }),
  ];
  const response = (solverId: string, n: number, overrides: Partial<RfqResponse> = {}): RfqResponse => ({
    solverId,
    quoteHash: id(n),
    quoteMode: 'IMPLIED',
    settlementClass: 'ATOMIC_POSTCONDITION',
    riskClassId: 'EXACT_ATOMIC',
    scheme: 'ED25519',
    verificationKey: key(2),
    netOutcomeAtoms: 100n,
    validUntilValue: 90n,
    receivedAtValue: 10n,
    ...overrides,
  });
  const responses = [
    response('solver-a', 10, { netOutcomeAtoms: 105n }),
    response('solver-b', 11, { netOutcomeAtoms: 105n, quoteMode: 'FIRM_ONCHAIN', receivedAtValue: 12n }),
    response('solver-c', 12, { netOutcomeAtoms: 90n, riskClassId: 'BOUNDED_NET_A' }),
    response('solver-a', 13, { netOutcomeAtoms: 999n, receivedAtValue: 11n }),
    response('solver-d', 14),
    response('solver-g', 15, { quoteMode: 'FIRM_ONCHAIN' }),
  ];
  const capacities = [
    { solverId: 'solver-b', state: 'ACTIVE' as const, remainingAtoms: 500n },
    { solverId: 'solver-g', state: 'ACTIVE' as const, remainingAtoms: 499n },
  ];

  test('ranks inside each class and excludes everything else with one reason', () => {
    const decision = decideRfq(request, responses, manifests, capacities);
    assert.deepEqual(
      decision.groups.map((group) => [group.riskClassId, group.ranked.map((item) => [item.rank, item.solverId])]),
      [
        ['BOUNDED_NET_A', [[1, 'solver-c']]],
        ['EXACT_ATOMIC', [[1, 'solver-b'], [2, 'solver-a']]],
      ],
    );
    assert.deepEqual(
      decision.excluded.map((item) => [item.solverId, item.reason]),
      [
        ['solver-d', 'NOT_INVITED'],
        ['solver-g', 'CAPACITY_UNAVAILABLE'],
        ['solver-a', 'DUPLICATE_SOLVER_RESPONSE'],
      ],
    );
    assert.equal(decision.independentOrganizations, 2);
  });

  test('the decision replays byte for byte and moves with its inputs', () => {
    const first = decideRfq(request, responses, manifests, capacities);
    const again = decideRfq(request, [...responses].reverse(), [...manifests].reverse(), capacities);
    assert.equal(toHex(again.decisionHash), toHex(first.decisionHash));
    const later = decideRfq({ ...request, atValue: 55n, responseDeadlineValue: 10n }, responses, manifests, capacities);
    assert.notEqual(toHex(later.decisionHash), toHex(first.decisionHash));
    assert.equal(later.excluded.filter((item) => item.reason === 'LATE_RESPONSE').length, 4);
  });

  test('expired quotes, unknown manifests, and scope violations exclude', () => {
    const decision = decideRfq(
      { ...request, invitedSolverIds: ['solver-a', 'solver-b', 'solver-x'] },
      [
        response('solver-a', 20, { validUntilValue: 50n }),
        response('solver-b', 21, { quoteMode: 'EXECUTION_COMMITMENT' }),
        response('solver-x', 22),
      ],
      manifests,
      capacities,
    );
    assert.deepEqual(
      decision.excluded.map((item) => item.reason).sort(),
      ['MANIFEST_UNKNOWN', 'QUOTE_EXPIRED', 'QUOTE_MODE_UNSUPPORTED'],
    );
    assert.equal(decision.groups.length, 0);
  });
});

describe('maker quote surfaces', () => {
  const surface: MakerQuoteSurfaceInput = {
    version: 1,
    solverId: 'solver-a',
    executionClassId: 'sol-carry-atomic-v1',
    levels: [
      { levelId: 1n, side: 'BID', sizeUnits: 10n, offsetTicks: -2n },
      { levelId: 2n, side: 'BID', sizeUnits: 10n, offsetTicks: -5n },
      { levelId: 3n, side: 'ASK', sizeUnits: 10n, offsetTicks: 2n },
    ],
    skewTicksPerInventoryUnit: 1n,
    maximumInventoryUnits: 15n,
    maximumLevelSizeUnits: 10n,
    marketKillSwitch: false,
    portfolioKillSwitch: false,
  };

  test('prices every level from one reference and skews against inventory', () => {
    const flat = generateMakerQuotes(surface, 100n, 0n);
    assert.deepEqual(flat.map((quote) => [quote.levelId, quote.priceTicks, quote.sizeUnits]), [[1n, 98n, 10n], [2n, 95n, 5n], [3n, 102n, 10n]]);
    const moved = generateMakerQuotes(surface, 110n, 0n);
    assert.deepEqual(moved.map((quote) => quote.priceTicks - 10n), flat.map((quote) => quote.priceTicks));
    const long = generateMakerQuotes(surface, 100n, 5n);
    assert.deepEqual(long.map((quote) => [quote.levelId, quote.priceTicks, quote.sizeUnits]), [[1n, 93n, 10n], [3n, 97n, 10n]]);
  });

  test('inventory limits and kill switches stop the risky side or everything', () => {
    assert.deepEqual(generateMakerQuotes(surface, 100n, 15n).map((quote) => quote.side), ['ASK']);
    assert.deepEqual(generateMakerQuotes(surface, 100n, -15n).map((quote) => quote.side), ['BID', 'BID']);
    assert.equal(generateMakerQuotes({ ...surface, marketKillSwitch: true }, 100n, 0n).length, 0);
    assert.equal(generateMakerQuotes({ ...surface, portfolioKillSwitch: true }, 100n, 0n).length, 0);
  });

  test('a self-crossing or oversized surface rejects', () => {
    const crossing = { ...surface, levels: [...surface.levels, { levelId: 4n, side: 'ASK' as const, sizeUnits: 1n, offsetTicks: -2n }] };
    assert.throws(() => makerQuoteSurface(crossing), /crosses itself/);
    assert.throws(() => makerQuoteSurface({ ...surface, maximumLevelSizeUnits: 9n }), /above the surface maximum/);
    assert.throws(() => makerQuoteSurface({ ...surface, skewTicksPerInventoryUnit: -1n }), /lean against inventory/);
  });
});

describe('performance bonds', () => {
  const bond = () =>
    openPerformanceBond({
      version: 1,
      bondId: id(1),
      solverId: 'solver-a',
      asset: USD,
      bondAtoms: 100n,
      coveredFaults: ['FAILED_TO_HONOR_FUNDED_RESERVATION'],
      maximumPayoutPerClaimAtoms: 60n,
      disputeWindowValue: 10n,
      expiresAtValue: 1_000n,
    });
  const claim = (n: number, payoutAtoms = 50n, atValue = 5n) => ({
    faultEvidenceHash: id(n),
    fault: 'FAILED_TO_HONOR_FUNDED_RESERVATION' as const,
    payoutAtoms,
    atValue,
  });

  test('only objective covered faults within caps can claim, and evidence claims once', () => {
    let ledger = fileBondClaim(bond(), claim(2));
    assert.throws(() => fileBondClaim(ledger, claim(2)), /already claimed/);
    assert.throws(() => fileBondClaim(ledger, { ...claim(3), fault: 'SUBMITTED_OFF_ROUTE' }), /does not cover/);
    assert.throws(() => fileBondClaim(ledger, claim(3, 61n)), /per-claim cap/);
    assert.throws(() => fileBondClaim(ledger, claim(3, 51n)), /unencumbered bond/);
    ledger = fileBondClaim(ledger, claim(3, 50n));
    assert.throws(() => fileBondClaim(ledger, claim(4, 1n)), /unencumbered bond/);
    assert.throws(() => fileBondClaim(bond(), claim(5, 1n, 1_000n)), /expired/);
  });

  test('claims pay after an undisputed window or an explicit resolution', () => {
    let ledger = fileBondClaim(fileBondClaim(bond(), claim(2)), claim(3, 40n));
    assert.throws(() => settleBondClaim(ledger, id(2), 14n), /still open/);
    ledger = settleBondClaim(ledger, id(2), 15n);
    ledger = disputeBondClaim(ledger, id(3), 14n);
    assert.throws(() => settleBondClaim(ledger, id(3), 20n), /needs a resolution/);
    ledger = settleBondClaim(ledger, id(3), 20n, true);
    assert.deepEqual(ledger.claims.map((item) => item.state), ['PAID', 'REJECTED']);
    assert.throws(() => settleBondClaim(ledger, id(2), 20n), /already final/);
    assert.throws(() => disputeBondClaim(fileBondClaim(bond(), claim(4)), id(4), 15n), /dispute window/);
  });

  test('release waits for expiry and open claims, then returns the unpaid remainder once', () => {
    let ledger = fileBondClaim(bond(), claim(2, 30n));
    assert.throws(() => releasePerformanceBond(ledger, 999n), /not expired/);
    assert.throws(() => releasePerformanceBond(ledger, 1_000n), /open claims/);
    ledger = settleBondClaim(ledger, id(2), 20n);
    const released = releasePerformanceBond(ledger, 1_000n);
    assert.equal(released.returnedAtoms, 70n);
    assert.throws(() => releasePerformanceBond(released.ledger, 1_001n), /already released/);
    assert.throws(() => fileBondClaim(released.ledger, claim(3, 1n, 20n)), /released or expired/);
  });
});

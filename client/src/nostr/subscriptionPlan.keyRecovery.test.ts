import {buildSpaceKeyRecoveryFilters} from './subscriptionPlan';
import {Kind} from './events';

/**
 * buildSpaceKeyRecoveryFilters — the two filters that ride a group's on-open scoped sub to heal a
 * dark private space (OPEN_ITEMS §3.1): re-fetch the space's kind-30079 key deliveries (the
 * standing space-keys sub's GLOBAL `since` can pin itself above a delivery this member never got —
 * the message backfill's since-poisoning shape), and pull stranded members' key-redelivery request
 * docs so a keyed admin opening the space can answer them. The anonymity property pinned here is
 * load-bearing: NEITHER filter may carry `#p` — a bare `#p:[me]` REQ on the relay connection would
 * deanonymize the member (deliveries addressed to others simply fail to unwrap client-side).
 */
describe('buildSpaceKeyRecoveryFilters', () => {
  it('returns exactly the 30079-by-#h backfill and the exact-d request filter', () => {
    const filters = buildSpaceKeyRecoveryFilters('grp1');
    expect(filters).toHaveLength(2);

    const deliveries = filters[0]!;
    const requests = filters[1]!;
    expect(deliveries.kinds).toEqual([Kind.SpaceKeyDelivery]);
    expect(deliveries['#h']).toEqual(['grp1']);
    expect(typeof deliveries.limit).toBe('number'); // bounded — never an unbounded cold REQ over Tor
    expect(deliveries.since).toBeUndefined(); // a since would recreate the poisoning this heals

    expect(requests.kinds).toEqual([Kind.AppData]);
    expect(requests['#d']).toEqual(['space-key-request:grp1']); // the EXACT d the builder emits
  });

  it('never scopes by #p — the member must not be revealed on this connection', () => {
    for (const f of buildSpaceKeyRecoveryFilters('grp1')) {
      expect(f['#p']).toBeUndefined();
      expect(f.authors).toBeUndefined();
    }
  });
});

package relayapp

import (
	"bytes"
	"encoding/json"
)

// zeroedCreatedAtLimits are the two NIP-11 limitation fields go-nostr declares WITHOUT `omitempty`
// (nip11.RelayLimitationDocument), so they are emitted on every document whether or not the relay
// enforces a created_at window. This relay enforces none.
//
// An emitted zero is not a harmless default here. Read against NIP-11's own definition —
// created_at_upper_limit is "the newest created_at a relay will accept" — `"created_at_upper_limit":0`
// says this relay rejects everything timestamped after 1 January 1970. A conservative client that
// honours advertised limits would conclude it cannot publish at all; over Tor, the alternative to
// honouring them is to find out with a round-trip. Omitting an optional field is the encoding for
// "no limit", which is the truth.
var zeroedCreatedAtLimits = []string{"created_at_lower_limit", "created_at_upper_limit"}

// PruneNIP11Limitation takes the marshalled NIP-11 `limitation` object and returns it with any
// created_at bound that is zero removed. A non-zero bound is left alone, so this stays correct if a
// created_at window is ever actually enforced.
//
// It returns ok=false and leaves the caller's bytes untouched on anything unexpected, so a NIP-11
// request always gets a valid document even if the shape upstream changes.
func PruneNIP11Limitation(raw json.RawMessage) (json.RawMessage, bool) {
	if len(bytes.TrimSpace(raw)) == 0 {
		return raw, false
	}
	var lim map[string]json.RawMessage
	if err := json.Unmarshal(raw, &lim); err != nil {
		return raw, false
	}
	pruned := false
	for _, key := range zeroedCreatedAtLimits {
		v, ok := lim[key]
		if !ok {
			continue
		}
		var n json.Number
		if err := json.Unmarshal(v, &n); err != nil {
			continue // not a number — leave whatever it is alone
		}
		if n.String() == "0" {
			delete(lim, key)
			pruned = true
		}
	}
	if !pruned {
		return raw, false
	}
	out, err := json.Marshal(lim)
	if err != nil {
		return raw, false
	}
	return out, true
}

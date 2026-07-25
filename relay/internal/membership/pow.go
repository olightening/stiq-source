package membership

// NIP-13 proof-of-work helpers. Used to gate kind-1059 gift wraps (NIP-17 DMs), whose
// outer signer is an ephemeral key and so can't be a bound member (PLAN.md §4.1, option b).
// Requiring PoW keeps DM spam expensive without identifying senders.

// LeadingZeroBits counts the leading zero bits of a hex-encoded event id (the NIP-13
// difficulty).
func LeadingZeroBits(idHex string) int {
	count := 0
	for _, c := range idHex {
		nibble := hexNibble(c)
		if nibble < 0 {
			break // non-hex char: stop
		}
		if nibble == 0 {
			count += 4
			continue
		}
		// Leading zeros within this 4-bit nibble.
		for mask := 0x8; mask > 0; mask >>= 1 {
			if nibble&mask != 0 {
				break
			}
			count++
		}
		break
	}
	return count
}

func hexNibble(c rune) int {
	switch {
	case c >= '0' && c <= '9':
		return int(c - '0')
	case c >= 'a' && c <= 'f':
		return int(c-'a') + 10
	case c >= 'A' && c <= 'F':
		return int(c-'A') + 10
	default:
		return -1
	}
}

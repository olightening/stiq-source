package membership

import "testing"

func TestLeadingZeroBits(t *testing.T) {
	cases := map[string]int{
		"ffff": 0,
		"7fff": 1,
		"0fff": 4,
		"00ff": 8,
		"01ff": 7,
		"000f": 12,
		"0000": 16,
		"8000": 0,
		"":     0,
	}
	for id, want := range cases {
		if got := LeadingZeroBits(id); got != want {
			t.Errorf("LeadingZeroBits(%q) = %d, want %d", id, got, want)
		}
	}
}

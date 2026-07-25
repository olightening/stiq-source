// Command repair-groups is a one-shot offline repair for the NIP-29 groups.json roster file.
//
// Background: a buggy client once wrote a 63-char bech32 "npub1..." string (instead of the
// 64-char lowercase-hex pubkey) into some groups' Members/Admins maps via a 9000 (AddUser)
// event. That garbage entry is persisted straight into groups.json and re-emitted forever in
// the relay's 39001/39002 state events — it is reinstall-proof and, before this tool, could
// only be cleared one group at a time by an admin issuing a RemoveUser (9001) targeting the
// exact garbage string. This tool clears every group in one pass instead.
//
// groups.json is loaded fresh from disk by the relay on startup (see
// internal/groups.LoadStore) and is otherwise only mutated (and re-saved) in-process as
// management events are applied — it is NOT rebuilt from an event log. That means editing the
// file directly and restarting the relay is safe and sufficient; there is no replay step that
// would clobber the edit.
//
// Usage:
//
//	# Build (from the relay/ module root):
//	go build -o repair-groups ./cmd/repair-groups
//
//	# 1. STOP the relay first (it re-saves this file on every group mutation; editing it
//	#    while the relay is running risks a lost update if the relay writes in between).
//
//	# 2. Dry run (default): reports what WOULD be removed, writes nothing.
//	./repair-groups -file /path/to/data/groups.json
//
//	# 3. Inspect the report. If it looks right, apply for real:
//	./repair-groups -file /path/to/data/groups.json -apply
//
//	#    This first copies the untouched original to
//	#    /path/to/data/groups.json.bak-<UTC timestamp>
//	#    and only then writes the cleaned file (atomically: temp file + rename).
//
//	# 4. Restart the relay. The next 39001/39002 emission for each affected group will be
//	#    clean.
//
// Only Members/Admins entries are touched, and only the malformed ones (anything that is not
// exactly 64 lowercase hex digits, i.e. does not match ^[0-9a-f]{64}$ — the same rule the relay
// enforces on new AddUser targets in internal/groups/groups.go's isHexPubkey). Every other
// field of every group (id, name, owner, closed, private, pending, interactions, ...) is
// round-tripped byte-for-byte unchanged: this tool decodes the file generically (as nested
// map[string]interface{}) rather than re-typing the relay's Group struct, specifically so it
// cannot silently drop or reshape a field it doesn't know about.
//
// The group's Owner field is deliberately never touched or removed by this tool even if it is
// (unexpectedly) non-hex: Owner can only ever be set from event.PubKey (always a valid hex key)
// or via an ownership-transfer AddUser target that itself passed isHexPubkey, so there is no
// known code path that corrupts it. If this tool finds one anyway, it prints a warning instead
// of guessing at a fix.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"time"
)

// hexPubkeyRE mirrors internal/groups/groups.go's isHexPubkey: exactly 64 lowercase hex digits.
var hexPubkeyRE = regexp.MustCompile(`^[0-9a-f]{64}$`)

func main() {
	filePath := flag.String("file", "", "path to the relay's groups.json (required)")
	apply := flag.Bool("apply", false, "actually write the cleaned file (default: dry-run report only)")
	flag.Parse()

	if *filePath == "" {
		fmt.Fprintln(os.Stderr, "repair-groups: -file <path-to-groups.json> is required")
		flag.Usage()
		os.Exit(2)
	}

	original, err := os.ReadFile(*filePath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "repair-groups: reading %s: %v\n", *filePath, err)
		os.Exit(1)
	}

	// Decode generically: group ID -> arbitrary JSON object. This preserves every field of
	// every group exactly as written, including ones this tool doesn't know about, since we
	// only ever reach into the "admins"/"members" sub-objects.
	var groups map[string]map[string]interface{}
	if err := json.Unmarshal(original, &groups); err != nil {
		fmt.Fprintf(os.Stderr, "repair-groups: parsing %s: %v (not touching the file)\n", *filePath, err)
		os.Exit(1)
	}

	type removal struct {
		groupID string
		field   string // "admins" or "members"
		key     string
	}
	var removals []removal
	var ownerWarnings []string

	// Deterministic order for readable, stable reports.
	groupIDs := make([]string, 0, len(groups))
	for id := range groups {
		groupIDs = append(groupIDs, id)
	}
	sort.Strings(groupIDs)

	for _, id := range groupIDs {
		g := groups[id]
		if owner, ok := g["owner"].(string); ok && owner != "" && !hexPubkeyRE.MatchString(owner) {
			ownerWarnings = append(ownerWarnings, fmt.Sprintf("group %q: owner %q is not valid hex — NOT modified (needs manual review)", id, owner))
		}
		for _, field := range []string{"admins", "members"} {
			set, ok := g[field].(map[string]interface{})
			if !ok {
				continue
			}
			keys := make([]string, 0, len(set))
			for k := range set {
				keys = append(keys, k)
			}
			sort.Strings(keys)
			for _, k := range keys {
				if !hexPubkeyRE.MatchString(k) {
					removals = append(removals, removal{groupID: id, field: field, key: k})
					delete(set, k)
				}
			}
		}
	}

	if len(ownerWarnings) > 0 {
		fmt.Println("WARNINGS (not modified):")
		for _, w := range ownerWarnings {
			fmt.Println("  " + w)
		}
		fmt.Println()
	}

	if len(removals) == 0 {
		fmt.Println("No malformed (non-hex) Members/Admins entries found. Nothing to do.")
		return
	}

	fmt.Printf("Found %d malformed roster entr%s to remove:\n", len(removals), pluralIes(len(removals)))
	for _, r := range removals {
		fmt.Printf("  group %q: remove %s[%q]\n", r.groupID, r.field, r.key)
	}

	if !*apply {
		fmt.Println()
		fmt.Println("Dry run only — nothing was written. Re-run with -apply to make this change.")
		return
	}

	// Back up the untouched original before writing anything.
	backupPath := *filePath + ".bak-" + time.Now().UTC().Format("20060102T150405Z")
	if err := os.WriteFile(backupPath, original, 0o600); err != nil {
		fmt.Fprintf(os.Stderr, "repair-groups: failed to write backup %s: %v (aborting, original file untouched)\n", backupPath, err)
		os.Exit(1)
	}
	fmt.Printf("Backed up original to %s\n", backupPath)

	cleaned, err := json.Marshal(groups)
	if err != nil {
		fmt.Fprintf(os.Stderr, "repair-groups: re-encoding cleaned state: %v (aborting, original file untouched)\n", err)
		os.Exit(1)
	}

	if err := writeFileAtomic(*filePath, cleaned, 0o600); err != nil {
		fmt.Fprintf(os.Stderr, "repair-groups: writing %s: %v\n", *filePath, err)
		fmt.Fprintf(os.Stderr, "the untouched original is still safe at the backup: %s\n", backupPath)
		os.Exit(1)
	}

	fmt.Printf("Wrote cleaned state to %s. Restart the relay to pick it up.\n", *filePath)
}

func pluralIes(n int) string {
	if n == 1 {
		return "y"
	}
	return "ies"
}

// writeFileAtomic writes data to a temp file in the target's directory, fsyncs it, then renames
// it over the target, so a crash mid-write can never leave a half-written groups.json (mirrors
// the relay's own internal/groups.writeFileAtomic).
func writeFileAtomic(path string, data []byte, perm os.FileMode) error {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, "."+filepath.Base(path)+".tmp-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer func() { _ = os.Remove(tmpName) }()

	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Chmod(perm); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpName, path)
}

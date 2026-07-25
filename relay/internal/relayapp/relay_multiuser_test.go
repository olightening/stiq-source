package relayapp

import (
	"encoding/json"
	"strconv"
	"time"

	"testing"

	"github.com/gorilla/websocket"
	"github.com/nbd-wtf/go-nostr"

	"github.com/stiq/relay/internal/membership"
)

// signedFull builds and signs an event with an explicit kind, content, and tags.
func signedFull(t *testing.T, sk string, kind int, content string, tags nostr.Tags) *nostr.Event {
	t.Helper()
	ev := &nostr.Event{Kind: kind, CreatedAt: nostr.Now(), Tags: tags, Content: content}
	if err := ev.Sign(sk); err != nil {
		t.Fatalf("Sign: %v", err)
	}
	return ev
}

// collect opens a REQ, gathers the IDs of every EVENT the relay replays before EOSE, then
// returns them. This is the cross-user delivery probe: a DIFFERENT identity/connection asking
// the relay for an author's stored events and seeing them come back.
func collect(t *testing.T, wsURL string, filter map[string]any) []string {
	t.Helper()
	c, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer c.Close()

	payload, err := json.Marshal([]any{"REQ", "s", filter})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	_ = c.SetWriteDeadline(time.Now().Add(5 * time.Second))
	if err := c.WriteMessage(websocket.TextMessage, payload); err != nil {
		t.Fatalf("write: %v", err)
	}

	var ids []string
	_ = c.SetReadDeadline(time.Now().Add(5 * time.Second))
	for {
		_, data, err := c.ReadMessage()
		if err != nil {
			t.Fatalf("read (collected %d so far): %v", len(ids), err)
		}
		var frame []json.RawMessage
		if err := json.Unmarshal(data, &frame); err != nil || len(frame) < 1 {
			continue
		}
		var typ string
		_ = json.Unmarshal(frame[0], &typ)
		switch typ {
		case "EVENT":
			if len(frame) >= 3 {
				var ev nostr.Event
				if err := json.Unmarshal(frame[2], &ev); err == nil {
					ids = append(ids, ev.ID)
				}
			}
		case "EOSE":
			return ids
		case "CLOSED":
			var msg string
			if len(frame) > 2 {
				_ = json.Unmarshal(frame[2], &msg)
			}
			t.Fatalf("REQ closed before EOSE: %q", msg)
		}
	}
}

func contains(ids []string, id string) bool {
	for _, x := range ids {
		if x == id {
			return true
		}
	}
	return false
}

// minedGiftWrapTo mines a NIP-17 gift wrap (kind 1059) addressed (#p) to a recipient at the
// given NIP-13 difficulty, so the recipient can retrieve it from their DM inbox subscription.
func minedGiftWrapTo(t *testing.T, difficulty int, recipientPK string) *nostr.Event {
	t.Helper()
	sk := nostr.GeneratePrivateKey()
	for nonce := 0; ; nonce++ {
		ev := &nostr.Event{
			Kind:      1059,
			CreatedAt: nostr.Now(),
			Tags:      nostr.Tags{{"p", recipientPK}, {"nonce", strconv.Itoa(nonce), strconv.Itoa(difficulty)}},
			Content:   "sealed",
		}
		if err := ev.Sign(sk); err != nil {
			t.Fatalf("Sign: %v", err)
		}
		if membership.LeadingZeroBits(ev.ID) >= difficulty {
			return ev
		}
	}
}

// TestMultiUserExchange is the backend's core multi-user guarantee: two distinct bound members
// can SEE each other's content. Alice publishes; Bob (a separate identity and connection)
// retrieves. Every kind that carries cross-user social activity is exercised end-to-end:
// post, reaction, comment, article, poll + response, report, and a NIP-17 DM. PoW=8 enables DMs.
func TestMultiUserExchange(t *testing.T) {
	issuerSK, issuerPEM := issuerKeyPEM(t)
	ws := newTestRelayWithPoW(t, issuerPEM, 8)

	aliceSK, alicePK := bindMember(t, ws, issuerSK)
	bobSK, bobPK := bindMember(t, ws, issuerSK)

	// 1. POST — Alice posts; Bob retrieves it scoped by author.
	post := signed(t, aliceSK, 1, "alice's first post")
	if ok, msg := publish(t, ws, post); !ok {
		t.Fatalf("post rejected: %q", msg)
	}
	if got := collect(t, ws, map[string]any{"kinds": []int{1}, "authors": []string{alicePK}}); !contains(got, post.ID) {
		t.Fatalf("Bob could not retrieve Alice's post (got %d events)", len(got))
	}

	// 2. REACTION — Bob upvotes Alice's post; the vote is retrievable by #e (post tally).
	vote := signedFull(t, bobSK, 7, "+", nostr.Tags{{"e", post.ID}, {"p", alicePK}})
	if ok, msg := publish(t, ws, vote); !ok {
		t.Fatalf("reaction rejected: %q", msg)
	}
	if got := collect(t, ws, map[string]any{"kinds": []int{7}, "#e": []string{post.ID}}); !contains(got, vote.ID) {
		t.Fatalf("Alice could not see Bob's upvote")
	}

	// 3. COMMENT — Bob replies (NIP-22 kind 1111); the thread is retrievable by #e.
	comment := signedFull(t, bobSK, 1111, "great post", nostr.Tags{{"e", post.ID}, {"p", alicePK}, {"k", "1"}})
	if ok, msg := publish(t, ws, comment); !ok {
		t.Fatalf("comment rejected: %q", msg)
	}
	if got := collect(t, ws, map[string]any{"kinds": []int{1111}, "#e": []string{post.ID}}); !contains(got, comment.ID) {
		t.Fatalf("comment not retrievable by other users")
	}

	// 4. ARTICLE — Alice publishes an addressable 30023; Bob resolves it by naddr coordinates.
	article := signedFull(t, aliceSK, 30023, "long body", nostr.Tags{{"d", "my-slug"}, {"title", "My Article"}})
	if ok, msg := publish(t, ws, article); !ok {
		t.Fatalf("article rejected: %q", msg)
	}
	if got := collect(t, ws, map[string]any{"kinds": []int{30023}, "authors": []string{alicePK}, "#d": []string{"my-slug"}}); !contains(got, article.ID) {
		t.Fatalf("Bob could not resolve Alice's article by naddr coordinates")
	}

	// 5. POLL — Alice asks (NIP-88 1068); Bob answers (1018); Alice tallies the response by #e.
	poll := signedFull(t, aliceSK, 1068, "best color?", nostr.Tags{
		{"d", "poll1"}, {"option", "o1", "Red"}, {"option", "o2", "Blue"}, {"polltype", "singlechoice"},
	})
	if ok, msg := publish(t, ws, poll); !ok {
		t.Fatalf("poll rejected: %q", msg)
	}
	resp := signedFull(t, bobSK, 1018, "", nostr.Tags{{"e", poll.ID}, {"response", "o2"}})
	if ok, msg := publish(t, ws, resp); !ok {
		t.Fatalf("poll response rejected: %q", msg)
	}
	if got := collect(t, ws, map[string]any{"kinds": []int{1018}, "#e": []string{poll.ID}}); !contains(got, resp.ID) {
		t.Fatalf("Alice could not tally Bob's poll vote")
	}

	// 6. REPORT — Bob reports Alice's post (NIP-56 1984); moderators can retrieve it by #e.
	report := signedFull(t, bobSK, 1984, "spam", nostr.Tags{{"e", post.ID}, {"p", alicePK}, {"report", "spam"}})
	if ok, msg := publish(t, ws, report); !ok {
		t.Fatalf("report rejected: %q", msg)
	}
	if got := collect(t, ws, map[string]any{"kinds": []int{1984}, "#e": []string{post.ID}}); !contains(got, report.ID) {
		t.Fatalf("moderators could not retrieve Bob's report")
	}

	// 7. DM — Alice gift-wraps to Bob (NIP-17 1059, PoW path); Bob receives it via his #p inbox.
	dm := minedGiftWrapTo(t, 8, bobPK)
	if ok, msg := publish(t, ws, dm); !ok {
		t.Fatalf("DM rejected: %q", msg)
	}
	if got := collect(t, ws, map[string]any{"kinds": []int{1059}, "#p": []string{bobPK}}); !contains(got, dm.ID) {
		t.Fatalf("Bob could not receive Alice's DM")
	}
}

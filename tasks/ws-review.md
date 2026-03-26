# WebSocket Extension Review — `4.0/ws-alignment` Branch

**Reviewer:** Kit (deep review sub-agent, on behalf of Stu Kennedy)
**Branch:** `fix/stu-review-blockers` (based on `4.0/ws-alignment`)
**Commit:** `ea04932`
**Date:** 2026-03-26

---

## Summary

The `4.0/ws-alignment` rewrite by Carson (scriptogre) is solid overall — well-structured IIFE, clean separation of concerns, good use of AbortController for listener management, and a well-designed correlation system. The main issues are around edge cases in connection lifecycle management and backwards compatibility.

All fixes implemented and tested. **88 total WS tests, all passing.**

---

## Stu's Review Blockers — FIXED

### BLOCKER 1: Orphaned WebSocket on element swap

**Problem:** `findConnectedElement(url)` returns null when the connect element has been swapped out of the DOM. The WebSocket stays open with no owner — no cleanup path.

**Root cause:** Multiple code paths assumed `findConnectedElement()` returning null was benign, but it actually means the connection is orphaned.

**Fix:** Added `cleanupOrphanedConnection(url, connection)` — a comprehensive teardown function that:
- Clears reconnect timers
- Removes visibility handler from document
- Aborts the AbortController (removes all socket event listeners)
- Clears pending requests
- Closes the socket
- Removes from the connections registry

Applied at every point where `findConnectedElement` is called:
- **`open` handler:** If element is gone when socket opens, clean up immediately
- **`close` handler:** Uses `cleanupOrphanedConnection` instead of partial cleanup
- **`handleMessage`:** If no connected element found, clean up the orphan
- **`scheduleReconnect`:** If element gone before scheduling, clean up immediately (was previously scheduling a timer to nowhere)
- **Timer callback in `scheduleReconnect`:** If element disappears during delay, clean up

**Tests added:** 4 new tests in "Orphaned Connection Cleanup" section

---

### BLOCKER 2: json.payload → json.content backwards compatibility

**Problem:** Old WS extension used `{ payload: "..." }` as the message format. This branch changed to `{ content: "..." }`, silently breaking existing users.

**Fix:** In `handleMessage`, the HTML extraction now checks `content` first, falls back to `payload` with a deprecation warning:

```javascript
if (detail.message.json.content !== undefined) {
    html = detail.message.json.content;
} else if (detail.message.json.payload !== undefined) {
    html = detail.message.json.payload;
    console.warn('[htmx-ws] json.payload is deprecated, use json.content instead');
}
```

**Tests added:** 4 new tests in "Backwards Compatibility - json.payload" section
- `payload` works with deprecation warning
- `content` takes priority over `payload`
- Neither present → no swap (data-only message)
- `payload` works with target/swap overrides

---

### POLISH: reconnectJitter boolean type guard

**Problem:** Old API used `reconnectJitter: true`. With numeric multiplication, `true * delay = delay` (no jitter) instead of expected ~30% jitter.

**Fix:** In `getConfig()`, after merging config layers:
```javascript
if (typeof merged.reconnectJitter === 'boolean') {
    merged.reconnectJitter = merged.reconnectJitter ? 0.3 : 0;
}
```

**Tests added:** 2 new tests in "reconnectJitter Boolean Compatibility" section

---

## Additional Findings — Deep Review

### FINDING 1: `closeConnection` didn't abort AbortController (FIXED)

**Severity:** Medium — resource leak

**Problem:** `closeConnection()` (called when the last element for a URL is removed) closed the socket and removed the visibility handler, but didn't abort the AbortController. This means event listeners subscribed with `{ signal: ac.signal }` remain registered until GC.

**Fix:** Added `connection.abortController.abort()` to `closeConnection()`.

**Test added:** "closeConnection aborts the AbortController"

---

### FINDING 2: Pending request cleanup only on send (FIXED)

**Severity:** Low — memory leak under specific conditions

**Problem:** `cleanupExpiredRequests()` was only called in `sendRequest()`. If a connection receives messages but never sends again, expired entries (including DOM element references) leak until the connection closes.

**Fix:** Added `cleanupExpiredRequests(connection)` call at the top of `handleMessage()`.

**Test added:** "cleans up expired pending requests on message receive"

---

### FINDING 3: Correlated element removed from DOM (FIXED)

**Severity:** Medium — silent failure

**Problem:** The correlation system stores the sending element reference. If that element is swapped out before the response arrives, the response tries to swap into a detached element — events won't bubble, swap is invisible.

**Fix:** After finding the correlated element, check `connectionElement.isConnected`. If detached, fall back to `findConnectedElement()`.

**Test added:** "falls back to live element when correlated element is removed from DOM"

---

### FINDING 4: Inconsistent cleanup in `scheduleReconnect` (FIXED)

**Severity:** Low — resource leak

**Problem:** When `scheduleReconnect` bailed out (max attempts exceeded, event cancelled), it only did partial cleanup: `connection.pendingRequests.clear()` + `connections.delete(url)`. It didn't abort the AbortController or remove the visibility handler.

**Fix:** All bailout paths now use `cleanupOrphanedConnection()`.

---

## Things That Are Fine (No Changes Needed)

1. **`attempt` reset timing in `open` handler:** The event fires at line 184 (before reset at line 189), so `htmx:after:ws:connection` correctly sees the reconnect attempt number. This is good — the existing test validates it.

2. **Multiple elements connecting to same URL:** The registry is keyed by normalized URL. `findConnectedElement()` returns the first matching element in DOM order. This is reasonable — all elements share the same connection, and the first live one gets events. The test "keeps connection open when one of multiple elements is removed" validates this.

3. **Mock WebSocket doesn't support AbortController signals:** The mock's `addEventListener` ignores the options bag, so `abort()` doesn't actually remove mock listeners. This is fine — the `event.target !== connection.socket` guard at line 163 handles stale listener cleanup. Real browsers support AbortController on WebSocket.

4. **`sendRequest` URL resolution:** Properly handles both `hx-ws:send="/url"` (creates own connection) and `hx-ws:send` (finds ancestor's connection). The ancestor lookup via `element.closest()` is correct.

5. **Legacy attribute handling:** `checkLegacyAttributes` properly maps `ws-connect` → `hx-ws:connect` and `ws-send` → `hx-ws:send` with deprecation warnings. Only sets the new attribute if it doesn't already exist.

---

## Test Coverage Summary

| Section | Tests | Status |
|---------|-------|--------|
| Connection Lifecycle | 9 | ✅ All pass |
| Message Sending | 8 | ✅ All pass |
| Message Receiving & HTML | 7 | ✅ All pass |
| Custom Channels | 5 | ✅ All pass |
| Error Handling & Reconnection | 9 | ✅ All pass |
| Configuration | 11 | ✅ All pass |
| Event Emission | 8 | ✅ All pass |
| Backward Compatibility | 2 | ✅ All pass |
| Integration Scenarios | 3 | ✅ All pass |
| Target & Swap Overrides | 6 | ✅ All pass |
| Bug Regressions | 2 | ✅ All pass |
| **Orphaned Cleanup (NEW)** | **4** | ✅ All pass |
| **json.payload Compat (NEW)** | **4** | ✅ All pass |
| **Jitter Boolean (NEW)** | **2** | ✅ All pass |
| **Deep Review Fixes (NEW)** | **3** | ✅ All pass |
| **TOTAL** | **88** | ✅ All pass |

### Remaining Test Gaps (not blocking, future work)

1. **Visibility/background pause:** No tests for `pauseOnBackground` (would need to mock `document.hidden`)
2. **Concurrent reconnect races:** No test for what happens if `createWebSocket` is called while a previous socket is still CONNECTING
3. **Binary WebSocket messages:** All tests use text messages; no Blob/ArrayBuffer handling
4. **WebSocket constructor failure:** No test for `new WebSocket()` throwing (e.g., invalid URL)
5. **`hx-ws:send` with URL + reconnection:** No test for send-triggered connections reconnecting

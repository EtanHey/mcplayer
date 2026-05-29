# Bugbot Review Summary - Engine Reset Supervisor (D3)

**Status:** ✅ **APPROVED**  
**Commit:** 32cce71538c4c74d719a98cb9578484bfde0a165  
**Date:** 2026-05-29  
**Reviewer:** Cursor Bugbot

---

## Quick Summary

✅ **All tests passing** (43 contract tests + real execution)  
✅ **No critical bugs found**  
⚠️ **2 medium-priority observability issues** (non-blocking)  
ℹ️ **3 low-priority notes** for future consideration

**Recommendation:** Safe to merge. Follow-up PR recommended for observability improvements.

---

## Test Results

### Contract Tests: ✅ 43/43 passing
```
tests/contract/protocol.test.ts:  23 pass
tests/contract/wal.test.ts:        8 pass
tests/contract/server.test.ts:     8 pass (including 2 new engine tests)
tests/contract/engine.test.ts:     4 pass (all new)
```

### Real Execution Harness: ✅ PASSED
```
ENGINE_RESET_SURVIVED socket=stable status=up replayed=2 order=during-down-1,during-down-2
```
Proves the D3 invariant: socket stays connected across engine kill/restart with ordered replay.

---

## Issues Found

### 🟡 Medium #1: Timer `unref()` Optional Chaining
**File:** `src/server/engine.ts:51`
```typescript
this.#timer.unref?.();
```
**Issue:** Optional chaining suggests uncertainty about runtime. Bun should always provide `unref()`.

**Impact:** In environments without `unref()`, timers may prevent graceful shutdown (though tests pass).

**Fix:** Remove `?.` and use explicit `unref()` call, or document why it's optional.

---

### 🟡 Medium #2: Silent Health Probe Failures
**File:** `src/server/engine.ts:86`
```typescript
catch {
  this.#setState("not-up");
}
```
**Issue:** All probe exceptions swallowed without logging. Operators can't distinguish "engine is down" from "probe is broken."

**Impact:** Difficult to debug production issues (permissions errors, config mistakes, etc.).

**Fix:** Add error logging or expose last probe error via `state()`.

---

## Low-Priority Observations

1. **Probe concurrency flag** may skip checks if probe takes longer than interval (acceptable for fast probes)
2. **Shallow copy in `state()`** is safe for current flat structure
3. **Unlimited listeners** allowed (McplayerServer properly manages its single subscription)

---

## What Was Done Well

- ✅ **Comprehensive test coverage** including real execution with kill -9
- ✅ **Proper resource cleanup** in shutdown sequence
- ✅ **Non-blocking state reads** satisfying A1 invariant
- ✅ **Pluggable health probe abstraction**
- ✅ **Safe concurrency model** without race conditions
- ✅ **Correct error boundary handling** for WalFullError

---

## Files Reviewed

- ✅ `src/server/engine.ts` (new, 119 lines)
- ✅ `src/server/index.ts` (modified, supervisor integration)
- ✅ `src/server/cli.ts` (modified, env wiring)
- ✅ `tests/contract/engine.test.ts` (new, 4 tests)
- ✅ `tests/contract/server.test.ts` (modified, 2 new tests)
- ✅ `tests/contract/engine-reset-real-execution.ts` (new, real harness)
- ✅ `tests/contract/mock-engine.ts` (new, test helper)
- ✅ `docs/RESET-SURVIVAL.md` (new, feature documentation)

---

## Recommendations

### For This PR
✅ **Ship it!** The code is correct and well-tested.

### Next PR (Observability)
1. Add logging to `#runProbe` catch block
2. Consider exposing last probe error in status
3. Remove optional chaining on `unref()` or document

### Future Work
1. Document probe performance expectations
2. Consider probe timeout mechanism
3. Add listener count monitoring

---

**Full detailed review:** See `BUGBOT_REVIEW_D3.md`

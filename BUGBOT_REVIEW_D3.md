# Bugbot Code Review: Engine Reset Supervisor (D3)

**Reviewer:** Cursor Bugbot (Claude Sonnet 4.5)  
**Date:** 2026-05-29  
**PR:** feat/mcplayer-d3-reset  
**Commit:** 32cce71538c4c74d719a98cb9578484bfde0a165

---

## Executive Summary

✅ **All tests pass** (43 contract tests, real execution harness passes)  
✅ **No critical bugs found**  
⚠️ **2 medium-priority issues identified**  
ℹ️ **3 low-priority observations for future consideration**

The engine reset survival feature is well-implemented with comprehensive test coverage. The code follows the existing patterns established in the codebase and correctly implements the D3 invariant: the mcplayer socket stays connected across engine kill/restart with proper message replay.

---

## Issues Found

### 🟡 MEDIUM #1: Potential Timer Reference in Long-Running Processes

**File:** `src/server/engine.ts:51`  
**Severity:** MEDIUM  
**Type:** Resource Management

```typescript:50:52:src/server/engine.ts
    void this.#runProbe();
    this.#timer = setInterval(() => void this.#runProbe(), this.#probeIntervalMs);
    this.#timer.unref?.();
```

**Issue:**  
The `.unref?.()` call attempts to unref the timer to prevent it from keeping the process alive. However:

1. **Optional chaining on `unref` is suspicious**: In Node.js and Bun, `setInterval` returns a `Timeout` object that should always have an `unref()` method. The `?.` suggests uncertainty about the runtime environment.

2. **Bun compatibility concern**: While Bun implements `unref()` on timers, the behavior may differ from Node.js. The optional chaining masks potential runtime differences.

3. **Type mismatch**: The code uses `ReturnType<typeof setInterval>` which is correct, but the optional chaining suggests the types don't guarantee `unref` exists.

**Impact:**  
- In environments where `unref` is undefined, timers may prevent graceful shutdown
- The supervisor's timer could keep the process alive even when all other work is done
- Silent failure mode: the `?.` makes this invisible

**Recommendation:**
```typescript
// Option 1: Explicit runtime check with logging
if (typeof this.#timer.unref === 'function') {
  this.#timer.unref();
} else {
  // Log or handle the case where unref is not available
}

// Option 2: Accept that we're Bun-only (per CLAUDE.md) and assert:
this.#timer.unref();
```

**Severity Justification:**  
Medium rather than high because:
- Tests pass and the feature works
- CLI usage shows proper shutdown behavior
- The supervisor is properly stopped in `McplayerServer.shutdown()`
- This primarily affects edge cases with abandoned supervisors

---

### 🟡 MEDIUM #2: Health Probe Exception Handling May Hide Important Errors

**File:** `src/server/engine.ts:86-90`  
**Severity:** MEDIUM  
**Type:** Error Handling / Observability

```typescript:83:92:src/server/engine.ts
  async #runProbe(): Promise<void> {
    if (!this.#healthProbe || this.#probeRunning) return;
    this.#probeRunning = true;
    try {
      this.#setState(probeResultToState(await this.#healthProbe()));
    } catch {
      this.#setState("not-up");
    } finally {
      this.#probeRunning = false;
    }
  }
```

**Issue:**  
The catch block swallows all exceptions without logging or exposing them. While the behavior (marking engine as down) is correct, **completely silent failure makes debugging impossible**.

**Scenarios where this hurts:**
1. **Configuration errors**: If `MCPLAYER_ENGINE_HEARTBEAT_FILE` points to an inaccessible path (permissions, wrong mount), users get a silent `not-up` state with no clue why
2. **Transient failures**: Network issues, filesystem problems, or unexpected exceptions provide no diagnostic information
3. **Implementation bugs**: If a custom health probe throws an unexpected error, it's invisible

**Impact:**  
- Operators cannot distinguish between "engine is down" and "health check is broken"
- No audit trail for probe failures
- Difficult to debug production issues

**Recommendation:**
```typescript
async #runProbe(): Promise<void> {
  if (!this.#healthProbe || this.#probeRunning) return;
  this.#probeRunning = true;
  try {
    this.#setState(probeResultToState(await this.#healthProbe()));
  } catch (error) {
    // Log or emit error for observability
    // Consider: this.#lastProbeError = error; (expose via state())
    // Or: console.error('[EngineSupervisor] Health probe failed:', error);
    this.#setState("not-up");
  } finally {
    this.#probeRunning = false;
  }
}
```

**Why not Critical:**  
- The failure mode is safe (marking engine down is correct)
- Tests demonstrate the core behavior works
- This is about observability, not correctness
- Workaround exists: users can wrap their probe with logging

---

## ℹ️ Low-Priority Observations

### LOW #1: `#probeRunning` Flag Prevents Concurrent Probes, But Could Cause Missed Checks

**File:** `src/server/engine.ts:84`

```typescript:83:93:src/server/engine.ts
  async #runProbe(): Promise<void> {
    if (!this.#healthProbe || this.#probeRunning) return;
    this.#probeRunning = true;
    try {
      this.#setState(probeResultToState(await this.#healthProbe()));
    } catch {
      this.#setState("not-up");
    } finally {
      this.#probeRunning = false;
    }
  }
```

**Observation:**  
The `#probeRunning` flag prevents concurrent probe execution. This is a safe choice, but means:
- If a probe takes longer than `probeIntervalMs`, subsequent ticks are dropped
- A stuck probe prevents all future checks until the current one resolves or times out

**Current Status:** Tests pass with 10-25ms intervals and fast probes. The real execution test uses 25ms intervals with heartbeat file checks (very fast).

**When this might matter:**  
- Network-based health probes with high latency
- Overloaded systems where filesystem operations are slow
- Custom probes that don't have built-in timeouts

**Recommendation for future work:**  
Consider adding probe timeout handling or documenting that probes must be fast (<< `probeIntervalMs`).

---

### LOW #2: `state()` Returns a Shallow Copy, Mutations to `since` String Are Safe

**File:** `src/server/engine.ts:43`

```typescript:43:45:src/server/engine.ts
  state(): EngineStatus {
    return { ...this.#status };
  }
```

**Observation:**  
The method returns a shallow copy of the status object. Since `EngineStatus` only contains primitive fields (`state: string` and `since: string`), this is sufficient. However, if future changes add nested objects to `EngineStatus`, this could become a source of subtle bugs.

**Current Status:** Safe. The current type definition has no nested objects:

```typescript:5:8:src/server/engine.ts
export interface EngineStatus {
  state: EngineState;
  since: string;
}
```

**Recommendation:**  
None for now. If `EngineStatus` ever grows nested fields, update to use `structuredClone()` or deep copy.

---

### LOW #3: No Maximum Listener Limit on `EngineSupervisor`

**File:** `src/server/engine.ts:60-65`

```typescript:60:65:src/server/engine.ts
  onStateChange(listener: EngineStateListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
```

**Observation:**  
The supervisor allows unlimited listeners via `Set<EngineStateListener>`. While this is generally fine, in scenarios with:
- Many concurrent connections registering listeners
- Memory leaks where unsubscribe functions aren't called
- Malicious actors repeatedly subscribing

...the listener set could grow without bound.

**Current Status:**  
The `McplayerServer` properly manages its listener:
- Exactly one subscription in `start()` (line 100-102)
- Proper cleanup in `shutdown()` (line 145-146)
- No leaks in normal operation

**Recommendation:**  
Low priority, but consider:
1. Adding a max listener count (like EventEmitter's warning mechanism)
2. Logging when listener count exceeds a threshold
3. Documenting that callers must call the unsubscribe function

---

## ✅ What Was Done Well

### 1. **Excellent Test Coverage**
- Unit tests for `EngineSupervisor` covering state transitions, async probes, explicit states
- Integration tests for server+engine interaction
- **Real execution harness** proving the actual invariant with kill -9

### 2. **Proper Resource Cleanup**
The shutdown sequence is correct:
```typescript:119:160:src/server/index.ts
async shutdown(): Promise<void> {
  if (this.#stopping) return;
  this.#stopping = true;
  // ... proper cleanup of engine supervisor
  this.#unsubscribeEngine?.();
  this.#unsubscribeEngine = undefined;
  this.#engine?.stop();
  // ...
}
```

### 3. **Non-Blocking State Reads**
The instant `state()` getter with async health checks is the right architecture for the A1 invariant (never block on engine).

### 4. **Pluggable Health Probes**
The abstraction allows for multiple probe strategies (heartbeat file, network ping, etc.) without coupling to the supervisor core.

### 5. **Safe Concurrency Model**
- State changes are synchronous
- Listeners are notified immediately after state update
- No race conditions in the core state machine

### 6. **Proper Error Boundaries**
`WalFullError` is caught and translated to JSON-RPC error code correctly in the server dispatch.

---

## Test Coverage Analysis

### Contract Tests: ✅ 43/43 passing

#### Engine Supervisor Tests (4 tests)
- ✅ Async probe with state transitions
- ✅ Non-blocking state reads during slow probes  
- ✅ Explicit state return from probes (building/busy/up)
- ✅ Heartbeat file probe with staleness detection

#### Server Integration Tests (2 new engine tests)
- ✅ Attached engine drives status and gates replay
- ✅ Subscribe deferred while down, replays on recovery

#### Real Execution Harness
- ✅ Socket survives SIGKILL -9 of engine
- ✅ Status reflects engine state (up → not-up → up)
- ✅ WAL enqueue succeeds during down
- ✅ Messages replay in order on recovery
- ✅ Fresh client can connect while engine is down

**Uncovered Edge Cases** (acceptable for v1):
- Extremely rapid state transitions (building→up→down→up in <1ms)
- OOM or disk-full during WAL write while engine is down
- Health probe that returns invalid EngineState values (TypeScript should prevent)

---

## Performance Considerations

### 1. Heartbeat File Probe Performance
The `createHeartbeatFileHealthProbe` uses `statSync()`:

```typescript:104:114:src/server/engine.ts
export function createHeartbeatFileHealthProbe(
  opts: HeartbeatFileHealthProbeOptions,
): EngineHealthProbe {
  return () => {
    try {
      return Date.now() - statSync(opts.path).mtimeMs <= opts.staleMs;
    } catch {
      return false;
    }
  };
}
```

**Analysis:**  
- `statSync` is a synchronous syscall
- Typical latency: <1ms on local disk
- Default probe interval: 250ms (from `cli.ts:56`)
- **Verdict:** Acceptable. The probe is fast enough and blocks the event loop for <1ms per 250ms.

**Future optimization:** Could use `fs.promises.stat()` for async, but the current approach is simpler and the overhead is negligible for the use case.

---

## Security Review

### No Security Issues Found

1. **No user-controlled input** reaches the supervisor's health probe configuration
2. **Environment variables** are loaded once at startup, not dynamically
3. **Heartbeat file path** is set by the operator, not by clients
4. **No command injection** vectors
5. **Listener callbacks** are set by internal server code, not by external clients

---

## Recommendations Summary

### Immediate (Before Merge)
- **None**. The code is safe to merge.

### Short-Term (Next PR)
1. ✏️ Add error logging to `#runProbe` catch block for observability
2. ✏️ Consider removing optional chaining on `unref()` or documenting why it's there

### Long-Term (Future Work)
1. 📝 Document that health probes must be fast (<< probe interval)
2. 📝 Consider probe timeout mechanism
3. 📝 Add listener count limit or warning

---

## Conclusion

This is a **well-implemented feature** with excellent test coverage including real-execution verification. The two medium-priority issues are observability/logging concerns rather than correctness bugs. The code correctly implements the D3 invariant and is safe to merge.

**Approval Status:** ✅ **APPROVED** with minor observability suggestions for follow-up.

---

**Generated by:** Cursor Bugbot  
**Review Time:** ~5 minutes  
**Lines Reviewed:** ~900 across 8 files

# Bugbot Code Review: durable-contract protocol (D0)

**Branch:** `feat/mcplayer-durable-contract`  
**Reviewed:** 2026-05-29  
**Status:** ✅ Tests Pass (16/16) | ⚠️ Issues Found

---

## 🐛 Critical Issues

### 1. **Unhandled JSON Parse Errors in NdjsonDecoder**
**Location:** `src/protocol/index.ts:33`  
**Severity:** CRITICAL  
**Risk:** Process crash on malformed input

```typescript
// Current code (line 33):
out.push(JSON.parse(line));
```

**Problem:** `JSON.parse()` throws on invalid JSON. If a client sends malformed JSON on a line, the decoder will crash without any error handling.

**Impact:** Denial of service - a single malformed line crashes the entire process.

**Recommendation:**
```typescript
try {
  out.push(JSON.parse(line));
} catch (e) {
  // Option 1: Skip and continue (lossy but resilient)
  // Option 2: Throw custom error (fails fast with context)
  // Option 3: Return error objects mixed with successful parses
  throw new Error(`Invalid JSON at line: ${line.slice(0, 100)}...`, { cause: e });
}
```

**Test gap:** No test covers `decoder.push('{"invalid\n')`.

---

### 2. **JSON-RPC 2.0 Spec Violation: Both result AND error**
**Location:** `src/protocol/index.ts:66`  
**Severity:** MEDIUM  
**Risk:** Protocol non-compliance

```typescript
// Current code (line 66):
if (hasId && (hasResult || hasError)) return "response";
```

**Problem:** JSON-RPC 2.0 spec (§5.1) requires a response to have **either** `result` **or** `error`, never both. A message with both should be classified as `"invalid"`.

**Example of invalid message that currently passes:**
```json
{"jsonrpc":"2.0", "id":1, "result":{}, "error":{"code":-32603, "message":"x"}}
```

**Recommendation:**
```typescript
if (hasId && (hasResult || hasError)) {
  if (hasResult && hasError) return "invalid"; // both is illegal
  return "response";
}
```

**Test gap:** No test for `classify({jsonrpc:"2.0", id:1, result:{}, error:{code:-1, message:"x"}})`.

---

## ⚠️ Medium Issues

### 3. **No Buffer Size Limit (Memory Exhaustion)**
**Location:** `src/protocol/index.ts:24`  
**Severity:** MEDIUM  
**Risk:** DoS via memory exhaustion

**Problem:** The decoder's `#buffer` can grow infinitely if a malicious client sends data without newlines. No maximum buffer size is enforced.

**Attack scenario:**
```javascript
// Attacker sends 1GB of data with no newline
decoder.push("x".repeat(1_000_000_000));
// Buffer now holds 1GB in memory, no limit
```

**Recommendation:**
```typescript
const MAX_LINE_SIZE = 1_048_576; // 1MB per line

push(chunk: Buffer | Uint8Array | string): unknown[] {
  this.#buffer += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
  
  if (this.#buffer.length > MAX_LINE_SIZE) {
    throw new Error(`Line exceeds max size of ${MAX_LINE_SIZE} bytes`);
  }
  // ... rest of logic
}
```

---

### 4. **No String Length Validation**
**Location:** `src/protocol/index.ts:100-129`  
**Severity:** LOW  
**Risk:** Resource exhaustion via huge strings

**Problem:** `client_id`, `channel`, `message_id` have no max length. A client could send gigabyte-sized strings.

**Example:**
```json
{"jsonrpc":"2.0", "id":1, "method":"mcplayer.connect", "params":{"client_id":"x".repeat(10_000_000)}}
```

**Recommendation:** Add length checks to validators:
```typescript
const MAX_ID_LENGTH = 256;
const MAX_CHANNEL_LENGTH = 512;

"mcplayer.connect": (p) => {
  if (!isStr(p.client_id)) return bad("client_id must be a string");
  if (p.client_id.length > MAX_ID_LENGTH) return bad(`client_id too long (max ${MAX_ID_LENGTH})`);
  return ok;
}
```

---

## 📋 Test Coverage Gaps

The following edge cases lack test coverage:

1. **Invalid JSON in NDJSON stream**
   ```typescript
   const d = new NdjsonDecoder();
   d.push('{"invalid\n'); // Should this throw? Skip? Return error?
   ```

2. **Response with both result and error**
   ```typescript
   classify({jsonrpc:"2.0", id:1, result:{}, error:{code:-1,message:"x"}});
   // Expected: "invalid", Actual: "response"
   ```

3. **UTF-8 multibyte character split across chunks**
   ```typescript
   const d = new NdjsonDecoder();
   const emoji = Buffer.from("😀"); // 4-byte UTF-8
   d.push(emoji.slice(0, 2)); // First 2 bytes
   d.push(emoji.slice(2)); // Last 2 bytes
   d.push("\n");
   // Does this correctly decode?
   ```

4. **Very large line (buffer exhaustion)**
   ```typescript
   const d = new NdjsonDecoder();
   d.push("x".repeat(10_000_000)); // 10MB no newline
   // Should this throw or continue buffering?
   ```

5. **Null id vs undefined id**
   ```typescript
   classify({jsonrpc:"2.0", method:"x", id:null}); // null id - valid request
   classify({jsonrpc:"2.0", method:"x"}); // no id - valid notification
   ```

6. **Empty method string**
   ```typescript
   classify({jsonrpc:"2.0", id:1, method:""});
   // Expected: probably "invalid" (empty method name)
   ```

---

## ✅ Strengths

1. **Clean separation of concerns** - NDJSON, classification, validation are independent
2. **Zero dependencies** - Pure TypeScript, no external libs
3. **Good test structure** - 16 tests covering happy paths
4. **Clear error codes** - Reserved `-32001..-32004` range documented
5. **Idiomatic TypeScript** - Private fields, type guards, const assertions

---

## 🔧 Minor Improvements

### 5. **Performance: Unnecessary trim()**
**Location:** `src/protocol/index.ts:32`

```typescript
// Current:
if (line.trim().length === 0) continue;

// Faster (avoids string allocation):
if (line.length === 0) continue;
```

Blank lines would be empty strings after slicing anyway. The `trim()` is defensive but unnecessary if the protocol guarantees clean newlines.

---

### 6. **TypeScript: Missing readonly**
**Location:** `src/protocol/index.ts:74-79`

```typescript
// Current:
export const ERR = { ... } as const;

// Better (prevents mutation of ERR object itself):
export const ERR = Object.freeze({
  UNKNOWN_SESSION: -32001,
  // ...
}) as const;
```

Though `as const` makes properties readonly, the object itself can be reassigned. `Object.freeze` prevents that.

---

## 📝 Documentation Issues

### 7. **PROTOCOL.md Missing Error Recovery Behavior**

The spec doesn't define:
- What happens when the decoder encounters invalid JSON?
- What happens when a line exceeds a size limit?
- Whether blank lines are allowed (implementation skips them, but spec doesn't mention)

**Recommendation:** Add "Error Handling" section to `docs/PROTOCOL.md`:
```markdown
## Error Handling

- **Invalid JSON:** Lines that fail to parse are [skipped/fatal/returned as error objects]
- **Line size limit:** Lines exceeding 1MB are rejected with error code -32700 (Parse error)
- **Blank lines:** Permitted and ignored (for human readability in logs)
```

---

## 🎯 Recommendations Summary

| Priority | Issue | Action |
|----------|-------|--------|
| 🔴 P0 | JSON parse crash | Wrap `JSON.parse()` in try-catch |
| 🟠 P1 | Spec violation (result+error) | Add check for mutual exclusion |
| 🟡 P2 | Buffer size limit | Add MAX_LINE_SIZE constant and check |
| 🟡 P2 | String length limits | Add max length validation for IDs |
| 🟢 P3 | Test coverage | Add tests for edge cases above |
| 🟢 P3 | Documentation | Clarify error handling in PROTOCOL.md |

---

## ✅ Approval Status

**Current Status:** ⚠️ **APPROVE WITH CHANGES**

The protocol design is solid and the test suite covers happy paths well. However, the **unhandled JSON.parse() error** is a critical bug that must be fixed before production use. The other issues are lower priority but should be addressed for robustness and spec compliance.

**Blockers for merge:**
- [ ] Fix #1: Handle JSON parse errors
- [ ] Fix #2: Classify both result+error as invalid

**Follow-up work (can be separate PR):**
- [ ] Add buffer size limits
- [ ] Add string length validation  
- [ ] Expand test coverage for edge cases
- [ ] Document error handling behavior

---

**Reviewed by:** Bugbot (Claude Sonnet 4.5)  
**Review date:** 2026-05-29

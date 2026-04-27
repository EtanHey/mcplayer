import http from "k6/http";
import { check, fail } from "k6";

const FIXTURE_PATH = __ENV.MCPLAYER_FANOUT_TIMEOUT_PAYLOAD;
if (!FIXTURE_PATH) {
  fail("MCPLAYER_FANOUT_TIMEOUT_PAYLOAD is required");
}

const PROXY_URL = __ENV.MCPLAYER_FANOUT_PROXY_URL;
if (!PROXY_URL) {
  fail("MCPLAYER_FANOUT_PROXY_URL is required");
}

const fixture = JSON.parse(open(FIXTURE_PATH));
if (!Array.isArray(fixture.requests) || fixture.requests.length === 0) {
  fail("invalid fanout timeout fixture");
}

if (fixture.requests.length !== 100) {
  fail(`unexpected fixture request count: ${fixture.requests.length}`);
}

const requestCount = fixture.requests.length;

export const options = {
  vus: 1,
  iterations: 1,
  thresholds: {
    http_req_duration: ["p(95)<500", "p(99)<2000"],
    checks: ["rate>0.99"],
  },
};

export default function () {
  const payload = fixture.requests.map((call) => ({
    method: "POST",
    url: `${PROXY_URL.replace(/\/$/, "")}/`,
    body: JSON.stringify({
      target: fixture.target,
      call,
    }),
    params: {
      headers: {
        "Content-Type": "application/json",
      },
      tags: {
        tool: call.name,
        expected_status: String(call.expected_status_code),
      },
      timeout: "3s",
    },
  }));

  const responses = http.batch(payload);

  let within500Ms = 0;
  let timeoutErrors = 0;
  let statusMatch = 0;

  responses.forEach((response, index) => {
    const call = fixture.requests[index];
    let message = null;
    try {
      message = JSON.parse(response.body || "{}");
    } catch {
      message = null;
    }

    const expectedCode = call.expected_status_code;
    const isError = message && message.error;
    const actualCode = isError ? Number(message.error.code) : 200;
    const statusMatched = actualCode === expectedCode;
    const shapeMatched = isError === (call.expected.kind === "error");

    if (statusMatched && shapeMatched) {
      statusMatch += 1;
    }

    if (call.expected_status_code === -32000 && isError && actualCode === -32000) {
      timeoutErrors += 1;
    }

    if (response.timings.duration <= 500) {
      within500Ms += 1;
    }
  });

  check(statusMatch, {
    ["all RPCs preserved expected status code and result/error shape"]: () =>
      statusMatch === requestCount,
  });

  check(within500Ms, {
    ["at least 95% of RPCs returned within 500ms"]: () =>
      within500Ms >= Math.ceil(requestCount * 0.95),
  });

  check(timeoutErrors, {
    ["timeout requests bubbled up as JSON-RPC errors"]: () => timeoutErrors > 0,
  });
}

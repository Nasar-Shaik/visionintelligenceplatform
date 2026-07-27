# Slice 003 — @vip/service-identity · Manual Test Scenarios

- **Target:** the Identity service scaffold (infra endpoints only; no auth yet).
- **Prereqs:** Node 24, `pnpm install` done, contracts built (`pnpm --filter @vip/contracts build`).

## How to run it

```bash
pnpm --filter @vip/service-identity build
PORT=48080 HOST=127.0.0.1 NODE_ENV=production LOG_LEVEL=info node services/identity/dist/index.js
```

Then, in another terminal, run the `curl` commands below. Stop with Ctrl-C (observe graceful shutdown).

## Positive Tests

### T-1 Liveness

- **Steps:** `curl -i http://127.0.0.1:48080/health`
- **Expected:** `200`, body `{"status":"ok"}`
- **Pass Criteria:** status 200 and exact body. **Result:** ☐ Pass ☐ Fail

### T-2 Readiness (no dependencies)

- **Steps:** `curl -i http://127.0.0.1:48080/ready`
- **Expected:** `200`, body `{"status":"pass","checks":[]}`
- **Pass Criteria:** status 200, `status:"pass"`, empty checks. **Result:** ☐ Pass ☐ Fail

### T-3 Service info

- **Steps:** `curl -s http://127.0.0.1:48080/ | jq`
- **Expected:** `{"success":true,"data":{"name":"identity","version":"0.1.0","startedAt":"…","uptimeSeconds":N}}`
- **Pass Criteria:** `success:true`; `uptimeSeconds` grows on repeat calls. **Result:** ☐ Pass ☐ Fail

### T-4 Metrics

- **Steps:** `curl -s http://127.0.0.1:48080/metrics | head`
- **Expected:** Prometheus text; includes `http_request_duration_seconds` and `service="identity"`
- **Pass Criteria:** 200, text/plain, metric names present. **Result:** ☐ Pass ☐ Fail

## Negative Tests

### T-5 Unknown route → 404 envelope

- **Steps:** `curl -i http://127.0.0.1:48080/does-not-exist`
- **Expected:** `404`, `{"success":false,"error":{"code":"not_found","message":"Route GET /does-not-exist not found","correlationId":"…"}}`
- **Pass Criteria:** 404 + error envelope with a correlationId. **Result:** ☐ Pass ☐ Fail

## Edge Cases

### T-6 Correlation id is honoured

- **Steps:** `curl -s -H 'x-request-id: trace-abc-123' http://127.0.0.1:48080/nope | jq .error.correlationId`
- **Expected:** `"trace-abc-123"`
- **Pass Criteria:** the supplied id is echoed as correlationId. **Result:** ☐ Pass ☐ Fail

### T-7 Invalid PORT aborts startup

- **Steps:** `PORT=70000 node services/identity/dist/index.js`
- **Expected:** process exits non-zero with a "fatal … failed to start" message (config validation)
- **Pass Criteria:** does not listen; clear error. **Result:** ☐ Pass ☐ Fail

## Failure Cases

### T-8 Graceful shutdown

- **Steps:** start the service, then press Ctrl-C (SIGINT) or `kill -TERM <pid>`
- **Expected:** logs "shutdown signal received, draining" → "shutdown complete"; exit code 0
- **Pass Criteria:** clean drain, exit 0. **Result:** ☐ Pass ☐ Fail

## Security / Manual Validation

### T-9 Security headers

- **Steps:** `curl -sI http://127.0.0.1:48080/health | grep -i x-`
- **Expected:** `x-content-type-options: nosniff`, `x-frame-options: SAMEORIGIN`
- **Pass Criteria:** helmet headers present. **Result:** ☐ Pass ☐ Fail

## Performance Tests

➖ **N/A this slice** — no perf-sensitive path yet; load testing deferred to P2/P4 (Risk R-005).

## Summary

- **Automated coverage:** `pnpm --filter @vip/service-identity test` — 19 tests (config, readiness, domain/application, inject-based HTTP for T-1…T-6, T-9).
- **Overall Pass Criteria:** T-1 through T-9 pass.

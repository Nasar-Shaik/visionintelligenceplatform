<!-- Copy to docs/testing/slice-NNN.md. Written so the Product Owner can execute it BY HAND. -->

# Slice NNN — <name> · Manual Test Scenarios

- **Target:** <what is under test> · **Prereqs:** <how to run it, ports, env>

> For each scenario: **Steps → Expected Result → Pass Criteria**. Tick Pass/Fail when executed.

## Positive Tests

### T-1 <happy path name>

- **Steps:** …
- **Expected Result:** …
- **Pass Criteria:** …
- **Result:** ☐ Pass ☐ Fail

## Negative Tests

### T-N <invalid input / unauthorized / not found>

- **Steps:** … · **Expected:** … · **Pass Criteria:** … · **Result:** ☐ Pass ☐ Fail

## Edge Cases

### T-E <boundary / empty / large / clock-skew>

- **Steps:** … · **Expected:** … · **Pass Criteria:** … · **Result:** ☐ Pass ☐ Fail

## Failure Cases

### T-F <dependency down / crash / timeout>

- **Steps:** … · **Expected:** … · **Pass Criteria:** … · **Result:** ☐ Pass ☐ Fail

## Performance Tests

### T-P <throughput / latency> _(or "N/A this slice — reason")_

- **Steps:** … · **Expected:** … · **Pass Criteria:** … · **Result:** ☐ Pass ☐ Fail

## Manual Validation

_Anything the PO should eyeball (logs, metrics output, headers)._

## Summary

- **Automated coverage:** <which automated tests back these scenarios>
- **Overall Pass Criteria:** _all positive + negative + edge scenarios pass._

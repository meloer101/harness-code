# Review checklist

Load this only when the main instructions are not enough for a tricky change.

## Contents
- Correctness
- Edge cases and failure modes
- Security
- Readability and structure
- Tests

## Correctness
- Every branch reachable with inputs this function actually receives
- Boundary values: 0, 1, empty, max, negative, the last element
- `null` / `undefined` / missing key vs. present-but-falsy
- Integer overflow, float comparison, timezone and DST for dates
- Async: unawaited promises, race between check and use, missing `await` in a loop
- The error path leaves state consistent (no half-written file, no held lock)

## Edge cases and failure modes
- What happens when a dependency (network, disk, subprocess) fails or hangs
- Partial success: N of M items processed, then an exception
- Re-entrancy and idempotency if the operation can be retried
- Resource cleanup on every exit path, including early return and throw

## Security
- Input from a real trust boundary (user, network, file) is validated before use
- No secret in logs, error messages, or URLs
- Path traversal, command injection, SQL/template injection at the point of use
- Authorization checked on the server side, not just hidden in the UI

## Readability and structure
- Names say what the thing is; no abbreviation the file doesn't already use
- Function does one thing; nesting depth stays shallow
- Comment density matches the surrounding file
- No dead code, no commented-out blocks, no `TODO` without an owner
- Change is scoped to the task — surrounding cleanup belongs in its own change

## Tests
- New behavior has a test that fails without the production change
- Both the happy path and at least one failure path are covered
- Test names describe the scenario, not the method under test
- No sleep-based synchronization, no dependence on test execution order

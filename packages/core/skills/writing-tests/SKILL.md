---
name: writing-tests
description: Writes focused unit tests for existing code, following the project's own test framework and conventions. Use when asked to add tests, improve coverage, or write a regression test for a bug.
license: Apache-2.0
allowed-tools: Read Grep Glob Edit Write Bash(npm test:*) Bash(pnpm test:*) Bash(pnpm vitest:*) Bash(npx vitest:*) Bash(vitest:*)
metadata:
  author: harness-code
  version: "1.0"
---

# Writing tests

## Before writing anything

1. Find the existing tests: `glob` for `**/*.test.*` / `**/*_test.*` / `test/**`.
   Open two or three near the code under test.
2. Copy their conventions exactly: framework, file location and name, import
   style, how they name cases, how they set up fixtures, assertion style.
   Do not introduce a second pattern.
3. Read the code under test in full, including its callers, so the cases reflect
   real usage.

## What to cover

- The behavior the task named, first.
- Happy path with representative input.
- Boundaries: empty, single element, maximum, zero, negative.
- Each failure path the code handles explicitly (thrown errors, error returns).
- For a regression test: reproduce the bug first, confirm the test fails against
  the current code, then it stays as the guard.

Do not test framework internals, private helpers with no independent contract,
or getters that only return a field.

## Finishing

- Run the suite (`pnpm test` or the project's command) and confirm the new tests
  pass and nothing else broke.
- Each test should fail if you revert the specific behavior it covers — if it
  still passes, it is asserting the wrong thing.

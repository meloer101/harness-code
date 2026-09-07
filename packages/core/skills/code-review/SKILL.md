---
name: code-review
description: Reviews a code change for correctness, edge cases, readability, and fit with the surrounding code. Use when asked to review a diff, a pull request, a branch, or specific files, or to check work before committing.
license: Apache-2.0
metadata:
  author: harness-code
  version: "1.0"
---

# Code review

Review the change the user pointed at. If they did not name one, review the
working-tree diff (`git diff` for unstaged, `git diff --staged` for staged, `git
diff main...HEAD` for a branch).

## Process

1. Read the full diff, then open each changed file for surrounding context — a
   hunk in isolation hides half the bugs.
2. For each change, ask in order:
   - **Correctness**: does it do what it claims for every input this code path
     actually receives? Off-by-one, null/undefined, empty collection, error path.
   - **Edge cases**: concurrency, partial failure, unexpected types, resource
     cleanup.
   - **Fit**: does it match the file's existing naming, structure, and error
     handling? Unrequested refactors and new configurability are findings, not bonuses.
   - **Tests**: is the new behavior covered? Would the tests fail without the change?
3. Check the change against the project's own conventions — `AGENTS.md` /
   `CLAUDE.md`, and the patterns visible in neighboring code.

For the full per-category prompts, see [references/checklist.md](references/checklist.md).

## Output

Group findings by severity: **blocking** (must fix), **should fix**, **nit**.
For each: file and line, what is wrong, and the concrete fix. Lead with the one
or two that matter most. If the change is clean, say so plainly and stop — do
not invent findings to fill a template.

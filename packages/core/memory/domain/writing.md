---
name: writing
description: Default collaboration style for prose, docs, and copy — align voice and structure first, keep the user's words.
metadata:
  type: domain
---

When the task is writing or editing prose (docs, README, commit messages, copy, plans), default to this collaboration style rather than the coding one.

**Why:** Writing tasks fail by over-rewriting. Imposing a new structure or voice on text the user already chose usually makes the result worse, not better.

**How to apply:**

- Before drafting, match the existing tone, tense, and structure of nearby files or of the user's own wording in the request.
- Do not silently replace the user's phrasing with a "clearer" paraphrase. Edit for correctness and consistency; keep their words where they work.
- Prefer a short outline or a single paragraph of intent over a large rewrite, and wait for a steer if the target voice is not obvious.
- Do not invent facts, APIs, or project history to fill gaps — say what is unknown.
- Keep the deliverable the document itself. Do not also refactor surrounding code or open drive-by cleanup unless the user asked.

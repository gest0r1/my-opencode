---
description: Create an atomic conventional Git commit from explicitly reviewed changes
---

# Commit

Create a safe, atomic commit for the current repository. Do not broaden the change set and do not push unless the user explicitly requested push/publish.

## Workflow

1. Run `git status --short`.
2. Inspect unstaged/staged diffs needed to understand the intended change.
3. If nothing is staged, propose the exact file list to stage. Do **not** use `git add .` or `git add -A` blindly.
4. Run the repository's relevant existing validation only when it is clear from project instructions/changed scope. Do not invent package-manager commands.
5. Stage only the approved/intended files.
6. Inspect `git diff --cached` and check for secrets, generated junk and unrelated changes.
7. Generate one concise conventional message: `<type>(optional-scope): description`.
8. Commit.
9. Report commit SHA, included files and validation result.
10. Push only when the user explicitly asked to push/publish or the current approved workflow explicitly requires it.

## Safety

- Never stage `.env`, keys, credentials or unrelated files.
- Never rewrite history, force-push, amend, reset or clean without explicit instruction.
- Never bypass failed required checks without explicit user decision.
- If the staged set contains multiple unrelated changes, stop and propose splitting them.
- A commit command is not permission to deploy or publish.

## Message types

Use standard types when appropriate: `feat`, `fix`, `refactor`, `docs`, `test`, `ci`, `chore`, `perf`, `build`, `revert`.

Keep the first line under 72 characters and use imperative wording. Emoji is optional and must not replace the conventional type.

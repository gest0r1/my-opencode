---
description: Small change without PLAN (docs, texts, tests, code up to ~50 lines in one module); moves to /pipeline-plan when it is bigger
tags:
  - pipeline
  - quick
---

# Pipeline Quick

`$ARGUMENTS` is the task text. Use it for a change that cannot alter a decision or a business story:
- documentation;
- user-facing texts;
- tests that keep every check;
- code up to about 50 changed lines in one module.

No stories, architecture, contracts or manifest. Work in the current feature branch of the owner's worktree, never on `main`. Owner messages are in Russian.

All CLIs run as `$HOME/.config/opencode/node_modules/.bin/tsx $HOME/.config/opencode/skills/task-management/scripts/<cli>`. `<quick-id>` is `quick-<yyyymmdd-hhmm>-<short-slug>`.

1. Dispatch `CoderAgent` with the task, the quick id and these limits:
   - stay within one module;
   - no dependency, CI, build-config, migration or protected-path change;
   - never delete, skip or weaken a test;
   - run only the tests the change touches.

   When the worker answers that the task needs more than this, go to step 6.
2. `git-worktree-cli.ts quick-check <quick-id>`.
   - `status: QUICK`: continue.
   - `status: NEEDS_PLAN`: go to step 6 with its `reasons[]`. Do not trim the change to squeeze it under the limit.
3. Run the affected checks the project already has for the changed files, through `GateRunner` with an explicit limit of 3 shell calls and 10 minutes. A failure goes back to `CoderAgent` once. A second failure goes to step 6.
4. When `code_review_required` is true, dispatch `QuickReviewer` with the task text and the quick id.
   - `needs_revision`: one more CoderAgent round, then `quick-check` and the review again.
   - `needs_plan`, or a second `needs_revision`: go to step 6.

   Docs, texts and tests alone need no review.
5. `git-worktree-cli.ts quick-commit <quick-id> --message "<conventional commit message>"`. It refuses if the change moved after `quick-check` or if the code review does not cover this exact diff. Report in Russian:
   - the commit;
   - the files;
   - the checks run;
   - the review verdict.

   It does not push.
6. **Moving to PLAN.** Leave the working tree as it is and stop. Tell the owner in Russian, in plain words, why the change does not fit (from `reasons[]`). Give the exact command to continue: `/pipeline-plan <the same task text>`. Do not start PLAN yourself.

Never use QuickReviewer, `quick-check` or `quick-commit` inside a PLAN or RUN.

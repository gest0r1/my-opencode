---
description: Tag the release of a merged versioned run on its tested candidate and close the milestone
tags:
  - pipeline
  - release
---

# Pipeline Release

`$ARGUMENTS` is the `run-id` of a completed RUN whose manifest has `release.version` (a PLAN made with `--milestone`). Run it after the owner merged the delivery PR with a merge commit.

1. Run:

```text
$HOME/.config/opencode/node_modules/.bin/tsx $HOME/.config/opencode/skills/task-management/scripts/github-pr-cli.ts release <run-id>
```

2. The CLI checks that the PR is merged and that its head is the tested candidate from `candidate.json`, and that the merge commit contains that candidate. It then sets the annotated tag `vX.Y.Z` on the candidate, pushes it, closes the milestone when no Issue in it is still open, and writes `.tmp/pipelines/<run-id>/release.json`. Running it again changes nothing.
3. Report in Russian:
   - the tag;
   - the candidate SHA;
   - the merge commit;
   - whether the milestone closed.

   On an error, quote it and say what the owner should do:
   - `RELEASE_PR_NOT_MERGED`: merge the PR first.
   - `RELEASE_NEEDS_MERGE_COMMIT`: the PR was squashed or rebased, so the tested commit is not on main. The release needs a new RUN on main.
   - `RELEASE_TAG_EXISTS`: the tag already points elsewhere. The owner decides.

Never set or move a tag with raw `git`, and never pick a version: it comes from the manifest.

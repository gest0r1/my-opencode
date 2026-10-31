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
3. Release assets. When the project documents its own release command (its `AGENTS.md`, `RELEASE.md` or a script such as `scripts/release.sh`), run it for the tag; the owner confirms. Otherwise create the GitHub release with the client notes from acceptance:

```text
gh release create vX.Y.Z --verify-tag --title vX.Y.Z --notes-file .tmp/pipelines/<run-id>/acceptance/client-notes.md
```

   GitHub Actions are not used: assets the project builds are built here and attached by that command, never by a workflow.
4. Prod is installed by the owner, not by the pipeline. Give the exact command from the project's install documentation for the tag, for example for sevami:

```text
cd /opt/sevami/deploy/sevami && sudo git fetch --tags origin && sudo git checkout --detach vX.Y.Z && sudo ./install.sh update --target prod --version vX.Y.Z --confirm-prod
```

   The first install of a contour uses `install` instead of `update` and creates its `config.env`; later updates reuse it. Never run it yourself and never add a prod target to `/etc/opencode/deploy-targets`.
5. Report in Russian:
   - the tag;
   - the candidate SHA;
   - the merge commit;
   - whether the milestone closed;
   - the release link and assets;
   - the prod install command.

   On an error, quote it and say what the owner should do:
   - `RELEASE_PR_NOT_MERGED`: merge the PR first.
   - `RELEASE_NEEDS_MERGE_COMMIT`: the PR was squashed or rebased, so the tested commit is not on main. The release needs a new RUN on main.
   - `RELEASE_TAG_EXISTS`: the tag already points elsewhere. The owner decides.

Never set or move a tag with raw `git`, and never pick a version: it comes from the manifest.

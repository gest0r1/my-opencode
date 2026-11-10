# GitHub Support request — issue #18 (draft; send after remote refs are rewritten)

Repository: **gest0r1/my-opencode** (private; may become public later).

We found hardcoded credentials in historic Git blobs, including an Exchange API header, an ITOP token and Google OAuth client ID/secret/refresh token. No values are included in this report. Some credentials cannot practicably be rotated immediately.

We used `git-filter-repo --sensitive-data-removal --replace-text` against a complete private mirror, including merges and archived refs. Local post-rewrite scanning found zero candidates for those five known classes. The preflight detected **62 historical PR refs** that cannot be updated by normal Git push.

**Before sending:** verify that all **33** remaining GitHub branch/tag refs have actually been rewritten, record new `main` SHA, and reconfirm the number of PR refs. Local dry-run results are not proof of remote cleanup.

Please assist with:
1. Removing or invalidating affected `refs/pull/*` and cached pull-request diffs and commit views.
2. Removing orphaned Git objects through repository garbage collection when all writable refs are scrubbed.
3. Identifying retained release assets, Actions logs/artifacts, LFS objects or other GitHub snapshots exposing old values, and their removal procedures.
4. Confirming whether old raw Git object URLs / commit SHAs remain retrievable after cleanup.

We have not copied secret values to issue comments or logs. We can supply original/replaced SHA mapping and `git-filter-repo` first-changed-commits metadata through a secure channel upon request.

**Important:** the repo stays private until GitHub cache/PR-ref checks and residual-risk review pass. Git history rewriting cannot revoke credentials or erase third-party clones.

Reference: https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository

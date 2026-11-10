# GitHub Support request — sensitive history removal (#18)

Repository: gest0r1/my-opencode; currently PRIVATE, potentially public later.

On 2026-11-10, five distinct literal credentials were found in old Git blobs: Exchange X-API-Key, ITOP token, Google OAuth client ID/client secret/refresh token. We cannot rotate all credentials immediately. Do not reproduce their values.

COMPLETED:
- Removed 36 merged/obsolete branches, preserving 33 branches.
- After encrypted backup, rewrote all 33 writable refs atomically with git-filter-repo and git push --atomic --force-with-lease. Each ref's old SHA was checked.
- Current cleaned main SHA: 31ea66697697f6daa5000cf13028e152d031c1a5.
- Local post-rewrite scan found zero candidates for the five known secret classes; branch tree path/mode/type inventory preserved.
- Verified run: https://github.com/gest0r1/my-opencode/actions/runs/42858968690
- Pre-rewrite inventory showed 61 GitHub-managed PR refs. These could not be updated with a normal push.

REQUEST TO GITHUB SUPPORT:
1. Identify and remove secret-bearing refs/pull/* where supported and purge related cached PR diffs, commit views and raw object URLs.
2. Perform applicable garbage collection after the rewritten writable refs and report residual visibility of old commit SHAs.
3. Identify possible residual Actions logs/artifacts, release files, LFS and cached archives, with removal options.
4. Confirm whether old original secret-bearing Git objects can still be retrieved.

An encrypted backup exists as a restricted GitHub Actions artifact named issue18-encrypted-history-before-rewrite from run 42858968690, expiring 2026-11-17. Decryption requires the owner's matching SSH private key. The owner should preserve an independent encrypted backup if longer retention is necessary.

We can supply original/rewrite SHA mapping and git-filter-repo first-changed-commits through secure channels, without credential values.

Repo remains PRIVATE until the PR-ref/cache scan and residual-risk assessment finish. Rewriting Git cannot revoke leaked tokens or erase third-party clones.

Reference: https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository

#!/usr/bin/env bash
set -Eeuo pipefail
# Local rewrite only; never pushes/deletes remote refs.
(( $# == 1 )) || { echo 'usage: security-history-rewrite.sh /absolute/private/replacements.txt' >&2; exit 2; }
[[ "${ISSUE18_APPROVE_LOCAL_REWRITE:-}" == yes ]] || { echo "Set ISSUE18_APPROVE_LOCAL_REWRITE=yes for local rewrite only" >&2; exit 2; }
[[ "$(git rev-parse --is-bare-repository 2>/dev/null)" == true ]] || exit 2
[[ "$(git rev-parse --is-shallow-repository)" == false ]] || exit 2
command -v git-filter-repo >/dev/null || { echo 'git-filter-repo >=2.47 required' >&2; exit 2; }
replacements=$1
[[ "$replacements" = /* && -s "$replacements" ]] || exit 2
replacements="$(cd "$(dirname "$replacements")" && pwd -P)/$(basename "$replacements")"
gitdir="$(cd "$(git rev-parse --absolute-git-dir)" && pwd -P)"
[[ "$replacements" != "$gitdir/"* ]] || { echo "Replacement secrets cannot be in Git directory" >&2; exit 2; }
mode=$(stat -c '%a' "$replacements")
(( (8#$mode & 8#077) == 0 )) || { echo "Replacement file must be 0600 or stricter" >&2; exit 2; }
remote=$(git remote get-url origin 2>/dev/null || true)
case "$remote" in
  https://github.com/gest0r1/my-opencode|https://github.com/gest0r1/my-opencode.git|git@github.com:gest0r1/my-opencode.git) ;;
  *) echo 'Unexpected origin; aborting' >&2; exit 2 ;;
esac
git filter-repo --sensitive-data-removal --replace-text "$replacements"
echo 'Local rewrite complete. Repeat audit, validate refs, coordinate GitHub PR cache cleanup; never blindly force --mirror.'

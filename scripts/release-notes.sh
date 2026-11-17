#!/bin/sh
# Writes a release's notes from its commits (Conventional Commits, whose
# subjects are written for users): ./scripts/release-notes.sh 0.2.0
#
# Covers the commits since the previous tag, or all of them for the first
# release. feat: commits go under "New", fix: under "Fixes", each with its
# body (minus Co-Authored-By lines) beneath it; chore:, docs: and the rest
# are left out. A release's notes written by hand, in releases/<tag>.md, are
# used instead when there are any. Used by .github/workflows/release.yml.
set -eu

tag=${1:?usage: release-notes.sh <tag>}

# Notes written by hand for this release (releases/<tag>.md) take the place of the commits'.
if [ -f "releases/$tag.md" ]; then
  previous=$(git describe --tags --abbrev=0 "$tag^" 2>/dev/null || true)
  cat "releases/$tag.md"
  [ -n "$previous" ] && printf '\n**Full changelog:** https://github.com/rowoldtw/muta/compare/%s...%s\n' "$previous" "$tag"
  exit 0
fi
previous=$(git describe --tags --abbrev=0 "$tag^" 2>/dev/null || true)
range=${previous:+$previous..}$tag

# One record per commit: type, subject and body, split by \037 and ended by \036.
git log --reverse --format='%s%x1f%b%x1e' "$range" | awk -v previous="$previous" -v tag="$tag" '
  BEGIN { RS = "\036"; FS = "\037" }
  {
    sub(/^\n+/, "", $1)
    if (!match($1, /^[a-z]+(\([^)]*\))?!?: /)) next
    type = substr($1, 1, index($1, ":") - 1)
    sub(/\(.*/, "", type); sub(/!$/, "", type)
    if (type != "feat" && type != "fix") next
    subject = substr($1, RLENGTH + 1)
    entry = "- " toupper(substr(subject, 1, 1)) substr(subject, 2)
    n = split($2, lines, "\n")
    for (i = 1; i <= n; i++)
      if (lines[i] != "" && lines[i] !~ /^Co-Authored-By:/) entry = entry "\n  " lines[i]
    notes[type] = notes[type] entry "\n"
  }
  END {
    if (notes["feat"] != "") printf "## New\n\n%s\n", notes["feat"]
    if (notes["fix"] != "") printf "## Fixes\n\n%s\n", notes["fix"]
    if (notes["feat"] == "" && notes["fix"] == "") print "Behind-the-scenes changes only."
    if (previous != "") printf "**Full changelog:** https://github.com/rowoldtw/muta/compare/%s...%s\n", previous, tag
  }
'

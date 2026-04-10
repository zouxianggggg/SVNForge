#!/usr/bin/env bash

set -euo pipefail

if ! command -v svn >/dev/null 2>&1; then
  echo "svn executable not found" >&2
  exit 1
fi

if ! command -v svnadmin >/dev/null 2>&1; then
  echo "svnadmin executable not found" >&2
  exit 1
fi

tmpdir="$(mktemp -d "${TMPDIR:-/tmp}/svnlens-smoke.XXXXXX")"
repo_dir="$tmpdir/repo"
wc_dir="$tmpdir/wc"
patch_file="$tmpdir/working.patch"
repo_url="file://$repo_dir"

cleanup() {
  rm -rf "$tmpdir"
}
trap cleanup EXIT

echo "[smoke] creating local repository"
svnadmin create "$repo_dir"
svn mkdir "$repo_url/trunk" "$repo_url/branches" "$repo_url/tags" -m "Initialize standard layout" >/dev/null

echo "[smoke] checkout trunk"
svn checkout "$repo_url/trunk" "$wc_dir" >/dev/null

echo "[smoke] add and commit file"
printf 'alpha\n' > "$wc_dir/app.txt"
svn add "$wc_dir/app.txt" >/dev/null
svn commit "$wc_dir" -m "Add app.txt" >/dev/null

echo "[smoke] create feature branch and switch"
svn copy "$repo_url/trunk" "$repo_url/branches/feature-smoke" -m "Create feature branch" >/dev/null
svn switch "$repo_url/branches/feature-smoke" "$wc_dir" >/dev/null

echo "[smoke] commit on branch"
printf 'beta\n' >> "$wc_dir/app.txt"
svn commit "$wc_dir" -m "Feature branch change" >/dev/null

echo "[smoke] verify log, blame, diff and ignore"
svn log --xml -v "$wc_dir" >/dev/null
svn blame --xml "$wc_dir/app.txt" >/dev/null
printf 'temp.log\n' > "$wc_dir/temp.log"
svn propset svn:ignore "temp.log" "$wc_dir" >/dev/null
svn propget svn:ignore "$wc_dir" | grep -q "temp.log"

echo "[smoke] switch back to trunk and merge branch"
svn switch "$repo_url/trunk" "$wc_dir" >/dev/null
svn merge "$repo_url/branches/feature-smoke" "$wc_dir" >/dev/null
svn status "$wc_dir" | grep -Eq '^[AM]'

echo "[smoke] export and re-apply patch"
printf 'gamma\n' >> "$wc_dir/app.txt"
svn diff "$wc_dir/app.txt" > "$patch_file"
svn revert "$wc_dir/app.txt" >/dev/null
svn patch "$patch_file" "$wc_dir" >/dev/null
svn diff "$wc_dir/app.txt" | grep -q "gamma"

echo "[smoke] success"
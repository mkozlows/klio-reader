#!/usr/bin/env bash
# Release a new version: bump the version everywhere, tag it, publish a
# GitHub release with the meson dist tarball (which includes foliate-js),
# and build it on COPR.
#
#   ./release.sh 0.2.0 "Add bookmarks"
#
# With DRY_RUN=1, stops after building and testing the tarball and undoes
# the version bump, without pushing or publishing anything.
set -euo pipefail

die() { echo "release: $*" >&2; exit 1; }

version=${1:-}
notes=${2:-}
[[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ && -n $notes && $notes != *$'\n'* ]] ||
    die "usage: $0 VERSION NOTES   (e.g. $0 0.2.0 \"Add bookmarks\")"
tag=v$version

cd "$(dirname "$0")"

for cmd in git meson gh copr-cli; do
    command -v "$cmd" >/dev/null || die "$cmd is not installed"
done

current=$(sed -n "s/^  version: '\(.*\)',/\1/p" meson.build)
[[ $(printf '%s\n' "$current" "$version" | sort -V | tail -1) == "$version" &&
    $version != "$current" ]] || die "$version is not newer than $current"
[[ $(git branch --show-current) == main ]] || die "not on main"
[[ -z $(git status --porcelain) ]] || die "there are uncommitted changes"
git fetch -q origin
[[ $(git rev-parse HEAD) == $(git rev-parse origin/main) ]] ||
    die "main is not in sync with origin/main"
! git rev-parse -q --verify "refs/tags/$tag" >/dev/null || die "$tag already exists"

# Until something is pushed, a failure undoes the version bump, commit and tag
start=$(git rev-parse HEAD)
builddir=$(mktemp -d)
rollback() {
    git tag -d "$tag" >/dev/null 2>&1 || true
    git reset -q --hard "$start"
}
trap 'rollback; rm -rf "$builddir"' EXIT

# Bump the version
today=$(date +%F)
sed -i "s/^  version: '.*',/  version: '$version',/" meson.build
sed -i "s/^export const VERSION = '.*'/export const VERSION = '$version'/" src/config.js
sed -i "s|^  <releases>|&\n    <release version=\"$version\" date=\"$today\"/>|" \
    data/org.klio.Reader.metainfo.xml
# Escape for sed, and % for rpm macros
entry_notes=$(printf '%s' "$notes" | sed -e 's/[\\&|]/\\&/g' -e 's/%/%%/g')
entry="* $(LC_ALL=C date '+%a %b %d %Y') $(git config user.name) <$(git config user.email)> - $version-1"
sed -i -e "s/^Version: .*/Version:        $version/" \
    -e "s/^Release: .*/Release:        1%{?dist}/" \
    -e "s|^%changelog|&\n$entry\n- $entry_notes\n|" klio-reader.spec

git commit -qam "Release $version"
git tag -a "$tag" -m "Klio Reader $version"

# Builds and tests the tarball's contents, not the working tree
meson setup "$builddir" >/dev/null
meson dist -C "$builddir"
tarball=$builddir/meson-dist/klio-reader-$version.tar.xz

if [[ -n ${DRY_RUN:-} ]]; then
    echo "release: dry run OK; undoing the version bump"
    exit 0
fi

git push -q --atomic origin main "$tag"
# From here on, rerun whichever of these steps failed by hand
trap 'rm -rf "$builddir"' EXIT

gh release create "$tag" "$tarball" --title "Klio Reader $version" --notes "$notes"
copr-cli build-package klio-reader --name klio-reader

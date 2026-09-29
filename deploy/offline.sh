#!/bin/sh
set -eu
action=${1:-verify}
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$root"
sha256sum -c SHA256SUMS
expected_files=$(($(wc -l < SHA256SUMS) + 2))
actual_files=$(find . -type f | wc -l)
if [ "$actual_files" -ne "$expected_files" ]; then
  echo 'Bundle contains missing or extra files' >&2
  exit 1
fi
if [ "$action" = load ]; then
  index=0
  while read -r image expected; do
    archive=$(printf 'images/%02d.tar' "$index")
    docker load -i "$archive"
    actual=$(docker image inspect --format '{{.Id}}' "$image")
    if [ "$actual" != "$expected" ]; then
      echo "Image ID mismatch: $image" >&2
      exit 1
    fi
    index=$((index + 1))
  done < IMAGES.txt
elif [ "$action" != verify ]; then
  echo 'Usage: sh deploy/offline.sh [verify|load]' >&2
  exit 2
fi

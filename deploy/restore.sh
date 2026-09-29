#!/bin/sh
set -eu

if [ "$#" -ne 2 ]; then
  echo 'Usage: sh deploy/restore.sh PROJECT backup-YYYYMMDDTHHMMSSZ' >&2
  exit 2
fi
project=$1
backup=$2
case "$project" in
  ''|arm112|*[!a-z0-9_-]*) echo 'Choose a NEW project name other than arm112 (lowercase letters, digits, - or _).' >&2; exit 2 ;;
esac
case "$backup" in
  backup-[0-9]*T[0-9]*Z) ;;
  *) echo 'Invalid backup directory name' >&2; exit 2 ;;
esac
if docker volume inspect "${project}_db-data" >/dev/null 2>&1 || docker volume inspect "${project}_audio-data" >/dev/null 2>&1; then
  echo "Project $project already has data; restore requires fresh volumes." >&2
  exit 2
fi
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$root"
# Git Bash must pass the container path unchanged to Docker on Windows.
export MSYS_NO_PATHCONV=1
docker compose -p "$project" -f deploy/docker-compose.yml -f deploy/restore.compose.yml up -d --wait db
docker compose -p "$project" -f deploy/docker-compose.yml -f deploy/restore.compose.yml run --rm --no-deps restore "/backups/$backup"
echo "Restored into project $project. Volumes were retained; use docker compose -p $project ... to inspect."

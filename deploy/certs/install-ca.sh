#!/usr/bin/env sh
set -eu
test "$#" -eq 1 || { echo 'Укажите путь к ca.crt' >&2; exit 1; }
sudo install -m 0644 "$1" /usr/local/share/ca-certificates/arm112-dev.crt
sudo update-ca-certificates

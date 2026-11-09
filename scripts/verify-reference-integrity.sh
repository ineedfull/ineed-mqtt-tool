#!/usr/bin/env bash

set -euo pipefail
export LC_ALL=C

usage() {
  echo "Usage: $0 [--write] <electron-root> <tauri-root> [manifest-dir]" >&2
}

write_mode=false
if [[ "${1:-}" == "--write" ]]; then
  write_mode=true
  shift
fi

if [[ $# -lt 2 || $# -gt 3 || "${1:-}" == -* ]]; then
  usage
  exit 2
fi

electron_root=$1
tauri_root=$2
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
manifest_dir=${3:-"$script_dir/../docs/verification/reference-manifests"}

if [[ ! -d "$electron_root" ]]; then
  echo "Electron reference root is not a directory: $electron_root" >&2
  exit 2
fi

if [[ ! -d "$tauri_root" ]]; then
  echo "Tauri reference root is not a directory: $tauri_root" >&2
  exit 2
fi

if [[ "$write_mode" == true ]]; then
  mkdir -p "$manifest_dir"
elif [[ ! -f "$manifest_dir/electron.sha256" || ! -f "$manifest_dir/tauri.sha256" ]]; then
  echo "Reference manifests are missing from: $manifest_dir" >&2
  exit 2
fi

manifest_dir=$(cd "$manifest_dir" && pwd)
electron_temp=""
tauri_temp=""

cleanup() {
  if [[ -n "$electron_temp" ]]; then
    rm -f "$electron_temp"
  fi
  if [[ -n "$tauri_temp" ]]; then
    rm -f "$tauri_temp"
  fi
}
trap cleanup EXIT HUP INT TERM

if [[ "$write_mode" == true ]]; then
  electron_temp=$(mktemp "$manifest_dir/.electron.sha256.XXXXXX")
  tauri_temp=$(mktemp "$manifest_dir/.tauri.sha256.XXXXXX")
else
  electron_temp=$(mktemp "${TMPDIR:-/tmp}/mqtt-electron-reference.XXXXXX")
  tauri_temp=$(mktemp "${TMPDIR:-/tmp}/mqtt-tauri-reference.XXXXXX")
fi

generate_manifest() {
  local root=$1
  local runtime=$2
  local output=$3

  (
    cd "$root"
    if [[ "$runtime" == "tauri" ]]; then
      find . \( -type d \( -name .git -o -name node_modules -o -name dist -o -name release -o -name target \) -prune \) -o -type f -print
    else
      find . \( -type d \( -name .git -o -name node_modules -o -name dist -o -name release \) -prune \) -o -type f -print
    fi | sort | while IFS= read -r path; do
      shasum -a 256 -- "$path"
    done
  ) > "$output"
}

generate_manifest "$electron_root" electron "$electron_temp"
generate_manifest "$tauri_root" tauri "$tauri_temp"

if [[ "$write_mode" == true ]]; then
  chmod 0644 "$electron_temp" "$tauri_temp"
  mv -f "$electron_temp" "$manifest_dir/electron.sha256"
  electron_temp=""
  mv -f "$tauri_temp" "$manifest_dir/tauri.sha256"
  tauri_temp=""
  exit 0
fi

status=0
command -p diff -u "$manifest_dir/electron.sha256" "$electron_temp" || status=$?
command -p diff -u "$manifest_dir/tauri.sha256" "$tauri_temp" || status=$?
exit "$status"

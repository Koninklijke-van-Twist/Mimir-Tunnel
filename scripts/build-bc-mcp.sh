#!/usr/bin/env bash
# Bouwt business-central-mcp uit de vastgepinde fork-commit en legt de tarball in
# vendor/business-central-mcp.tgz. Repo en commit staan in package.json onder "bcMcp".
#
#   scripts/build-bc-mcp.sh [app-map]     (standaard: de repo-root)
#
# devDependencies (TypeScript) komen alleen in een tijdelijke bouwmap.
set -euo pipefail

app="$(cd "${1:-$(dirname "$0")/..}" && pwd)"
repo="$(node -p 'require(process.argv[1]).bcMcp.repo' "$app/package.json")"
rev="$(node -p 'require(process.argv[1]).bcMcp.rev' "$app/package.json")"
[[ "$rev" =~ ^[0-9a-f]{40}$ ]] || { echo "FOUT: bcMcp.rev moet een volledige commit-SHA zijn." >&2; exit 1; }

work="$(mktemp -d "${TMPDIR:-/tmp}/bc-mcp-build.XXXXXX")"
trap 'rm -rf -- "$work"' EXIT

echo "==> business-central-mcp bouwen uit $repo @ $rev."
git -C "$work" init -q
git -C "$work" fetch -q --depth 1 "$repo" "$rev"
git -C "$work" checkout -q FETCH_HEAD
(cd "$work" && npm ci --no-audit --no-fund && npm run build && npm pack --silent >/dev/null)

mkdir -p "$app/vendor"
mv -f -- "$work"/business-central-mcp-*.tgz "$app/vendor/business-central-mcp.tgz"
echo "==> vendor/business-central-mcp.tgz klaar."

# De tgz wordt lokaal gebouwd en is niet byte-gelijk aan die van de lock: integriteit uit de lock halen.
if [[ -f "$app/package-lock.json" ]]; then
  node -e 'const f=process.argv[1],fs=require("fs"),l=JSON.parse(fs.readFileSync(f));const e=l.packages?.["node_modules/business-central-mcp"];if(e)delete e.integrity;fs.writeFileSync(f,JSON.stringify(l,null,2)+"\n")' "$app/package-lock.json"
fi

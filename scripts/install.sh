#!/bin/sh
# Installs aludra from this checkout: builds it, installs the package with npm, and restarts the service if there is
# one, so it runs the new version. Run it again after pulling to update.
#   git clone git@github.com:brad-j/aludra.git && cd aludra && sh scripts/install.sh
set -eu
cd "$(dirname "$0")/.."

need() {
	command -v "$1" >/dev/null 2>&1 || { echo "aludra: $2" >&2; exit 1; }
}
need node "needs Node 22.18 or later (https://nodejs.org)"
need npm "needs npm, which comes with Node"
need pnpm "builds with pnpm: run corepack enable pnpm, or see https://pnpm.io/installation"
node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 18) ? 0 : 1)' \
	|| { echo "aludra: needs Node 22.18 or later; this is $(node --version)" >&2; exit 1; }

pnpm install --frozen-lockfile
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT
pnpm pack --pack-destination "$out" >/dev/null
npm install --global --no-fund --no-audit "$out"/aludra-*.tgz
echo "installed $(command -v aludra)"

status=0
aludra service status >/dev/null 2>&1 || status=$?
if [ "$status" -eq 0 ] || [ "$status" -eq 1 ]; then
	aludra service install
elif [ ! -e "${XDG_CONFIG_HOME:-$HOME/.config}/aludra/config.json" ]; then
	echo "next: aludra init"
else
	echo "next: aludra doctor, then aludra service install"
fi

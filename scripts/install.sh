#!/bin/sh
# Installs aludra from this checkout: builds it, installs the package with npm, and restarts the service if there is
# one, so it runs the new version. Run it again after pulling to update. A running service is stopped just before npm
# replaces the package, so it never starts from half-written files, and started again after, by its reinstall; the
# build happens first, so a failed build leaves it running.
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

# Whether the service is installed, read before npm touches the package.
status=0
if command -v aludra >/dev/null 2>&1; then aludra service status >/dev/null 2>&1 || status=$?; else status=3; fi

# Stopped through systemd or launchd directly, not the aludra command, whose files are about to be replaced.
stopped=no
if [ "$status" -eq 0 ]; then
	if command -v systemctl >/dev/null 2>&1 && systemctl --user is-active --quiet aludra.service 2>/dev/null; then
		systemctl --user stop aludra.service && stopped=yes
	elif command -v launchctl >/dev/null 2>&1 && launchctl print "gui/$(id -u)/io.bradjohnson.aludra" >/dev/null 2>&1; then
		launchctl bootout "gui/$(id -u)/io.bradjohnson.aludra" && stopped=yes
	fi
fi
# A failed npm install brings the old service back as it was.
restore() {
	if [ "$stopped" = yes ]; then
		if command -v systemctl >/dev/null 2>&1; then systemctl --user start aludra.service; else launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/io.bradjohnson.aludra.plist"; fi
	fi
}
npm install --global --no-fund --no-audit "$out"/aludra-*.tgz || { restore; exit 1; }
echo "installed $(command -v aludra)"

if [ "$status" -eq 0 ] || [ "$status" -eq 1 ]; then
	aludra service install
elif [ ! -e "${XDG_CONFIG_HOME:-$HOME/.config}/aludra/config.json" ]; then
	echo "next: aludra init"
else
	echo "next: aludra doctor, then aludra service install"
fi

#!/bin/sh
# Install the agentbox command on your own computer (macOS or Linux, Node 22+): its one dependency, then
# a link in a folder on your PATH. Then: agentbox login <name> --url <portal URL>   (docs/CLI.md)
set -eu
here=$(cd "$(dirname "$0")" && pwd)
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' 2>/dev/null || { echo "agentbox needs Node 22 or newer (node -v)"; exit 1; }
(cd "$here" && npm ci --omit=dev --no-audit --no-fund --silent)
chmod +x "$here/agentbox.mjs"
for dir in "${AGENTBOX_BIN:-}" /opt/homebrew/bin /usr/local/bin "$HOME/.local/bin"; do
  [ -n "$dir" ] && [ -d "$dir" ] && [ -w "$dir" ] || continue
  ln -sf "$here/agentbox.mjs" "$dir/agentbox"
  echo "Installed: $dir/agentbox → $here/agentbox.mjs"
  case ":$PATH:" in *":$dir:"*) ;; *) echo "Add $dir to your PATH." ;; esac
  echo "Next: agentbox login <name> --url https://<node>.ts.net    (or --url http://localhost:8720 --lima <vm>)"
  exit 0
done
echo "No writable folder on your PATH found; set AGENTBOX_BIN=<dir> and run again."
exit 1

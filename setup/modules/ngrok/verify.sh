#!/usr/bin/env bash
# ngrok: the authtoken (and domain, if set) work: open a test tunnel for a few seconds, then close it.
# It points at the guest server's port; nothing is shared (there's no live link, so no guest gets in).
source "$(dirname "$0")/../../lib/common.sh"
have ngrok || die "ngrok isn't installed (step 'install')"
env_file="$(cfg paths.secrets)/ngrok.env"
[ -r "$env_file" ] || die "no $env_file yet (step 'token')"
token="$(sed -n 's/^NGROK_AUTHTOKEN=//p' "$env_file" | tr -d '"[:space:]')"
domain="$(sed -n 's/^NGROK_DOMAIN=//p' "$env_file" | tr -d '"[:space:]' | sed 's#^https\?://##; s#/*$##')"
[ -n "$token" ] || die "NGROK_AUTHTOKEN is empty in $env_file"
port="$(cfg ports.share)"; port="${port:-7785}"
conf="$(mktemp -d)"; trap 'rm -rf "$conf"' EXIT
printf 'version: "2"\nweb_addr: false\nupdate_check: false\n' > "$conf/ngrok.yml"
args=(http "127.0.0.1:$port" --config "$conf/ngrok.yml" --log stdout --log-format json --inspect=false)
[ -n "$domain" ] && args+=(--url "https://$domain")
out="$(NGROK_AUTHTOKEN="$token" timeout 20 ngrok "${args[@]}" 2>&1 | python3 -c '
import json, sys
for line in sys.stdin:
    try: j = json.loads(line)
    except Exception: continue
    if j.get("msg") == "started tunnel" and str(j.get("url", "")).startswith("https://"):
        print("ok " + j["url"]); sys.exit(0)
    if j.get("lvl") in ("eror", "crit") and j.get("err"):
        print("error " + str(j["err"]).splitlines()[0]); sys.exit(0)
print("error no tunnel within 20 seconds")
')"
case "$out" in
  ok\ *) echo "ngrok ok: links will use ${out#ok }" ;;
  *"already online"*) echo "ngrok ok: the portal's tunnel is using the domain right now" ;;
  *) die "ngrok: ${out#error }" ;;
esac

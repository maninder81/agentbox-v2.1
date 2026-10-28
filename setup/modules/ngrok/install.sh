#!/usr/bin/env bash
# ngrok: the agent from ngrok's official apt repository (https://ngrok.com/download). Idempotent.
source "$(dirname "$0")/../../lib/common.sh"
need_root
apt_ensure curl ca-certificates gnupg
if ! have ngrok; then
  log "ngrok (apt)"
  curl -fsSL https://ngrok-agent.s3.amazonaws.com/ngrok.asc | gpg --dearmor --yes -o /usr/share/keyrings/ngrok.gpg
  chmod 0644 /usr/share/keyrings/ngrok.gpg
  echo "deb [signed-by=/usr/share/keyrings/ngrok.gpg] https://ngrok-agent.s3.amazonaws.com bookworm main" > /etc/apt/sources.list.d/ngrok.list
  wait_for_apt && apt-get update -qq && apt_install ngrok
fi
ngrok version
echo "ngrok: installed; next, the owner saves the authtoken (agentbox secret set ngrok.env)"

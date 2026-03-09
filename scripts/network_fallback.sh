#!/usr/bin/env bash
set -euo pipefail

# Minimal network fallback helper for Raspberry Pi:
# 1) Try known Wi-Fi profiles in station mode
# 2) If none connected, start AP profile `OrbitDeck-AP`

KNOWN_PROFILES=$(nmcli -t -f NAME connection show | grep -v "^OrbitDeck-AP$" || true)
ACTIVE_WIFI=$(nmcli -t -f ACTIVE,TYPE,NAME connection show --active | awk -F: '$1=="yes" && $2=="802-11-wireless" {print $3}')

if [[ -n "${ACTIVE_WIFI}" ]]; then
  echo "Connected to Wi-Fi: ${ACTIVE_WIFI}"
  exit 0
fi

if [[ -n "${KNOWN_PROFILES}" ]]; then
  while IFS= read -r profile; do
    [[ -z "$profile" ]] && continue
    echo "Trying profile: $profile"
    if nmcli connection up "$profile" >/dev/null 2>&1; then
      echo "Connected using profile: $profile"
      exit 0
    fi
  done <<< "$KNOWN_PROFILES"
fi

echo "No known SSIDs available. Starting AP fallback profile OrbitDeck-AP"
nmcli connection up "OrbitDeck-AP"

#!/bin/bash
RES=$(xrandr | grep '\*' | head -1 | awk '{print $1}')
WIDTH=$(echo $RES | cut -d'x' -f1)
HEIGHT=$(echo $RES | cut -d'x' -f2)

PROFILE_DIR="$(mktemp -d)"

FINGERPRINT=$(
  openssl s_client -connect "localhost:9090" </dev/null 2>/dev/null \
  | openssl x509 -noout -fingerprint -sha256 \
  | cut -d= -f2
)
echo -n "localhost:9090 OID.2.16.840.1.101.3.4.2.1 ${FINGERPRINT} U" > ${PROFILE_DIR}/cert_override.txt

exec firefox --profile "${PROFILE_DIR}" --no-remote --new-instance  --kiosk --width=$WIDTH --height=$HEIGHT https://localhost:9090

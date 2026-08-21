#!/bin/bash
# Runs inside a privileged debian:trixie container with the repo at /build.
# Produces out/<name>.img.zst plus a sha256 checksum.
set -euo pipefail

IMAGE_NAME="${IMAGE_NAME:-itgmania-amd64}"
IMAGE_SIZE="3500M"
STEPMANIA_PASSWORD="1234"
export STEPMANIA_PASSWORD

cd /build

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends \
  vmdb2 debootstrap debian-archive-keyring \
  parted kpartx dosfstools e2fsprogs zerofree \
  ansible python3-passlib \
  ca-certificates zstd

mkdir -p out .cache

# vmdb2 has no user-defined template variables, so patch the size in.
sed -i "s/size: to_be_changed/size: ${IMAGE_SIZE}/" \
	images/generic/debian13-amd64.vmdb

vmdb2 \
  --verbose \
  --output "out/${IMAGE_NAME}.img" \
  --rootfs-tarball ".cache/rootfs-trixie-amd64.tar.gz" \
  --log "out/${IMAGE_NAME}.log" \
  images/generic/debian13-amd64.vmdb

# vmdb2 cannot set parted flags, so mark the ESP now that the image is
# built and nothing is attached to it.
parted -s "out/${IMAGE_NAME}.img" set 1 esp on
parted -s "out/${IMAGE_NAME}.img" print

zstd -T0 -12 --rm -o "out/${IMAGE_NAME}.img.zst" "out/${IMAGE_NAME}.img"
( cd out && sha256sum "${IMAGE_NAME}.img.zst" > "${IMAGE_NAME}.img.zst.sha256" )

ls -lh out/

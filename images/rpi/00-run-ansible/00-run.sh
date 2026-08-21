#!/bin/bash -e

# SMTOOLS_REPO_DIR is exported by the GitHub Actions workflow and points
# at the checkout of stepmania-cabinet-tools on the runner.
: "${SMTOOLS_REPO_DIR:?SMTOOLS_REPO_DIR must be set}"

install -d "${ROOTFS_DIR}/opt/stepmania-cabinet-tools"
rsync -a --exclude='.git' "${SMTOOLS_REPO_DIR}/" "${ROOTFS_DIR}/opt/stepmania-cabinet-tools/"

# We run ansible-playbook *inside* the chroot (via on_chroot) rather than
# using Ansible's own chroot connection plugin from the host. The chroot
# connection plugin doesn't bind-mount /dev, /proc, /sys, which breaks a
# lot of package installs; on_chroot already takes care of that for us.
on_chroot << 'EOF'
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends ansible python3-pip

# apt's python3-passlib landed somewhere ansible-playbook's own Python
# interpreter doesn't see (a known mismatch on some Debian package
# layouts) -- pip it straight into system site-packages instead so it's
# guaranteed to be visible to whatever interpreter is actually running.
python3 -m pip install --break-system-packages --no-cache-dir passlib

cd /opt/stepmania-cabinet-tools

cat > inventory.local <<'INV'
localhost ansible_connection=local ansible_python_interpreter=/usr/bin/python3
INV

# Already running as root inside the chroot, so no become/sudo password
# is needed here (unlike the normal `ansible-playbook -k` SSH workflow).
#
ansible-playbook -i inventory.local install_stepmania.yaml \
  -e stepmania_password=1234 -e raspberrypi_build=true \
  --skip-tags=reboot -e rpi_dpi_mode=720x480i@60hz

rm -f inventory.local

# ansible pulled in ansible-core, the bundled collections, and their
# Python deps (jinja2, pyyaml, cryptography, paramiko, etc.) just to run
# once at build time. None of it is needed by the running kiosk, so strip
# it back out before the image gets exported.
python3 -m pip uninstall -y --break-system-packages passlib
apt-get purge -y ansible python3-pip
apt-get autoremove --purge -y
apt-get clean
rm -rf /var/lib/apt/lists/*
EOF

# Drop the copy of the tooling repo -- it's done its job, no need to ship
# it inside the final image.
rm -rf "${ROOTFS_DIR}/opt/stepmania-cabinet-tools"


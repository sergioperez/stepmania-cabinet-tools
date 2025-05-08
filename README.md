# Prerequisites

- Debian 12 base system (minimal, no desktop environment)

- python3.11 openssh-server (installed in the target system)

- Being able to SSH as root/sudoers user to the destination host

## To run the playbook

You can run ansible directly in your host. But, alternatively, you can install Podman or Docker and run it containerized:

```
podman run -it  docker.io/library/rockylinux:9 bash
dnf install -y ansible-core
cd /tmp
git clone https://github.com/sergioperez/stepmania-cabinet-tools.git
#ansible-playbook command -> Look afterwards in the guide
```

* Note: If you prefer to use Docker, just write "docker" instaed of "podman"

# Outcome

This will setup your Debian host to automatically run StepMania on boot. As soon as StepMania is closed, it will re-run it.

The "stepmania" user will be available to connect over SCP to push files

Credits to Enrico Zini for writing nodm and a LightDM configuration guide: https://www.enricozini.org/blog/2019/himblick/x-autologin/

# Installation steps

1. Install a Debian minimal OS into your host

2. Set the IP address or hostname of your host into the `inventory` file

3. Set the password for the `stepmania` user inside the `stepmania_password` variable of the `inventory` file

4. Run the Ansible playbook: `ansible-playbook install_stepmania.yaml`

## ARM boards

1. Install a minimal Debian 12 based distribution for your board, as could be Raspberry Pi OS Lite, Armbian Server, Debian 12 itself, or other.

2. Follow the same steps specified in `Installation steps`, but this time, run the playbook as:

`ansible-playbook install_stepmania.yaml -e arch=arm64 --skip-tags grub`

### Raspberry Pi

Using a Raspberry Pi for ITGMania can be a quite interesting idea, as:

- It allows us to standardize the hardware we use (available almost anywhere)

- The boards are available in the market for long (although there are better options when it comes to LTS hardware, as Radxa or NanoPi)

- It easily supports 15khz resolutions, for CRT cabinets.

I will soon review uploading my Alsa configuration, as in theory, two boards with the same hardware, and the same Alsa configuration, should have the same impact on the Global Offset.

For 15khz interlaced modes in Raspberry Pi 5, see: https://www.raspberrypi.com/news/how-we-added-interlaced-video-to-raspberry-pi-5/

For 1khz USB polling rate, set the parameters `usbhid.kbpoll=1`, `usbhid.jspoll=1` and  `usbhid.mousepoll=1` to `/boot/firmware/cmdline.txt`

# Implementation details

- The set of available StepMania/ITGMania versions are defined under `group_vars/all`.

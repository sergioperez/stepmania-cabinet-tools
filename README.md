# Prerequisites

- Debian 12 base system

- python3.11 openssh-server

- Being able to SSH as root to the destination host

# Outcome

This will setup your Debian host to automatically run StepMania on boot. As soon as StepMania is closed, it will re-run it.

The "stepmania" user will be available to connect over SCP to push files

Credits to Enrico Zini for writing nodm and a LightDM configuration guide: https://www.enricozini.org/blog/2019/himblick/x-autologin/

# Installation steps

1. Install a Debian minimal OS into your host

2. Set the IP address or hostname of your host into the `inventory` file

3. Set the password for the `stepmania` user inside the `stepmania_password` variable of the `inventory` file

4. Run the Ansible playbook: `ansible-playbook install.yaml`

## Raspberry Pi OS

**Note:** I have not fully tested this yet.

ITGMania does not offer aarch64 builds yet, but it does support it. If you compile it yourself, this playbook will also get your Raspberry Pi OS Lite installation ready for ITGMania.

Note: You will want to disable the grub tasks with `--skip-tags=grub`

For 15khz interlaced modes, see: https://www.raspberrypi.com/news/how-we-added-interlaced-video-to-raspberry-pi-5/ (**Note:** I have not tested this yet)

For 1khz USB polling rate, set the parameters `usbhid.kbpoll=1`, `usbhid.jspoll=1` and  `usbhid.mousepoll=1` to `/boot/firmware/cmdline.txt`

# Implementation details

- The set of available StepMania/ITGMania versions are defined under `group_vars/all`.

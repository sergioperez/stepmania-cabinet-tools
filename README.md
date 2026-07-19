# About

This project is aimed at those who want to set up a lightweight Linux machine dedicated to running StepMania or ITGMania.
It will set up a fresh Debian install to automatically run StepMania on boot. As soon as StepMania is closed, it will immediately restart it.
Additionally, compared to a regular Debian install:
* The USB polling rate is set to 1000 Hz, giving better performance to JPACs and USB input cards
* Latency is reduced by only handling audio playback with ALSA instead of PulseAudio
* Efficient use of system resources due to lack of desktop environment and unneeded processes, making this ideal for older, weaker hardware

After installation, the `stepmania` user will be available to connect over SCP to push files

## Prerequisites

- Debian 13 base system (minimal, no desktop environment)

- python3.11 openssh-server (installed in the target system)

- An internet connection on the target system

- Being able to SSH as root/sudoers user to the target system

# Installation

1. Clone this repository onto your host

2. Install a Debian minimal OS into your target system:
* When creating the first user, make sure its username is not `stepmania`
* At the last steps of the installation process, check the box to install the SSH server

3. Set the IP address or hostname of your target system into the `inventory` file

4. Set the password for the `stepmania` user inside the `stepmania_password` variable of the `inventory` file

5. Run the Ansible playbook: `ansible-playbook install_stepmania.yaml`

6. When the playbook has finished, the target system will reboot and Stepmania will automatically start!

### Using containers

You can run step #5 directly in your host. Alternatively, you can install Podman or Docker and run it containerized:

```
podman run -it  docker.io/alpine/ansible:2.20.0 bash

# Check that you can access your device
ssh youruser@yourdevice exit

cd
wget https://github.com/sergioperez/stepmania-cabinet-tools/new/release.zip
unzip release.zip
cd stepmania-cabinet-tools-release

ansible-playbook install_stepmania.yaml
```

* Note: If you prefer to use Docker, just write "docker" instead of "podman"


## ARM boards

1. Install a minimal Debian 12 based distribution for your board, as could be Raspberry Pi OS Lite, Armbian Server, Debian 12 itself, or other.

2. Follow the same steps specified in `Installation steps`, but this time, run the playbook as:

`ansible-playbook install_stepmania.yaml -e arch=arm64 --skip-tags grub`

### Raspberry Pi

Using a Raspberry Pi for ITGMania can be a quite interesting idea, as:

- It allows us to standardize the hardware we use (available almost anywhere)

- The boards are available in the market for long (although there are better options when it comes to LTS hardware, as Radxa or NanoPi)

- It easily supports 15khz resolutions, for CRT cabinets.

For 15khz interlaced modes in Raspberry Pi 5, see: https://www.raspberrypi.com/news/how-we-added-interlaced-video-to-raspberry-pi-5/

For 1khz USB polling rate, set the parameters `usbhid.kbpoll=1`, `usbhid.jspoll=1` and  `usbhid.mousepoll=1` to `/boot/firmware/cmdline.txt`

### Packman

[StepMania Packman](https://github.com/sergioperez/stepmania-packman) is a tool to configure the desired list of packs in your system
declaratively.

To use it, set the following variables for your host in your inventory:

`disable_packman=false` Prevents packman from running

`sm_pack_search_url="https://stepmaniaoffline.lan"`

`arch=x86_64`

`pack_folder=/home/stepmania/.itgmania/Songs` (Default as-is)

`(Optional) pack_yaml_url: "https://my-web-server.lan/packs.yaml" Allows you to manage the packs.yaml file remotely


## Implementation details

The set of available StepMania/ITGMania versions are defined under `group_vars/all`.

## Credits

Thanks to Enrico Zini for writing nodm and a LightDM configuration guide: https://www.enricozini.org/blog/2019/himblick/x-autologin/

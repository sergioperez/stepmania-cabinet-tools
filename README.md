# About

This project is aimed at those who want to set up a lightweight Linux machine dedicated to running StepMania or ITGMania.

Features:
* Game auto-restart: The game will be restarted if it crashes
* USB poling rate set to 1000Hz - Increased precission for input devices
* Low audio latency - Uses ALSA directly
* Less backgroun processes - The system will run only what is needed to run the game
* Control panel: Protected by username+password, press Control+Alt+F2 to switch to the control panel, or access https://hostname:9090
* Desktop: Protected by username+password, press Control+Alt+F3 to switch to a desktop
* It can be used with any devices able to run Debian 13

## Modes

The system will have three modes available:

* Game: Runs the game
    * Access methods:
        * Default - Will be loaded as soon as the system boots
        * Control+Alt+F1: Switch from a different mode to "game"

* Settings: Allows managing multiple plugins
    * Access method:
        * Press Control+Alt+F2 - Log-in as your stepmania user
    * Functionalities:
        * Swap and download games
        * Configure Packman (Pack management)
        * Set the ITGMania/StepMania sound device
        * Configure ethernet
        * Configure wifi
        * System update 
        * Plugins update
        * Linux terminal

* Desktop: Lightweight desktop
    * Access method:
        * Press Control+Alt+F3 - Log-in as your stepmania user
    * Functionalities:
        * Firefox
        * Linux terminal

## Prerequisites

* Tested target systems
    * **Debian 13**
    * **Raspberry Pi OS Lite (Debian 13)**

* You need to be able to ssh into your **target** system from your **installer** system as the **stepmania** user

* The `stepmania` user needs to be able to run `sudo` with a password.

* Ansible on the **installer** system

# Installation

1. Clone this repository in your host

2. Install a Debian minimal OS into your target system.

3. Create an user named `stepmania` with administrator permissions (requiring password)
* At the last steps of the installation process, check the box to install the SSH server

4. Set the IP address or hostname of your target system into the `inventory` file

4. Set the password for the `stepmania` user inside the `stepmania_password` variable of the `inventory` file

5. Run the Ansible playbook: `ansible-playbook -k -e install_stepmania.yaml`

6. When the playbook has finished, the target system will reboot and Stepmania will automatically start!

### Using containers

You can run step #5 directly in your host. Alternatively, you can install Podman or Docker and run it containerized:

```
podman run -it  docker.io/alpine/ansible:2.20.0 bash

# Check that you can access your device
ssh stepmania@yourdevice exit

cd
wget https://github.com/sergioperez/stepmania-cabinet-tools/new/release.zip
unzip release.zip
cd stepmania-cabinet-tools-release

# Adjust the inventory file
# Run the ansible command specified in Installation
ansible-playbook -k -e install_stepmania.yaml
```

* Note: If you prefer to use Docker, just write "docker" instead of "podman"

## ARM boards

1. Install a minimal Debian 13 based distribution for your board, as could be Raspberry Pi OS Lite, Armbian Server, Debian 12 itself, or other.

**On Raspberry Pi:** Make sure you install Raspberry Pi OS Lite

2. Follow the same steps specified in `Installation steps`.

### Raspberry Pi

Using a Raspberry Pi for ITGMania can be a quite interesting idea, as:

- It allows us to standardize the hardware we use (available almost anywhere)

- The boards are available in the market for long (although there are better options when it comes to LTS hardware, as Radxa or NanoPi)

- It easily supports 15khz resolutions, for CRT cabinets.

For 15khz interlaced modes in Raspberry Pi 5, see: https://www.raspberrypi.com/news/how-we-added-interlaced-video-to-raspberry-pi-5/

### Packman

**Note:** Packman is installed by default with the `install_stepmania.yaml` playbook. Configure it over the **Settings mode**.

[StepMania Packman](https://github.com/sergioperez/stepmania-packman) is a tool to configure the desired list of packs in your system
declaratively.

You can pre-configure Packman with the following variables in your inventory:

`disable_packman=false` Prevents packman from running

`sm_pack_search_url="https://stepmaniaoffline.lan"`

`(Optional) pack_yaml_url: "https://my-web-server.lan/packs.yaml" Allows you to manage the packs.yaml file remotely


## Implementation details

The set of available StepMania/ITGMania versions are defined under `group_vars/all`.

const button = document.getElementById("set_audio_device");

async function loadAlsaDevices() {
    // From for the currently selected alsa device
    const select = document.getElementById("alsa-device");
    const deviceListButtons = document.getElementById("alsa-device-list");

    try {
        const output = await cockpit.spawn([
            "/usr/bin/python3",
            "/usr/share/cockpit/select-audio/get_audio_devices.py"
        ]);
        const _current_audio_device = await cockpit.spawn([
            "/usr/share/cockpit/select-audio/get_current_audio_device.sh"
        ]);
        const current_audio_device= _current_audio_device.trim();

        console.log("Detected current device: " + current_audio_device);
        const devices = JSON.parse(output);
        // If the currently selected device is not listed
        //      add it to the list
        if( ! devices.some(dev => dev.name === current_audio_device)) {
            devices.push({
                name: current_audio_device,
                readable_name: current_audio_device,
            })
        }
        const lines = output.split("\n");

        for (const dev of devices) {
            const button = document.createElement("button");
            button.textContent = dev.readable_name;
            button.dataset.device = dev.name;
            if (dev.name === current_audio_device) {
                button.classList.add("active");
            }
            button.addEventListener("click", async () => {
                await cockpit.spawn([
                    "/usr/share/cockpit/select-audio/set_audio_device.sh",
                    dev.name
                ])
                console.log("Setting device "+ dev.name);
                window.location.reload();
            });
            deviceListButtons.appendChild(button);
        }
    } catch (err) {
        console.error(err);
        deviceListButtons.innerHTML =
            'Failed to load devices';
    }

}

loadAlsaDevices();

// Send a 'init' message.  This tells integration tests that we are ready to go
cockpit.transport.wait(function() { });

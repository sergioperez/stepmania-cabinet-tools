#!/usr/bin/bash
#
# Set the audio device for ITGMania
#
SM_PREFS_FILE="/home/stepmania/.itgmania/Save/Preferences.ini"

# Wait until itgmania stops
sudo -u stepmania /usr/bin/killall itgmania
while pgrep itgmania >/dev/null; do  sleep 0.1; done

sudo -u stepmania sed -i s/^SoundDevice=.*/SoundDevice=${1}/ ${SM_PREFS_FILE}

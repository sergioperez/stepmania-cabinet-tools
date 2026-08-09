#!/usr/bin/bash
#
# Set the audio device for ITGMania
#
SM_PREFS_FILE="/home/stepmania/.itgmania/Save/Preferences.ini"

sudo /usr/bin/systemctl stop game

sed -i s/^SoundDevice=.*/SoundDevice=${1}/ ${SM_PREFS_FILE}

# If tty is 1 -> start game back
# 	Otherwise, the game will start when switching back to it
if [[ "$(fgconsole 2>/dev/null)" == "1" ]]; then
    sudo /usr/bin/systemctl start game
fi

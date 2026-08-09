#!/usr/bin/bash
#
# Gets the current audio device configured in ITGMania/StepMania
#
SM_PREFS_FILE="/home/stepmania/.itgmania/Save/Preferences.ini"
cat ${SM_PREFS_FILE} | grep SoundDevice | cut -d'=' -f2-

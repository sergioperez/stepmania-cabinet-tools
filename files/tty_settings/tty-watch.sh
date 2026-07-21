#!/bin/bash
ACTIVE=$(cat /sys/class/tty/tty0/active)

if [ "$ACTIVE" = "tty1" ]; then
    systemctl stop settings.service
    systemctl start game.service
elif [ "$ACTIVE" = "tty2" ]; then
    systemctl stop game.service
    systemctl start settings.service
fi

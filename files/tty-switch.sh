#!/bin/bash
ACTIVE=$(cat /sys/class/tty/tty0/active)

case "${ACTIVE}" in
    "tty1")
      systemctl stop desktop
      systemctl stop settings
      systemctl start game
      ;;
    "tty2")
      systemctl stop desktop
      systemctl stop game
      systemctl reset-failed game 2>/dev/null
      systemctl start settings
      ;;
    "tty3")
      systemctl stop game
      systemctl stop settings
      systemctl reset-failed game 2>/dev/null
      systemctl start desktop
      ;;
esac

#!/bin/bash
ACTIVE=$(cat /sys/class/tty/tty0/active)

case "${ACTIVE}" in
    "tty1")
      echo "bonjour${ACTIVE}||" >> /home/stepmania/hola
      systemctl stop desktop
      systemctl stop settings
      systemctl start game
      ;;
    "tty2")
      echo "hello${ACTIVE}||" >> /home/stepmania/hola
      /usr/local/bin/tty2-settings.sh
      systemctl stop desktop
      systemctl stop game
      systemctl start settings
      ;;
    "tty3")
      echo "hallo${ACTIVE}||" >> /home/stepmania/hola
      #/usr/local/bin/tty3-desktop.sh
      systemctl stop game
      systemctl stop settings
      systemctl start desktop
      #systemctl start greetd
      ;;
esac

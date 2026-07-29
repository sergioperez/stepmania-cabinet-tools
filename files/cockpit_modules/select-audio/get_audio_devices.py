#!/usr/bin/env python3
'''
Exection: python3 get_audio_devices.py

Prints to stdout a JSON with a list of
audio devices, with a readable name for the user
and the ALSA name for ITGMania/DeadSync

Example output:
[
  {
    "readable_name": "Intel 82801AA-ICH",
    "name": "hw:CARD=I82801AAICH,DEV=0"
  }
]
'''

import json
import re

def read_cards():
    cards = {}

    with open("/proc/asound/cards", "r") as f:
        for line in f:
            # Example:
            # 0 [PCH        ]: HDA-Intel - HDA Intel PCH
            m = re.match(r"^\s*(\d+)\s+\[([^\]]+)\]:\s+.*-\s+(.*)$", line)
            if not m:
                continue

            idx = int(m.group(1))
            card_id = m.group(2).strip()
            card_name = m.group(3).strip()

            cards[idx] = {
                "id": card_id,
                "name": card_name
            }

    return cards


def list_hw_playback_devices():
    cards = read_cards()
    devices = []

    with open("/proc/asound/pcm", "r") as f:
        for line in f:
            # Example:
            # 01-00: USB Audio : USB Audio : playback 1 : capture 1

            m = re.match(r"^(\d+)-(\d+):.*playback", line)
            if not m:
                continue

            card_idx = int(m.group(1))
            dev_idx = int(m.group(2))

            if card_idx not in cards:
                continue

            card = cards[card_idx]

            devices.append({
                "readable_name": card["name"],
                "name": f"hw:CARD={card['id']},DEV={dev_idx}"
            })

    return devices


if __name__ == "__main__":
    print(json.dumps(list_hw_playback_devices(), indent=2))

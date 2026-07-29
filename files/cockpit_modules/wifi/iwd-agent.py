#!/usr/bin/env python3
"""
iwd-agent.py - minimal net.connman.iwd.Agent for the Cockpit iwd module.

iwd only asks for a passphrase through a registered Agent object; it does
not accept one as an argument to Network.Connect(). This helper registers
itself as that agent, prints a marker line to stdout when iwd asks it for
something, reads the answer from stdin (fed by the Cockpit frontend), and
exits once one request has been handled (or after a safety timeout).

Protocol on stdout (one line each):
  AGENT_READY                       - agent registered, safe to call Connect()
  PASSPHRASE_NEEDED <object-path>   - expects one line of stdin: the passphrase
  PRIVATE_KEY_PASSPHRASE_NEEDED <path>
  USERNAME_PASSWORD_NEEDED <path>   - expects one line: "<username>\t<password>"
  CANCELED <reason>                 - iwd canceled the request
  ERROR <message>                   - something went wrong

This only handles PSK/open networks well. 802.1x flows that need a
certificate or a username+password are reported but left for a future
version of the frontend to actually collect that input.
"""
import sys
import threading

import dbus
import dbus.mainloop.glib
import dbus.service
from gi.repository import GLib

BUS_NAME = "net.connman.iwd"
AGENT_MANAGER_PATH = "/net/connman/iwd"
AGENT_PATH = "/net/connman/iwd/cockpit_agent"
IDLE_TIMEOUT_SECONDS = 120


def emit(line):
    sys.stdout.write(line + "\n")
    sys.stdout.flush()


def read_line():
    line = sys.stdin.readline()
    if not line:
        raise EOFError("stdin closed before an answer was provided")
    return line.rstrip("\n")


class Agent(dbus.service.Object):
    def __init__(self, bus, loop):
        super().__init__(bus, AGENT_PATH)
        self.loop = loop

    def _done(self):
        GLib.idle_add(self.loop.quit)

    @dbus.service.method("net.connman.iwd.Agent", in_signature="", out_signature="")
    def Release(self):
        self._done()

    @dbus.service.method("net.connman.iwd.Agent", in_signature="o", out_signature="s")
    def RequestPassphrase(self, path):
        emit("PASSPHRASE_NEEDED %s" % path)
        try:
            passphrase = read_line()
        except EOFError:
            self._done()
            raise dbus.exceptions.DBusException(
                "net.connman.iwd.Agent.Error.Canceled", "no passphrase supplied")
        self._done()
        return passphrase

    @dbus.service.method("net.connman.iwd.Agent", in_signature="os", out_signature="s")
    def RequestPrivateKeyPassphrase(self, path, name):
        emit("PRIVATE_KEY_PASSPHRASE_NEEDED %s" % path)
        try:
            passphrase = read_line()
        except EOFError:
            self._done()
            raise dbus.exceptions.DBusException(
                "net.connman.iwd.Agent.Error.Canceled", "no passphrase supplied")
        self._done()
        return passphrase

    @dbus.service.method("net.connman.iwd.Agent", in_signature="o", out_signature="ss")
    def RequestUserNameAndPassword(self, path):
        emit("USERNAME_PASSWORD_NEEDED %s" % path)
        try:
            line = read_line()
        except EOFError:
            self._done()
            raise dbus.exceptions.DBusException(
                "net.connman.iwd.Agent.Error.Canceled", "no credentials supplied")
        username, _, password = line.partition("\t")
        self._done()
        return (username, password)

    @dbus.service.method("net.connman.iwd.Agent", in_signature="os", out_signature="s")
    def RequestUserPassword(self, path, username):
        emit("USER_PASSWORD_NEEDED %s %s" % (path, username))
        try:
            password = read_line()
        except EOFError:
            self._done()
            raise dbus.exceptions.DBusException(
                "net.connman.iwd.Agent.Error.Canceled", "no password supplied")
        self._done()
        return password

    @dbus.service.method("net.connman.iwd.Agent", in_signature="s", out_signature="")
    def Cancel(self, reason):
        emit("CANCELED %s" % reason)
        self._done()


def main():
    dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
    bus = dbus.SystemBus()
    loop = GLib.MainLoop()
    Agent(bus, loop)

    manager = dbus.Interface(
        bus.get_object(BUS_NAME, AGENT_MANAGER_PATH), "net.connman.iwd.AgentManager")

    try:
        manager.RegisterAgent(AGENT_PATH)
    except dbus.exceptions.DBusException as exc:
        emit("ERROR could not register agent: %s" % exc)
        sys.exit(1)

    emit("AGENT_READY")

    def watchdog():
        import time
        time.sleep(IDLE_TIMEOUT_SECONDS)
        GLib.idle_add(loop.quit)

    threading.Thread(target=watchdog, daemon=True).start()

    try:
        loop.run()
    finally:
        try:
            manager.UnregisterAgent(AGENT_PATH)
        except Exception:
            pass


if __name__ == "__main__":
    main()

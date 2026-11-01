"""Acquire locks on inherited descriptors; retain ownership in the Node parent.

The compatibility interval is SQLite's PENDING_BYTE through the end of its
shared-lock interval (0x40000000, 512 bytes). Linux OFD locks conflict with POSIX
locks used by old SQLite releases. No database content is read or written.
"""
import ctypes
import errno
import fcntl
import os
import sys


class Flock(ctypes.Structure):
    _fields_ = [("l_type", ctypes.c_short), ("l_whence", ctypes.c_short),
                ("l_start", ctypes.c_long), ("l_len", ctypes.c_long),
                ("l_pid", ctypes.c_int)]


def acquire(descriptor, start, length):
    lock = Flock(fcntl.F_WRLCK, os.SEEK_SET, start, length, 0)
    fcntl.fcntl(descriptor, fcntl.F_OFD_SETLK, bytes(lock))


try:
    if (sys.platform != "linux" or ctypes.sizeof(Flock) != 32
            or os.uname().machine != "x86_64"
            or not hasattr(fcntl, "F_OFD_SETLK")):
        sys.exit(70)
    acquire(3, 0, 0)
    acquire(4, 0x40000000, 512)
    sys.stdout.write("GP_DATABASE_LOCK_V1\n")
except OSError as error:
    sys.exit(73 if error.errno in (errno.EAGAIN, errno.EACCES) else 70)

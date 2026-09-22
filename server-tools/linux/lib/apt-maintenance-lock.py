#!/usr/bin/env python3
"""Install an explicit, reversible APT/GP maintenance lock integration.

No timer, package upgrade, service restart or assurance run is started here.
Only Ubuntu's verified apt.systemd.daily service commands are accepted.
"""
import argparse
import os
from pathlib import Path
import subprocess

LOCK = '/run/grabenplaner/maintenance.lock'
UNITS = {'apt-daily.service': 'update', 'apt-daily-upgrade.service': 'install'}
# APT must not restart a short-lived GP job waiting for the lock it owns.
# Database and application services deliberately remain subject to needrestart.
NEEDRESTART = Path('/etc/needrestart/conf.d/40-grabenplaner-maintenance-jobs.conf')
NEEDRESTART_TEXT = r'''# GP jobs finish and start with current libraries on their next invocation.
$nrconf{override_rc}->{qr(^grabenplaner-(?:offsite-[A-Za-z0-9\@_.:-]+|host-control\@[^/]+|monitor|host-security-audit|host-cron-nightly)\.service$)} = 0;
'''



def dropin(action):
    if action not in UNITS.values():
        raise ValueError('Unsupported APT action')
    return ('[Service]\nExecStart=\n'
            f'ExecStart=/usr/bin/flock --exclusive --wait 21600 {LOCK} /usr/lib/apt/apt.systemd.daily {action}\n'
            'TimeoutStartSec=8h\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true', help='Install after the read-only preflight succeeds')
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise SystemExit('Run as root for the protected preflight.')
    lock = Path(LOCK)
    if lock.is_symlink() or not lock.is_file() or lock.stat().st_uid != 0 or lock.stat().st_nlink != 1:
        raise SystemExit('The existing GP maintenance lock is unsafe or missing.')
    import fcntl
    with lock.open('r+') as held:
        try:
            fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise SystemExit('A GP maintenance operation is active; nothing changed.')
        destinations = []
        for unit, action in UNITS.items():
            active = subprocess.run(['systemctl', 'is-active', unit], capture_output=True, text=True).stdout.strip()
            if active not in ('inactive', 'failed'):
                raise SystemExit(f'{unit} is active or unavailable; nothing changed.')
            command = subprocess.check_output(['systemctl', 'show', '-p', 'ExecStart', '--value', unit], text=True)
            expected = f'argv[]=/usr/lib/apt/apt.systemd.daily {action} ;'
            destination = Path('/etc/systemd/system') / (unit + '.d') / '40-grabenplaner-maintenance-lock.conf'
            if destination.exists() or destination.is_symlink():
                if destination.is_symlink() or destination.read_text() != dropin(action):
                    raise SystemExit(f'Unexpected existing configuration for {unit}; nothing changed.')
                expected = f'argv[]=/usr/bin/flock --exclusive --wait 21600 {LOCK} /usr/lib/apt/apt.systemd.daily {action} ;'
            if expected not in command or command.count('argv[]=') != 1:
                raise SystemExit(f'Unexpected ExecStart for {unit}; nothing changed.')
            destinations.append((destination, dropin(action)))
        if not NEEDRESTART.parent.is_dir():
            raise SystemExit('The expected needrestart configuration directory is missing.')
        if NEEDRESTART.exists() or NEEDRESTART.is_symlink():
            if NEEDRESTART.is_symlink() or NEEDRESTART.read_text() != NEEDRESTART_TEXT:
                raise SystemExit('Unexpected existing needrestart configuration; nothing changed.')
        destinations.append((NEEDRESTART, NEEDRESTART_TEXT))
        if not args.apply:
            print('Preflight passed. Both APT services can share the GP maintenance lock; no changes made.')
            return
        written = []
        try:
            for destination, contents in destinations:
                destination.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
                if destination.exists():
                    continue
                with destination.open('x') as output:
                    output.write(contents)
                destination.chmod(0o644)
                written.append(destination)
            subprocess.run(['systemctl', 'daemon-reload'], check=True)
        except BaseException:
            for destination in written:
                destination.unlink()
            subprocess.run(['systemctl', 'daemon-reload'], check=False)
            raise
        print('APT maintenance lock installed. Existing timers and running services unchanged.')


if __name__ == '__main__':
    main()

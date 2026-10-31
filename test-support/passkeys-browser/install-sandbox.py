"""Install only the exact official test browser's sandbox helper. No policy bypass."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import stat
import sys

PIN = 'be9f5d4be90fa60b985ad3069812b144ba7331fed0c3f980c6d9399d37d60314'
DESTINATION = '/var/lib/gp-passkeys-ci-sandbox'


def protected_directory(directory, create=False):
    if create and not directory.exists():
        directory.mkdir(mode=0o755)
    info = directory.lstat()
    proof = {'path': str(directory), 'uid': info.st_uid, 'gid': info.st_gid,
             'mode': info.st_mode & 0o7777, 'isDirectory': stat.S_ISDIR(info.st_mode),
             'canonical': str(directory.resolve())}
    if (not proof['isDirectory'] or info.st_uid != 0 or info.st_mode & 0o022
            or directory.resolve() != directory):
        raise ValueError('Unsafe sandbox directory: ' + json.dumps(proof, sort_keys=True))
    return proof


def install(source):
    source = Path(source)
    if sys.platform != 'linux' or os.geteuid() != 0 or not source.is_absolute() or source.resolve() != source:
        raise ValueError('Explicit root installation of a canonical native Linux test helper required')
    caller = int(os.environ.get('SUDO_UID', '-1'))
    fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != caller or caller <= 0 or info.st_size != 15216:
            raise ValueError('Unsafe browser sandbox source ownership or shape')
        content = os.read(fd, 15217)
    finally:
        os.close(fd)
    if hashlib.sha256(content).hexdigest() != PIN:
        raise ValueError('Unreviewed browser sandbox digest')
    parent = Path(DESTINATION)
    target_directory = parent / PIN
    proofs = [protected_directory(directory) for directory in [Path('/'), Path('/var'), Path('/var/lib')]]
    proofs.extend(protected_directory(directory, create=True) for directory in [parent, target_directory])
    target = target_directory / 'chrome_sandbox'
    if not target.exists():
        fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o700)
        try:
            if os.write(fd, content) != len(content):
                raise ValueError('Incomplete sandbox copy')
            os.fsync(fd)
            os.fchown(fd, 0, 0)
            os.fchmod(fd, 0o4755)
        finally:
            os.close(fd)
    info = target.lstat()
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_gid != 0 or info.st_nlink != 1
            or info.st_mode & 0o7777 != 0o4755 or hashlib.sha256(target.read_bytes()).hexdigest() != PIN):
        raise ValueError('Existing sandbox helper differs')
    return {'format': 'gp-passkeys-ci-sandbox-v1', 'path': str(target), 'sha256': PIN,
            'sandboxDisabled': False, 'directoryProofs': proofs}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', required=True)
    args = parser.parse_args()
    print(json.dumps(install(args.source)))

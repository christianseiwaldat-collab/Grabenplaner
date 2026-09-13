"""Capture an isolated migration input. Never stops or writes the live application."""
import datetime
import hashlib
import json
import os
import pathlib
import pwd
import shutil
import sqlite3
import stat
import time

BASE = pathlib.Path('/home/gpadmin/grabenplaner-pg-migration-20260912')
LIVE = pathlib.Path('/var/lib/grabenplaner')
TARGET = BASE / 'historical-9' / 'source'


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def files(root):
    result = []
    for directory, dirs, names in os.walk(root, followlinks=False):
        for name in dirs + names:
            candidate = pathlib.Path(directory, name)
            info = candidate.lstat()
            if stat.S_ISLNK(info.st_mode) or not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)):
                raise ValueError('Unsupported source storage object')
            if stat.S_ISREG(info.st_mode):
                result.append((str(candidate.relative_to(root)), info.st_size, info.st_mtime_ns, digest(candidate)))
    return sorted(result)


def main():
    if os.geteuid() != 0 or BASE.resolve(strict=True) != BASE:
        raise ValueError('Dedicated migration source capture required')
    if (BASE / 'ownership-marker').read_text().strip() != 'grabenplaner-postgresql-migration-development-v1':
        raise ValueError('Migration ownership mismatch')
    if TARGET.exists() or TARGET.parent.is_symlink():
        raise ValueError('Source capture target already exists or is unsafe')
    if shutil.disk_usage(BASE).free < 16 * 1024**3:
        raise ValueError('Insufficient migration reserve')
    os.umask(0o077)
    TARGET.mkdir(parents=True, mode=0o700)
    (TARGET.parent / 'ownership-marker').write_text('grabenplaner-historical-transfer-9-v1\n')
    started = time.monotonic()
    source = sqlite3.connect((LIVE / 'data/dienstplan.db').as_uri() + '?mode=ro', uri=True, timeout=5)
    destination = sqlite3.connect(TARGET / 'dienstplan.db')
    last = [0]

    def progress(status, remaining, total):
        elapsed = time.monotonic() - started
        if elapsed > 900:
            raise TimeoutError('Bounded source snapshot timed out')
        if elapsed - last[0] >= 20:
            print(json.dumps({'snapshotPagesRemaining': remaining, 'totalPages': total}), flush=True)
            last[0] = elapsed

    try:
        source.execute('PRAGMA query_only=ON')
        source.backup(destination, pages=4096, progress=progress, sleep=0.02)
    finally:
        destination.close()
        source.close()
    manifest = {'version': 1, 'kind': 'isolated-online-sqlite-copy',
                'capturedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                'database': {'file': 'dienstplan.db', 'bytes': (TARGET / 'dienstplan.db').stat().st_size,
                             'sha256': digest(TARGET / 'dienstplan.db')}, 'files': []}
    for group in ['private', 'branding-kits']:
        before = files(LIVE / group)
        shutil.copytree(LIVE / group, TARGET / group, copy_function=shutil.copyfile)
        after = files(LIVE / group)
        copied = files(TARGET / group)
        if before != after or [(n, b, h) for n, b, _, h in copied] != [(n, b, h) for n, b, _, h in before]:
            raise ValueError('Protected files changed while capturing migration input')
        manifest['files'].extend({'file': group + '/' + n, 'bytes': b, 'sha256': h} for n, b, _, h in copied)
    config = pathlib.Path('/etc/grabenplaner/grabenplaner.env')
    config_hash = digest(config)
    shutil.copyfile(config, TARGET / 'configuration.env')
    if config_hash != digest(TARGET / 'configuration.env') or config_hash != digest(config):
        raise ValueError('Configuration changed during capture')
    manifest['configuration'] = {'file': 'configuration.env', 'sha256': config_hash}
    manifest['seconds'] = round(time.monotonic() - started, 3)
    (TARGET / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    owner = pwd.getpwnam('gpadmin')
    for directory, dirs, names in os.walk(TARGET.parent):
        os.chown(directory, owner.pw_uid, owner.pw_gid)
        os.chmod(directory, 0o700)
        for name in names:
            os.chown(pathlib.Path(directory, name), owner.pw_uid, owner.pw_gid)
            os.chmod(pathlib.Path(directory, name), 0o600)
    print(json.dumps({'sourceCaptured': True, 'databaseBytes': manifest['database']['bytes'],
                      'protectedFiles': len(manifest['files']), 'seconds': manifest['seconds'],
                      'liveWrites': False, 'productActivation': False}))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'sourceCaptured': False, 'errorType': type(error).__name__}))
        raise SystemExit(1)

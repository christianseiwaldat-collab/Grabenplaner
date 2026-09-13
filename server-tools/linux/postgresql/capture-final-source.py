"""Final migration source: requires root, stopped GP and an inherited lease."""
import datetime
import hashlib
import json
import os
import pathlib
import shutil
import sqlite3
import stat
import subprocess
import sys
import uuid

BASE = pathlib.Path('/var/lib/grabenplaner-postgresql/migration')
LIVE = pathlib.Path('/var/lib/grabenplaner')


def digest(file):
    value = hashlib.sha256()
    with file.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(block)
    return value.hexdigest()


def main():
    if os.getuid() != 0 or len(sys.argv) != 2 or str(uuid.UUID(sys.argv[1], version=4)) != sys.argv[1]:
        raise ValueError('Invalid final source request')
    if pathlib.Path('/proc/self/fd/9').resolve() != pathlib.Path('/run/grabenplaner/maintenance.lock'):
        raise ValueError('Missing maintenance lease')
    subprocess.run(['/usr/bin/flock', '--nonblock', '9'], check=True, pass_fds=(9,))
    pid = subprocess.check_output(['/usr/bin/systemctl', 'show', 'grabenplaner.service', '--property=MainPID', '--value'], text=True).strip()
    if pid != '0' or subprocess.run(['/usr/bin/systemctl', 'is-active', '--quiet', 'grabenplaner.service']).returncode == 0:
        raise ValueError('Application must be stopped')
    run = BASE / sys.argv[1]
    if run.resolve() != run or run.stat().st_uid != 0 or run.stat().st_mode & 0o077:
        raise ValueError('Invalid final source ownership')
    if (run / 'ownership-marker').read_text().strip() != 'grabenplaner-postgresql-staging-v1':
        raise ValueError('Invalid final source marker')
    target = run / 'input' / 'source'
    if target.parent.exists() or shutil.disk_usage(run).free < 12 * 1024**3:
        raise ValueError('Final source already exists or insufficient reserve')
    os.umask(0o077)
    target.mkdir(mode=0o700, parents=True)
    (target.parent / 'ownership-marker').write_text('grabenplaner-historical-transfer-9-v1\n')
    source_file = LIVE / 'data/dienstplan.db'
    if source_file.resolve() != source_file or source_file.lstat().st_nlink != 1:
        raise ValueError('Invalid SQLite source')
    source = sqlite3.connect(source_file.as_uri() + '?mode=ro', uri=True)
    destination = sqlite3.connect(target / 'dienstplan.db')
    try:
        source.execute('PRAGMA query_only=ON')
        source.backup(destination, pages=4096)
    finally:
        destination.close()
        source.close()
    manifest = {'version': 1, 'kind': 'isolated-online-sqlite-copy', 'captureMode': 'stopped-final-source',
                'capturedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                'database': {'file': 'dienstplan.db', 'bytes': (target / 'dienstplan.db').stat().st_size,
                             'sha256': digest(target / 'dienstplan.db')}, 'files': []}
    for group in ['private', 'branding-kits']:
        origin = LIVE / group
        if not origin.exists():
            continue
        for directory, folders, names in os.walk(origin, followlinks=False):
            parent = pathlib.Path(directory)
            if parent.resolve() != parent or parent.lstat().st_mode & 0o022:
                raise ValueError('Untrusted protected source directory')
            for name in folders + names:
                info = (parent / name).lstat()
                if stat.S_ISLNK(info.st_mode) or not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)):
                    raise ValueError('Unsupported protected storage')
        shutil.copytree(origin, target / group, copy_function=shutil.copyfile)
        for directory, folders, names in os.walk(target / group):
            os.chmod(directory, 0o700)
            for name in names:
                file = pathlib.Path(directory) / name
                os.chmod(file, 0o600)
                relative = file.relative_to(target)
                copied_hash = digest(file)
                if copied_hash != digest(LIVE / relative):
                    raise ValueError('Protected source changed during final capture')
                manifest['files'].append({'file': str(relative), 'bytes': file.stat().st_size, 'sha256': copied_hash})
    configuration = pathlib.Path('/etc/grabenplaner/grabenplaner.env')
    if configuration.resolve() != configuration or configuration.lstat().st_uid != 0 or configuration.lstat().st_mode & 0o077:
        raise ValueError('Untrusted source configuration')
    shutil.copyfile(configuration, target / 'configuration.env')
    manifest['configuration'] = {'file': 'configuration.env', 'sha256': digest(target / 'configuration.env')}
    if manifest['configuration']['sha256'] != digest(configuration):
        raise ValueError('Configuration changed during final capture')
    for file in [target / 'dienstplan.db', target / 'configuration.env']:
        os.chmod(file, 0o600)
        with file.open('rb') as stream:
            os.fsync(stream.fileno())
    with (target / 'manifest.json').open('x') as stream:
        json.dump(manifest, stream, indent=2)
        stream.flush()
        os.fsync(stream.fileno())
    print(json.dumps({'captured': True, 'sourceSha256': manifest['database']['sha256'], 'protectedFiles': len(manifest['files'])}))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('PG_FINAL_SOURCE_FAILED', file=sys.stderr)
        sys.exit(1)

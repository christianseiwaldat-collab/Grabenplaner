"""Immutable WAL transport for the owned Block-10 restore rehearsal only."""
import hashlib
import os
import pathlib
import re
import sys
import uuid

ROOT = pathlib.Path('/home/gpadmin/grabenplaner-pg-migration-20260912/recovery-10')
MARKER = 'grabenplaner-paired-recovery-10-v1'

def digest(file):
    assert file.is_file() and not file.is_symlink() and file.stat().st_nlink == 1
    with file.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()

def sync_directory(directory):
    descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)

def publish(source, target):
    expected = digest(source)
    if target.exists():
        assert digest(target) == expected
        with target.open('rb') as existing:
            os.fsync(existing.fileno())
        sync_directory(target.parent)
        return expected
    temporary = target.parent / ('.partial-' + str(uuid.uuid4()))
    try:
        with source.open('rb') as reader, temporary.open('xb') as writer:
            os.chmod(temporary, 0o600)
            while chunk := reader.read(1024 * 1024):
                writer.write(chunk)
            writer.flush()
            os.fsync(writer.fileno())
        assert digest(temporary) == expected and digest(source) == expected
        os.chmod(temporary, 0o400)
        try:
            os.link(temporary, target)
        except FileExistsError:
            assert digest(target) == expected
        temporary.unlink()
        sync_directory(target.parent)
        return expected
    finally:
        if temporary.exists():
            temporary.unlink()

def main():
    assert sys.platform == 'linux' and os.getuid() != 0
    assert ROOT.resolve() == ROOT and (ROOT / 'ownership-marker').read_text().strip() == MARKER
    assert ROOT.stat().st_mode & 0o077 == 0
    mode, argument, name = sys.argv[1:]
    assert re.fullmatch(r'[A-F0-9]{24}(?:\.[A-F0-9]{8}\.backup)?|[A-F0-9]{8}\.history', name)
    archive = ROOT / 'wal-archive'
    assert archive.resolve() == archive and archive.stat().st_mode & 0o077 == 0
    if mode == 'archive':
        source = pathlib.Path(argument).absolute()
        assert source.parent == ROOT / 'logical-data-3' / 'pg_wal' and source.resolve() == source
        assert source.name == name
        checksum = publish(source, archive / name)
        checksum_file = archive / (name + '.sha256')
        if checksum_file.exists():
            assert checksum_file.read_text().strip() == checksum
        else:
            with checksum_file.open('x') as output:
                os.chmod(checksum_file, 0o400)
                output.write(checksum + '\n')
                output.flush()
                os.fsync(output.fileno())
            sync_directory(archive)
    elif mode == 'restore':
        destination = pathlib.Path(argument).absolute()
        assert destination.parent == ROOT / 'pitr-data' / 'pg_wal' and destination.parent.resolve() == destination.parent
        assert destination.name == 'RECOVERYXLOG'
        assert digest(archive / name) == (archive / (name + '.sha256')).read_text().strip()
        publish(archive / name, destination)
        # PostgreSQL opens the recovered working segment for writing. Only the
        # archive copy remains immutable; the cluster's private copy is mutable.
        os.chmod(destination, 0o600)
    else:
        raise ValueError('Unsupported WAL operation')

if __name__ == '__main__':
    try:
        main()
    except Exception:
        sys.exit(1)

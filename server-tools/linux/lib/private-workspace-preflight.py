#!/usr/bin/env python3
"""Read-only release binding verification. Never import or execute an addon."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import sys
import time


class CheckFailure(Exception):
    pass


def require(condition, code):
    if not condition:
        raise CheckFailure(code)


def strict_pairs(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, 'PRIVATE_WORKSPACE_FORMAT')
        result[key] = value
    return result


def reject_constant(_value):
    raise CheckFailure('PRIVATE_WORKSPACE_FORMAT')


DECODER = json.JSONDecoder(object_pairs_hook=strict_pairs,
                           parse_constant=reject_constant)
HEX = re.compile(r'^[0-9a-f]{64}$')
COMMIT = re.compile(r'^[0-9a-f]{40}$')
VERSION = re.compile(r'^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9][A-Za-z0-9.-]{0,63})?$')
MAX_FILE = 64 * 1024 * 1024


def relative_file(value):
    require(isinstance(value, str) and 0 < len(value) <= 1024,
            'PRIVATE_WORKSPACE_RELATIVE_PATH')
    require('\\' not in value and '\x00' not in value,
            'PRIVATE_WORKSPACE_RELATIVE_PATH')
    parsed = PurePosixPath(value)
    require(bool(parsed.parts) and not parsed.is_absolute() and str(parsed) == value
            and all(part not in ('', '.', '..') for part in parsed.parts),
            'PRIVATE_WORKSPACE_RELATIVE_PATH')
    return value


def pin(value, name='file', maximum=MAX_FILE):
    require(isinstance(value, dict) and set(value) == {name, 'bytes', 'sha256'},
            'PRIVATE_WORKSPACE_FORMAT')
    relative_file(value[name])
    require(type(value['bytes']) is int and 0 <= value['bytes'] <= maximum,
            'PRIVATE_WORKSPACE_FORMAT')
    require(isinstance(value['sha256'], str) and HEX.fullmatch(value['sha256']),
            'PRIVATE_WORKSPACE_FORMAT')


def pins(values, name='file'):
    require(isinstance(values, list) and 0 < len(values) <= 2048,
            'PRIVATE_WORKSPACE_FORMAT')
    seen = set()
    for value in values:
        pin(value, name)
        require(value[name] not in seen, 'PRIVATE_WORKSPACE_FORMAT')
        seen.add(value[name])


def parse_wrapper(raw):
    require(len(raw) <= 4 * 1024 * 1024, 'PRIVATE_WORKSPACE_FORMAT')
    text = raw.decode('utf-8')
    marker = 'const bindings='
    require(text.count(marker) == 1, 'PRIVATE_WORKSPACE_FORMAT')
    offset = text.index(marker) + len(marker)
    while offset < len(text) and text[offset] in ' \t\r\n':
        offset += 1
    rows, end = DECODER.raw_decode(text, offset)
    # The genuine wrapper uses one const declaration with two JSON values.
    # Accept this named data declarator, never a JavaScript expression or a
    # guessed delimiter. Neither the prefix nor the trailing code is executed.
    following = re.match(r',\s*codeFiles\s*=\s*', text[end:])
    require(following is not None, 'PRIVATE_WORKSPACE_FORMAT')
    declared_files, tail = DECODER.raw_decode(text, end + following.end())
    require(text[tail:].lstrip().startswith(';'), 'PRIVATE_WORKSPACE_FORMAT')
    pins(declared_files)
    require(isinstance(rows, list) and 0 < len(rows) <= 128,
            'PRIVATE_WORKSPACE_FORMAT')
    seen = set()
    for row in rows:
        require(isinstance(row, dict)
                and set(row) == {'gpVersion', 'sourceCommit', 'manifestSha256',
                                 'files', 'codeRoot', 'codeFiles'},
                'PRIVATE_WORKSPACE_FORMAT')
        require(isinstance(row['gpVersion'], str) and VERSION.fullmatch(row['gpVersion'])
                and isinstance(row['sourceCommit'], str) and COMMIT.fullmatch(row['sourceCommit'])
                and isinstance(row['manifestSha256'], str) and HEX.fullmatch(row['manifestSha256'])
                and isinstance(row['codeRoot'], str), 'PRIVATE_WORKSPACE_FORMAT')
        require(row['manifestSha256'] not in seen, 'PRIVATE_WORKSPACE_BINDING_AMBIGUOUS')
        seen.add(row['manifestSha256'])
        pins(row['files'])
        pins(row['codeFiles'])
    return rows, declared_files


def parse_bindings(raw):
    return parse_wrapper(raw)[0]


def identity(value):
    return (value.st_dev, value.st_ino, value.st_mode, value.st_uid,
            value.st_gid, value.st_nlink, value.st_size,
            value.st_mtime_ns, value.st_ctime_ns)


class ProtectedReads:
    def __init__(self):
        self.deadline = time.monotonic() + 30
        self.bytes_read = 0

    def path(self, value, directory=False):
        require(time.monotonic() < self.deadline, 'PRIVATE_WORKSPACE_READ_BUDGET')
        require(isinstance(value, str) and os.path.isabs(value)
                and os.path.normpath(value) == value,
                'PRIVATE_WORKSPACE_CANONICAL_PATH')
        path = Path(value)
        require(str(path.resolve(strict=True)) == value,
                'PRIVATE_WORKSPACE_CANONICAL_PATH')
        for parent in (path, *path.parents):
            details = parent.lstat()
            require(not stat.S_ISLNK(details.st_mode) and details.st_uid == 0
                    and not details.st_mode & 0o022,
                    'PRIVATE_WORKSPACE_PERMISSIONS')
            require(parent == path or stat.S_ISDIR(details.st_mode),
                    'PRIVATE_WORKSPACE_PERMISSIONS')
        details = path.lstat()
        require(stat.S_ISDIR(details.st_mode) if directory
                else stat.S_ISREG(details.st_mode) and details.st_nlink == 1,
                'PRIVATE_WORKSPACE_PERMISSIONS')
        return path, details

    def file(self, value, maximum=MAX_FILE, expected=None, content=False):
        path, before = self.path(value)
        require(before.st_size <= maximum and (expected is None or before.st_size == expected),
                'PRIVATE_WORKSPACE_FILE_PIN')
        flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK
        descriptor = os.open(path, flags)
        chunks, digest = [], hashlib.sha256()
        try:
            opened = os.fstat(descriptor)
            require(identity(opened) == identity(before), 'PRIVATE_WORKSPACE_FILE_CHANGED')
            remaining = opened.st_size
            while remaining:
                require(time.monotonic() < self.deadline, 'PRIVATE_WORKSPACE_READ_BUDGET')
                chunk = os.read(descriptor, min(remaining, 1024 * 1024))
                require(bool(chunk), 'PRIVATE_WORKSPACE_FILE_CHANGED')
                remaining -= len(chunk)
                self.bytes_read += len(chunk)
                require(self.bytes_read <= 256 * 1024 * 1024, 'PRIVATE_WORKSPACE_READ_BUDGET')
                digest.update(chunk)
                if content:
                    chunks.append(chunk)
            require(identity(os.fstat(descriptor)) == identity(opened)
                    and identity(path.lstat()) == identity(opened),
                    'PRIVATE_WORKSPACE_FILE_CHANGED')
        finally:
            os.close(descriptor)
        return digest.hexdigest(), b''.join(chunks) if content else None


def application(reader, root):
    directory, _ = reader.path(root, directory=True)
    digest, raw = reader.file(str(directory / 'grabenplaner-server-manifest.json'),
                              maximum=16 * 1024 * 1024, content=True)
    manifest = DECODER.decode(raw.decode('utf-8-sig'))
    require(isinstance(manifest, dict) and manifest.get('format') == 'grabenplaner-server-package'
            and type(manifest.get('schemaVersion')) is int and manifest['schemaVersion'] == 1
            and isinstance(manifest.get('appVersion'), str) and VERSION.fullmatch(manifest['appVersion'])
            and isinstance(manifest.get('sourceCommit'), str) and COMMIT.fullmatch(manifest['sourceCommit']),
            'PRIVATE_WORKSPACE_GP_MANIFEST')
    files = manifest.get('files')
    require(isinstance(files, list) and 0 < len(files) <= 10000,
            'PRIVATE_WORKSPACE_GP_MANIFEST')
    indexed = {}
    for item in files:
        require(isinstance(item, dict) and {'path', 'bytes', 'sha256'} <= set(item),
                'PRIVATE_WORKSPACE_GP_MANIFEST')
        value = {name: item[name] for name in ('path', 'bytes', 'sha256')}
        # Unrelated public assets are metadata only here. The bounded file-read
        # limit applies to the selected addon pins, not every public asset.
        pin(value, 'path', maximum=9007199254740991)
        require(value['path'] not in indexed, 'PRIVATE_WORKSPACE_GP_MANIFEST')
        indexed[value['path']] = value
    return {'root': directory, 'digest': digest, 'manifest': manifest, 'files': indexed}


def selected(reader, rows, app, label):
    matches = [row for row in rows if row['manifestSha256'] == app['digest']]
    require(len(matches) == 1, 'PRIVATE_WORKSPACE_BINDING_MISSING_' + label)
    row = matches[0]
    require(row['gpVersion'] == app['manifest']['appVersion']
            and row['sourceCommit'] == app['manifest']['sourceCommit'],
            'PRIVATE_WORKSPACE_GP_IDENTITY')
    for item in row['files']:
        expected = app['files'].get(item['file'])
        require(expected == {'path': item['file'], 'bytes': item['bytes'], 'sha256': item['sha256']},
                'PRIVATE_WORKSPACE_GP_FILE_PIN')
        digest, _ = reader.file(str(app['root'] / item['file']), expected=item['bytes'])
        require(digest == item['sha256'], 'PRIVATE_WORKSPACE_GP_FILE_PIN')
    return row


def verify(module, installed_app, candidate_app):
    module = module.strip()
    if not module:
        return {'format': 'gp-private-workspace-preflight-v1', 'configured': False,
                'verified': True, 'dataOnly': True}
    require(sys.platform == 'linux' and hasattr(os, 'geteuid') and os.geteuid() == 0,
            'PRIVATE_WORKSPACE_ROOT_REQUIRED')
    reader = ProtectedReads()
    reader.path(os.path.abspath(__file__))
    module_path, _ = reader.path(module)
    module_digest, raw = reader.file(module, maximum=4 * 1024 * 1024, content=True)
    rows, declared_files = parse_wrapper(raw)
    installed = application(reader, installed_app)
    candidate = application(reader, candidate_app)
    require(not module_path.is_relative_to(installed['root'])
            and not module_path.is_relative_to(candidate['root']),
            'PRIVATE_WORKSPACE_EXTERNAL_PATH')
    old = selected(reader, rows, installed, 'CURRENT')
    new = selected(reader, rows, candidate, 'CANDIDATE')
    require(old['codeRoot'] == new['codeRoot'] and old['codeFiles'] == new['codeFiles']
            and old['codeFiles'] == declared_files
            and [item['file'] for item in old['files']] == [item['file'] for item in new['files']],
            'PRIVATE_WORKSPACE_PRIVATE_CODE_CHANGED')
    code_root, _ = reader.path(old['codeRoot'], directory=True)
    require(not code_root.is_relative_to(installed['root'])
            and not code_root.is_relative_to(candidate['root']),
            'PRIVATE_WORKSPACE_EXTERNAL_PATH')
    for item in old['codeFiles']:
        digest, _ = reader.file(str(code_root / item['file']), expected=item['bytes'])
        require(digest == item['sha256'], 'PRIVATE_WORKSPACE_PRIVATE_FILE_PIN')
    # Bind the result to the same metadata after all bounded reads.
    require(reader.file(module, maximum=4 * 1024 * 1024)[0] == module_digest,
            'PRIVATE_WORKSPACE_FILE_CHANGED')
    for app in (installed, candidate):
        require(reader.file(str(app['root'] / 'grabenplaner-server-manifest.json'),
                            maximum=16 * 1024 * 1024)[0] == app['digest'],
                'PRIVATE_WORKSPACE_FILE_CHANGED')
    return {'format': 'gp-private-workspace-preflight-v1', 'configured': True,
            'verified': True, 'dataOnly': True, 'moduleSha256': module_digest,
            'installedManifestSha256': installed['digest'],
            'candidateManifestSha256': candidate['digest'],
            'gpFileBindings': len(old['files']), 'privateFiles': len(old['codeFiles']),
            'privateCodeUnchanged': True}


class Parser(argparse.ArgumentParser):
    def error(self, _message):
        raise CheckFailure('PRIVATE_WORKSPACE_PREFLIGHT_ARGS')


def main():
    try:
        parser = Parser(description=__doc__)
        parser.add_argument('--module', default='')
        parser.add_argument('--installed-app', required=True)
        parser.add_argument('--candidate-app', required=True)
        args = parser.parse_args()
        result = verify(args.module, args.installed_app, args.candidate_app)
        sys.stdout.write(json.dumps(result, sort_keys=True) + '\n')
        return 0
    except CheckFailure as error:
        sys.stderr.write(str(error) + '\n')
    except (OSError, UnicodeError):
        sys.stderr.write('PRIVATE_WORKSPACE_PREFLIGHT_IO\n')
    except (ValueError, TypeError, KeyError, RecursionError):
        sys.stderr.write('PRIVATE_WORKSPACE_FORMAT\n')
    return 1


if __name__ == '__main__':
    sys.exit(main())

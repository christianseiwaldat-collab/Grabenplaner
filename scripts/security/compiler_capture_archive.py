"""Stream private upstream diagnostic evidence; never certify source closure.

The receipt deliberately retains CAPTURE/v1. Its booleans describe the origin
and absence of a compiler rebuild, not whether capture.json reports success.
Publication/source-component limits and their validators are independent.
"""
import hashlib
import json
import lzma
import os
from pathlib import Path, PurePosixPath
import re
import stat
import tarfile

CAPTURE = 'gp-semgrep-core-license-capture/v1'
MAX_EXPANDED = 8 * 1024**3
MAX_ARCHIVE = 2 * 1024**3
MAX_FILE = 512 * 1024**2
MAX_MEMBERS = 250000
MAX_JSON = 64 * 1024**2
CHUNK = 1024**2
MAX_PAX = 65536
MAX_XZ_MEMORY = 64 * 1024**2
HASH = re.compile(r'[a-f0-9]{64}')
_POSIX_FDS = os.name == 'posix'


def source_relative(name):
    if not isinstance(name, str) or not name or '\\' in name or any(ord(c) < 32 or ord(c) == 127 for c in name):
        raise ValueError('Unsafe original source member')
    value = PurePosixPath(name)
    if (not value.parts or value.is_absolute() or value.as_posix() != name or any(part in ('.', '..')
            or re.match(r'^[A-Za-z]:', part) for part in value.parts)):
        raise ValueError('Unsafe original source member')
    if len(name.encode('utf-8')) > MAX_PAX - 64:
        raise ValueError('Source member path exceeds bound')
    return name


def _member(name):
    source_relative(name)
    if not (name in ('capture.json', 'custom-curl.tar.gz', 'opam-switch-state', 'apk-installed-database')
            or name.startswith(('opam-download-cache/', 'opam-sources/', 'opam-package-metadata/', 'opam-install-evidence/'))):
        raise ValueError('Unexpected compiler capture member')
    return name


def _owner(value):
    if _POSIX_FDS and value.st_uid not in (0, os.geteuid()):
        raise ValueError('Foreign compiler capture owner')


def _identity(value):
    return (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns,
            value.st_ctime_ns, value.st_nlink, value.st_mode, value.st_uid, value.st_gid)


class _Directory:
    """Pinned directories; Unix traversal/open operations use NOFOLLOW dirfds."""
    def __init__(self, path, parent=None, name=None, private=False):
        self.path = Path(path).absolute()
        self.fd = None
        self.parent, self.name = parent, name
        before = parent.lstat(name) if parent is not None else self.path.lstat()
        if self.path.resolve(strict=True) != self.path or not stat.S_ISDIR(before.st_mode):
            raise ValueError('Capture requires a canonical directory')
        _owner(before)
        if private and _POSIX_FDS and before.st_mode & 0o077:
            raise ValueError('Capture directory must be private')
        if _POSIX_FDS:
            flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
            self.fd = os.open(name if parent else self.path, flags,
                **({'dir_fd': parent.fd} if parent else {}))
            if _identity(before) != _identity(os.fstat(self.fd)):
                self.close()
                raise ValueError('Changed capture directory')
        self.before = before

    def lstat(self, name):
        return os.stat(name, dir_fd=self.fd, follow_symlinks=False) if _POSIX_FDS else (self.path / name).lstat()

    def open(self, name, flags, mode=0o600):
        flags |= getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_CLOEXEC', 0) | getattr(os, 'O_NONBLOCK', 0)
        return os.open(name if _POSIX_FDS else self.path / name, flags, mode,
            **({'dir_fd': self.fd} if _POSIX_FDS else {}))

    def readlink(self, name):
        target = os.readlink(name, dir_fd=self.fd) if _POSIX_FDS else os.readlink(self.path / name)
        return os.fsencode(target)

    def names(self):
        result = []
        with os.scandir(self.fd if _POSIX_FDS else self.path) as entries:
            for item in entries:
                result.append(item.name)
                if len(result) > MAX_MEMBERS:
                    raise ValueError('Capture directory entry count exceeds bound')
        return sorted(result)

    def stable(self, mutable=False):
        after = self.parent.lstat(self.name) if self.parent else self.path.lstat()
        opened = os.fstat(self.fd) if self.fd is not None else after
        if mutable:
            indexes = (0, 1, 6, 7, 8)
            same = lambda a, b: all(_identity(a)[i] == _identity(b)[i] for i in indexes)
        else:
            same = lambda a, b: _identity(a) == _identity(b)
        if self.path.resolve(strict=True) != self.path or not same(self.before, after) or not same(self.before, opened):
            raise ValueError('Changed capture directory')

    def close(self):
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None

    def __enter__(self):
        return self

    def __exit__(self, *unused):
        self.close()


class _Regular:
    def __init__(self, directory, name, maximum):
        self.directory, self.name = directory, name
        self.before = directory.lstat(name)
        _owner(self.before)
        if (not stat.S_ISREG(self.before.st_mode) or self.before.st_nlink != 1
                or self.before.st_size < 0 or self.before.st_size > maximum):
            raise ValueError('Unsafe compiler capture input')
        self.stream = os.fdopen(directory.open(name, os.O_RDONLY), 'rb')
        if _identity(self.before) != _identity(os.fstat(self.stream.fileno())):
            self.stream.close()
            raise ValueError('Changed compiler capture input')
        self.count, self.sha = 0, hashlib.sha256()

    def read(self, size):
        if not isinstance(size, int) or size < 0 or size > CHUNK:
            raise ValueError('Unbounded capture read')
        value = self.stream.read(size)
        self.count += len(value)
        if self.count > self.before.st_size:
            raise ValueError('Changed compiler capture input')
        self.sha.update(value)
        return value

    def finish(self):
        if self.read(1) or self.count != self.before.st_size:
            raise ValueError('Changed compiler capture input')
        if (_identity(self.before) != _identity(os.fstat(self.stream.fileno()))
                or _identity(self.before) != _identity(self.directory.lstat(self.name))):
            raise ValueError('Changed compiler capture input')
        self.directory.stable()

    def __enter__(self):
        return self

    def __exit__(self, *unused):
        self.stream.close()


class _LimitedWriter:
    def __init__(self, stream, maximum, label):
        self.stream, self.maximum, self.label = stream, maximum, label
        self.count, self.sha = 0, hashlib.sha256()

    def write(self, value):
        if self.count + len(value) > self.maximum:
            raise ValueError(self.label + ' exceeds bound')
        self.stream.write(value)
        self.count += len(value)
        self.sha.update(value)
        return len(value)

    def flush(self):
        self.stream.flush()


class _ExpandedReader:
    def __init__(self, stream):
        self.stream, self.count = stream, 0

    def read(self, size):
        if size < 0 or size > CHUNK:
            raise ValueError('Unbounded expanded capture read')
        data = self.stream.read(size)
        self.count += len(data)
        if self.count > MAX_EXPANDED:
            raise ValueError('Expanded capture exceeds bound')
        return data


class _XZReader:
    def __init__(self, stream):
        self.stream = stream
        self.decoder = lzma.LZMADecompressor(format=lzma.FORMAT_XZ, memlimit=MAX_XZ_MEMORY)
        self.finished = False

    def read(self, size):
        if not isinstance(size, int) or not 0 <= size <= CHUNK:
            raise ValueError('Unbounded compressed capture read')
        result = bytearray()
        while len(result) < size and not self.finished:
            if self.decoder.eof:
                if self.decoder.unused_data or self.stream.read(1):
                    raise ValueError('Trailing compressed capture data')
                self.finished = True
                break
            data = self.stream.read(CHUNK) if self.decoder.needs_input else b''
            if self.decoder.needs_input and not data:
                raise ValueError('Truncated compressed capture')
            try:
                result.extend(self.decoder.decompress(data, max_length=size - len(result)))
            except lzma.LZMAError:
                raise ValueError('Invalid compressed capture stream or memory bound') from None
        return bytes(result)

    def __enter__(self):
        return self

    def __exit__(self, *unused):
        pass


class _LinkReader:
    def __init__(self, value):
        self.value, self.position = value, 0

    def read(self, size):
        result = self.value[self.position:self.position + size]
        self.position += len(result)
        return result

    def close(self):
        pass


def _encoded(value):
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')) + '\n').encode('utf-8')


def _unique(data):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError('Duplicate capture metadata key')
            result[key] = value
        return result
    return json.loads(data, object_pairs_hook=pairs)


def _identity_arguments(image_id, binary_sha):
    if (not isinstance(image_id, str) or not re.fullmatch(r'sha256:[a-f0-9]{64}', image_id)
            or not isinstance(binary_sha, str) or not HASH.fullmatch(binary_sha)):
        raise ValueError('Capture requires exact image and binary identities')


def _walk(directory, prefix='', state=None, depth=0):
    if state is None:
        state = [0]
    if depth > 128:
        raise ValueError('Capture directory depth exceeds bound')
    for name in directory.names():
        item = directory.lstat(name)
        if stat.S_ISDIR(item.st_mode) and name in ('.git', '_build'):
            continue
        if stat.S_ISLNK(item.st_mode) and name in ('.git', '_build'):
            # os.walk's old exclusion applies only to directory links, whose
            # targets cannot safely be inspected here. Exclude reserved tree
            # names conservatively without resolving either kind of link.
            continue
        state[0] += 1
        if state[0] > MAX_MEMBERS * 2:
            raise ValueError('Capture tree entry count exceeds bound')
        key = source_relative(prefix + name)
        if stat.S_ISDIR(item.st_mode):
            with _Directory(directory.path / name, directory, name) as child:
                yield from _walk(child, key + '/', state, depth + 1)
                child.stable()
        elif stat.S_ISLNK(item.st_mode):
            _owner(item)
            if item.st_nlink != 1:
                raise ValueError('Unsafe capture source link')
            target = directory.readlink(name)
            if len(target) > MAX_FILE or _identity(item) != _identity(directory.lstat(name)):
                raise ValueError('Changed capture source link')
            yield key + '.symlink-target', target, None
        elif stat.S_ISREG(item.st_mode):
            yield key, None, (directory, name)
        else:
            raise ValueError('Unsupported compiler capture source type')
    directory.stable()


def _new_file(directory, name):
    fd = directory.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL)
    value = os.fstat(fd)
    if not stat.S_ISREG(value.st_mode) or value.st_nlink != 1:
        os.close(fd)
        raise ValueError('Unsafe capture output')
    return os.fdopen(fd, 'wb'), value


def _remove_owned(directory, name, identity):
    try:
        current = directory.lstat(name)
        if (current.st_dev, current.st_ino) == (identity.st_dev, identity.st_ino) and stat.S_ISREG(current.st_mode):
            os.unlink(name if _POSIX_FDS else directory.path / name,
                **({'dir_fd': directory.fd} if _POSIX_FDS else {}))
    except FileNotFoundError:
        pass


def write_capture(capture_root, output, image_id, binary_sha):
    """Retain exact available bytes, including a failed/partial observation."""
    _identity_arguments(image_id, binary_sha)
    capture_root, output = Path(capture_root).absolute(), Path(output).absolute()
    if output == capture_root or capture_root in output.parents:
        raise ValueError('Capture output cannot be inside source tree')
    with _Directory(capture_root, private=True) as source, _Directory(output, private=True) as destination:
        for name in ('capture.tar.xz', 'capture-receipt.json'):
            try:
                destination.lstat(name)
            except FileNotFoundError:
                continue
            raise ValueError('Capture output already exists')
        created = []
        try:
            raw, original = _new_file(destination, 'capture.tar.xz')
            created.append(('capture.tar.xz', original))
            inventory, seen, json_bytes = [], set(), 1024
            with raw:
                compressed = _LimitedWriter(raw, MAX_ARCHIVE, 'Compressed capture')
                with lzma.LZMAFile(compressed, 'wb', preset=0) as xz:
                    expanded = _LimitedWriter(xz, MAX_EXPANDED, 'Expanded capture')
                    with tarfile.open(fileobj=expanded, mode='w|', format=tarfile.PAX_FORMAT, bufsize=CHUNK) as archive:
                        archive.copybufsize = CHUNK
                        for name, link_text, regular in _walk(source):
                            _member(name)
                            if name in seen or len(inventory) >= MAX_MEMBERS:
                                raise ValueError('Duplicate or excessive capture members')
                            seen.add(name)
                            if regular is None:
                                stream = _LinkReader(link_text)
                                size, sha = len(link_text), hashlib.sha256(link_text).hexdigest()
                                managed = None
                            else:
                                managed = _Regular(*regular, MAX_FILE)
                                stream, size = managed, managed.before.st_size
                            info = tarfile.TarInfo(name)
                            info.size, info.mode = size, 0o644
                            info.uid = info.gid = info.mtime = 0
                            info.uname = info.gname = ''
                            try:
                                archive.addfile(info, stream)
                                if managed is not None:
                                    managed.finish()
                                    sha = managed.sha.hexdigest()
                            finally:
                                if managed is not None:
                                    managed.__exit__()
                                else:
                                    stream.close()
                            row = {'path': name, 'bytes': size, 'sha256': sha}
                            json_bytes += len(_encoded(row)) + 1
                            if json_bytes > MAX_JSON:
                                raise ValueError('Capture receipt exceeds JSON bound')
                            inventory.append(row)
                raw.flush()
                os.fsync(raw.fileno())
            source.stable()
            current = destination.lstat('capture.tar.xz')
            if (current.st_dev, current.st_ino, current.st_size, current.st_nlink) != (
                    original.st_dev, original.st_ino, compressed.count, 1):
                raise ValueError('Changed capture output')
            receipt = {'format': CAPTURE, 'archive': {'bytes': compressed.count, 'sha256': compressed.sha.hexdigest()},
                'imageId': image_id, 'binarySha256': binary_sha, 'upstreamOnly': True, 'compilerRebuilt': False,
                'memberInventory': inventory}
            stream, original = _new_file(destination, 'capture-receipt.json')
            created.append(('capture-receipt.json', original))
            with stream:
                bounded = _LimitedWriter(stream, MAX_JSON, 'Capture receipt JSON')
                encoder = json.JSONEncoder(ensure_ascii=False, sort_keys=True, separators=(',', ':'))
                for part in encoder.iterencode(receipt):
                    bounded.write(part.encode('utf-8'))
                bounded.write(b'\n')
                stream.flush()
                os.fsync(stream.fileno())
            destination.stable(mutable=True)
            return receipt
        except Exception:
            for name, identity in reversed(created):
                _remove_owned(destination, name, identity)
            raise


def _exact(stream, count):
    chunks = []
    remaining = count
    while remaining:
        value = stream.read(min(CHUNK, remaining))
        if not value:
            raise ValueError('Truncated capture archive')
        chunks.append(value)
        remaining -= len(value)
    return b''.join(chunks)


def _pax(data):
    position, result = 0, {}
    while position < len(data):
        space = data.find(b' ', position, position + 16)
        if space < 0 or not data[position:space].isdigit():
            raise ValueError('Invalid capture PAX metadata')
        length = int(data[position:space])
        end = position + length
        if length <= space - position + 1 or end > len(data) or data[end - 1:end] != b'\n':
            raise ValueError('Invalid capture PAX metadata')
        key, separator, value = data[space + 1:end - 1].partition(b'=')
        if separator != b'=' or key != b'path' or key in result:
            raise ValueError('Unexpected capture PAX metadata')
        result[key] = value.decode('utf-8', errors='strict')
        position = end
    if set(result) != {b'path'}:
        raise ValueError('Missing capture PAX path')
    return source_relative(result[b'path'])


def _validate_receipt(receipt):
    if (not isinstance(receipt, dict) or set(receipt) != {'format', 'archive', 'imageId', 'binarySha256',
            'upstreamOnly', 'compilerRebuilt', 'memberInventory'} or receipt['format'] != CAPTURE
            or receipt['upstreamOnly'] is not True or receipt['compilerRebuilt'] is not False):
        raise ValueError('Invalid upstream-only capture receipt')
    _identity_arguments(receipt['imageId'], receipt['binarySha256'])
    archive = receipt['archive']
    if (not isinstance(archive, dict) or set(archive) != {'bytes', 'sha256'} or type(archive['bytes']) is not int
            or not 0 < archive['bytes'] <= MAX_ARCHIVE or not isinstance(archive['sha256'], str)
            or not HASH.fullmatch(archive['sha256'])):
        raise ValueError('Invalid capture archive identity')
    inventory, seen, total = receipt['memberInventory'], set(), 0
    if not isinstance(inventory, list) or len(inventory) > MAX_MEMBERS:
        raise ValueError('Invalid capture member inventory')
    for row in inventory:
        if not isinstance(row, dict) or set(row) != {'path', 'bytes', 'sha256'}:
            raise ValueError('Invalid capture member inventory')
        name = _member(row['path'])
        if (name in seen or type(row['bytes']) is not int or not 0 <= row['bytes'] <= MAX_FILE
                or not isinstance(row['sha256'], str) or not HASH.fullmatch(row['sha256'])):
            raise ValueError('Invalid capture member identity')
        seen.add(name)
        total += row['bytes']
        if total > MAX_EXPANDED:
            raise ValueError('Expanded capture inventory exceeds bound')


def verify_capture(output):
    """Independently stream/hash every member; never extract or follow a link."""
    with _Directory(output, private=True) as directory:
        with _Regular(directory, 'capture-receipt.json', MAX_JSON) as metadata:
            parts = []
            while True:
                part = metadata.read(min(CHUNK, metadata.before.st_size - metadata.count))
                if not part:
                    break
                parts.append(part)
            metadata.finish()
            receipt = _unique(b''.join(parts))
        _validate_receipt(receipt)
        with _Regular(directory, 'capture.tar.xz', MAX_ARCHIVE) as raw:
            if raw.before.st_size != receipt['archive']['bytes']:
                raise ValueError('Capture archive bytes differ')
            with _XZReader(raw) as xz:
                expanded, index, pending, total = _ExpandedReader(xz), 0, None, 0
                while True:
                    block = _exact(expanded, 512)
                    if block == b'\0' * 512:
                        if pending is not None or _exact(expanded, 512) != b'\0' * 512:
                            raise ValueError('Invalid capture archive terminator')
                        while True:
                            tail = expanded.read(CHUNK)
                            if not tail:
                                break
                            if tail.strip(b'\0'):
                                raise ValueError('Unexpected trailing capture archive data')
                        break
                    try:
                        item = tarfile.TarInfo.frombuf(block, encoding='utf-8', errors='strict')
                    except (tarfile.HeaderError, UnicodeError):
                        raise ValueError('Invalid capture archive header') from None
                    if item.type == tarfile.XHDTYPE:
                        if pending is not None or not 0 < item.size <= MAX_PAX:
                            raise ValueError('Oversized or repeated capture PAX metadata')
                        pending = _pax(_exact(expanded, item.size))
                        if _exact(expanded, (-item.size) % 512).strip(b'\0'):
                            raise ValueError('Invalid capture archive padding')
                        continue
                    if item.type not in (tarfile.REGTYPE, tarfile.AREGTYPE) or item.linkname or item.size < 0 or item.size > MAX_FILE:
                        raise ValueError('Unexpected capture archive member type or size')
                    name = _member(pending if pending is not None else item.name)
                    pending = None
                    if index >= len(receipt['memberInventory']) or index >= MAX_MEMBERS:
                        raise ValueError('Unexpected or excessive capture archive member')
                    expected = receipt['memberInventory'][index]
                    if name != expected['path'] or item.size != expected['bytes']:
                        raise ValueError('Capture source inventory differs')
                    total += item.size
                    if total > MAX_EXPANDED:
                        raise ValueError('Expanded capture members exceed bound')
                    sha, remaining = hashlib.sha256(), item.size
                    while remaining:
                        data = expanded.read(min(CHUNK, remaining))
                        if not data:
                            raise ValueError('Truncated capture member')
                        remaining -= len(data)
                        sha.update(data)
                    if sha.hexdigest() != expected['sha256']:
                        raise ValueError('Capture source member hash differs')
                    if _exact(expanded, (-item.size) % 512).strip(b'\0'):
                        raise ValueError('Invalid capture archive padding')
                    index += 1
                if index != len(receipt['memberInventory']):
                    raise ValueError('Missing capture archive member')
            raw.finish()
            if raw.sha.hexdigest() != receipt['archive']['sha256']:
                raise ValueError('Capture archive hash differs')
        directory.stable()
        return receipt

"""Collect actual Alpine static-input sources without executing APKBUILD files.

The installed package's exact aports commit and literal source checksums are the
authority. Mirror filenames alone, an SPDX label, or a self-declared completeness
flag never authorize a source. This intentionally rejects unsupported recipes.
"""
import hashlib
import io
import json
import lzma
from pathlib import Path, PurePosixPath
import posixpath
import re
import tarfile
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from collections import OrderedDict

# The genuine linux-headers distfile alone is >128 MiB; compiler/runtime
# source distributions may be larger. This remains a hard per-download bound.
MAX_DOWNLOAD = 512 * 1024**2
MAX_APORTS = 96 * 1024**2
MAX_NOTICE = 1024**2
MAX_NOTICE_TOTAL = 3 * 1024**2
MAX_MEMBERS = 250000
NAME = re.compile(r'[a-z0-9][a-z0-9+_.-]{0,99}')
VERSION = re.compile(r'[A-Za-z0-9][A-Za-z0-9+_.-]{0,119}-r[0-9]+')
COMMIT = re.compile(r'[a-f0-9]{40}')
NOTICE = re.compile(r'(?:licen[sc]e|copying|copyright|notice)(?:[._-].*)?', re.I)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def encoded(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False) + '\n').encode()


def download(url, maximum=MAX_DOWNLOAD):
    parsed = urllib.parse.urlsplit(url)
    if (parsed.scheme != 'https' or parsed.hostname not in {
            'codeload.github.com', 'distfiles.alpinelinux.org'} or parsed.username
            or parsed.password or parsed.fragment or parsed.query or parsed.port):
        raise ValueError('Unreviewed native source download URL')
    request = urllib.request.Request(url, headers={'User-Agent': 'gp-compiler-license-source-collector'})
    # These endpoints serve bytes directly. A cross-host redirect must never
    # silently change the selected source or forward runner credentials.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            return None
    with urllib.request.build_opener(NoRedirect).open(request, timeout=60) as response:
        data = response.read(maximum + 1)
    if not data or len(data) > maximum:
        raise ValueError('Native source download exceeds its bound')
    return data


def safe_name(name):
    if not isinstance(name, str) or not name or '\\' in name or ':' in name or any(ord(c) < 32 or ord(c) == 127 for c in name):
        raise ValueError('Unsafe native source member')
    while name.startswith('./'):
        name = name[2:]
    parsed = PurePosixPath(name)
    if not name or parsed.is_absolute() or '..' in parsed.parts or parsed.as_posix() != name.rstrip('/'):
        raise ValueError('Unsafe native source member')
    return name.rstrip('/')


def recipe_files(data, origin, commit):
    """Only the actual origin directory from an exact official aports snapshot."""
    prefixes = [f'aports-{commit}/{repository}/{origin}/' for repository in ('main', 'community', 'testing')]
    matches = {}
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
        for count, item in enumerate(archive, 1):
            if count > MAX_MEMBERS:
                raise ValueError('Oversized aports source inventory')
            match = next((prefix for prefix in prefixes if item.name.startswith(prefix)), None)
            if not match or item.isdir():
                continue
            relative = safe_name(item.name[len(match):])
            if not item.isfile() or item.size > 16 * 1024**2 or relative in matches:
                raise ValueError('Unsafe or duplicate aports recipe member')
            stream = archive.extractfile(item)
            content = stream.read(item.size + 1)
            if len(content) != item.size:
                raise ValueError('Truncated aports recipe')
            matches[relative] = content
    if 'APKBUILD' not in matches:
        raise ValueError('Actual installed aports origin not found')
    return matches


def recipe_checksums(content, installed_version):
    try:
        text = content.decode('utf8')
    except UnicodeError as error:
        raise ValueError('APKBUILD is not UTF-8') from error
    values = {}
    for key in ('pkgver', 'pkgrel'):
        found = re.findall(r'^' + key + r'=(?:"([^"\n]+)"|\x27([^\x27\n]+)\x27|([^\s#]+))\s*(?:#.*)?$', text, re.M)
        if len(found) != 1:
            raise ValueError('APKBUILD version must be a literal exact installed version')
        values[key] = next(value for value in found[0] if value)
    if values['pkgver'] + '-r' + values['pkgrel'] != installed_version:
        raise ValueError('APKBUILD version differs from installed native package')
    assignments = list(re.finditer(r'^sha512sums=(?:"([^"$`]*)"|\x27([^\x27]*)\x27)\s*$', text, re.M))
    # Dynamic, appended, architecture-selected or skipped sums need a separately
    # reviewed parser; do not evaluate upstream shell to guess their meaning.
    if len(assignments) != 1 or len(re.findall(r'^\s*sha512sums(?:\+)?=', text, re.M)) != 1:
        raise ValueError('Native source checksum declaration is unsupported')
    sums = {}
    for line in next(value for value in assignments[0].groups() if value is not None).splitlines():
        if not line.strip():
            continue
        match = re.fullmatch(r'([a-f0-9]{128})\s+([^\s]+)', line.strip())
        if not match:
            raise ValueError('Native source checksum is missing, skipped or dynamic')
        digest, name = match.groups()
        if safe_name(name) != name or '/' in name or name in sums:
            raise ValueError('Unsafe or duplicate native distfile')
        sums[name] = digest
    if not sums:
        raise ValueError('Native source checksums required')
    return sums


def _notice(path, data):
    if not 80 <= len(data) <= MAX_NOTICE or b'\0' in data:
        return None
    if sum(c < 32 and c not in (9, 10, 13) for c in data) > len(data) // 100:
        return None
    try:
        text, encoding = data.decode('utf8'), 'utf8'
    except UnicodeError:
        text, encoding = data.decode('latin1'), 'latin1'
    return {'path': path, 'text': text, 'sha256': sha(text.encode('utf8')),
            'sourceBytesSha256': sha(data), 'encoding': encoding}


def source_notices(filename, data):
    notices = []
    if tarfile.is_tarfile(io.BytesIO(data)):
        with tarfile.open(fileobj=io.BytesIO(data), mode='r:*') as archive:
            for count, item in enumerate(archive, 1):
                if count > MAX_MEMBERS:
                    raise ValueError('Oversized native source archive')
                name = safe_name(item.name)
                if item.issym() or item.islnk():
                    target = posixpath.normpath(posixpath.join(posixpath.dirname(name), item.linkname))
                    if target.startswith('../') or target.startswith('/') or target == '..':
                        raise ValueError('Escaping native source link')
                    continue
                if item.isfile() and NOTICE.fullmatch(PurePosixPath(name).name) and item.size <= MAX_NOTICE:
                    value = _notice(filename + '::' + name, archive.extractfile(item).read(item.size + 1))
                    if value:
                        notices.append(value)
    elif zipfile.is_zipfile(io.BytesIO(data)):
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            entries = archive.infolist()
            if len(entries) > MAX_MEMBERS:
                raise ValueError('Oversized native source archive')
            for item in entries:
                name = safe_name(item.filename)
                if not item.is_dir() and NOTICE.fullmatch(PurePosixPath(name).name) and item.file_size <= MAX_NOTICE:
                    value = _notice(filename + '::' + name, archive.read(item))
                    if value:
                        notices.append(value)
    elif NOTICE.fullmatch(filename):
        value = _notice(filename, data)
        if value:
            notices.append(value)
    # Identical license copies do not make the JSON grow with every source file.
    unique = {item['sha256']: item for item in notices}
    if sum(len(item['text'].encode('utf8')) for item in unique.values()) > MAX_NOTICE_TOTAL:
        raise ValueError('Native notice texts exceed the review bound')
    return sorted(unique.values(), key=lambda item: item['path'])


def bundle_bytes(members):
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode='w', format=tarfile.PAX_FORMAT) as archive:
        for name, data in sorted(members.items()):
            safe_name(name)
            item = tarfile.TarInfo(name)
            item.uid = item.gid = item.mtime = 0
            item.uname = item.gname = ''
            item.mode = 0o644
            item.size = len(data)
            archive.addfile(item, io.BytesIO(data))
    # Most distfiles already are compressed. Recompressing them expensively
    # gives negligible savings and does not strengthen their hash binding.
    return lzma.compress(buffer.getvalue(), format=lzma.FORMAT_XZ, preset=0)


def collect_native(capture, capture_root, dependency_sources):
    """Conservative source/notice superset for actual .a and header owners."""
    capture_root, dependency_sources = Path(capture_root), Path(dependency_sources)
    if capture_root.resolve() != capture_root.absolute() or dependency_sources.resolve() != dependency_sources.absolute():
        raise ValueError('Native collection roots must be canonical')
    packages = {}
    for item in capture['apkPackages']:
        if (not isinstance(item, dict) or not NAME.fullmatch(item.get('name', ''))
                or not NAME.fullmatch(item.get('origin', '')) or not VERSION.fullmatch(item.get('version', ''))
                or item.get('id') != item['name'] + '.' + item['version'] or item['id'] in packages
                or not COMMIT.fullmatch(item.get('commit', '')) or not isinstance(item.get('licenseExpression'), str)
                or not item['licenseExpression'].strip()):
            raise ValueError('Actual native package identity is incomplete')
        packages[item['id']] = item
    owners = set()
    for item in capture['nativeInputs']:
        owner = item.get('owner')
        if owner == 'custom-curl.8.5.0':
            continue
        if owner not in packages:
            raise ValueError('Native input has no actual installed APK owner')
        owners.add(owner)
    grouped = {}
    for owner in sorted(owners):
        item = packages[owner]
        grouped.setdefault((item['origin'], item['version'], item['commit']), []).append(item)
    result, snapshots = [], OrderedDict()
    for (origin, version, commit), selected in sorted(grouped.items()):
        snapshot_url = f'https://codeload.github.com/alpinelinux/aports/tar.gz/{commit}'
        if commit not in snapshots:
            if len(snapshots) >= 2:
                snapshots.popitem(last=False)
            snapshots[commit] = download(snapshot_url, MAX_APORTS)
        else:
            snapshots.move_to_end(commit)
        recipe = recipe_files(snapshots[commit], origin, commit)
        sums = recipe_checksums(recipe['APKBUILD'], version)
        members = {'aports/' + name: data for name, data in recipe.items()}
        distfiles, notices = [], []
        for name, expected in sorted(sums.items()):
            if name in recipe:
                data, url = recipe[name], snapshot_url
            else:
                url = 'https://distfiles.alpinelinux.org/distfiles/v3.23/' + urllib.parse.quote(name, safe='')
                try:
                    data = download(url)
                except urllib.error.HTTPError as error:
                    if error.code != 404:
                        raise
                    url = 'https://distfiles.alpinelinux.org/distfiles/edge/' + urllib.parse.quote(name, safe='')
                    data = download(url)
                members['distfiles/' + name] = data
            if hashlib.sha512(data).hexdigest() != expected:
                raise ValueError('Native distfile differs from exact aports SHA-512')
            distfiles.append({'filename': name, 'url': url, 'bytes': len(data), 'sha512': expected, 'sha256': sha(data)})
            notices.extend(source_notices(name, data))
        notices = sorted({item['sha256']: item for item in notices}.values(), key=lambda item: item['path'])
        if not notices:
            raise ValueError('Genuine native dependency license text is missing: ' + origin)
        expressions = sorted({item['licenseExpression'] for item in selected})
        license_expression = expressions[0] if len(expressions) == 1 else ' AND '.join('(' + value + ')' for value in expressions)
        package_ids = sorted(item['id'] for item in selected)
        metadata = {'format': 'gp-compiler-native-source/v1', 'aportsCommit': commit, 'origin': origin,
            'version': version, 'packageIds': package_ids, 'recipeFiles': [
                {'path': name, 'sha256': sha(data), 'bytes': len(data)} for name, data in sorted(recipe.items())],
            'distfiles': distfiles, 'sourceExecutionPerformed': False}
        members['native-source-metadata.json'] = encoded(metadata)
        data = bundle_bytes(members)
        name = 'apk-' + origin + '-' + version + '-' + commit[:12] + '.tar.xz'
        destination = dependency_sources / name
        with destination.open('xb') as stream:
            stream.write(data)
        result.append({'name': 'apk/' + origin, 'version': version, 'packageIds': package_ids,
            'licenseExpression': license_expression, 'notices': notices,
            'correspondingSource': {'filename': name, 'sha256': sha(data), 'bytes': len(data), 'url': snapshot_url}})
    return result

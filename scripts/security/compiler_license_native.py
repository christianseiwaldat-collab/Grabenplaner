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



# Independently inventoried original rustc source from the exact actual APKBUILD.
# Every unknown source retains the ordinary bounds. This identity is a source
# distribution, never an executable or pin-authority exception.
RUST_SOURCE = {
    'filename': 'rustc-1.91.1-src.tar.xz', 'bytes': 270957016,
    'sha256': '66401bb815e236cc6b2aacbbe23b61b286c1fe27a67902e7c0222cfe77b3dbab',
    'sha512': '68b6bebff2e1b3bc5762951bec60f55cb7f23fd516ca85195f8050790f20c6cefdc3c5ffe0c40aa2d34635f48fa01f567874bcea3076ad5c260eae1afd759870',
    'origin': 'rust', 'version': '1.91.1-r2',
    'commit': 'f20e2685939216429125190ec33b5d6a2370e91a',
    'members': 290629, 'expandedBytes': 3484095662,
}


def source_inventory_bounds(filename, data, *, origin=None, version=None, commit=None):
    reviewed = RUST_SOURCE
    if (filename == reviewed['filename'] and len(data) == reviewed['bytes']
            and (origin, version, commit) == (reviewed['origin'], reviewed['version'], reviewed['commit'])
            and sha(data) == reviewed['sha256']
            and hashlib.sha512(data).hexdigest() == reviewed['sha512']):
        return reviewed['members'], reviewed['expandedBytes'], True
    return MAX_MEMBERS, 2 * 1024**3, False


def source_notices(filename, data, *, origin=None, version=None, commit=None):
    notices = []
    member_limit, expanded_limit, exact_inventory = source_inventory_bounds(filename, data, origin=origin, version=version, commit=commit)
    total = count = 0
    if tarfile.is_tarfile(io.BytesIO(data)):
        with tarfile.open(fileobj=io.BytesIO(data), mode='r:*') as archive:
            for count, item in enumerate(archive, 1):
                if count > member_limit:
                    raise ValueError('Oversized native source archive')
                if item.isfile():
                    total += item.size
                    if total > expanded_limit:
                        raise ValueError('Native source expansion exceeds reviewed bound')
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
    if exact_inventory and (count != member_limit or total != expanded_limit):
        raise ValueError('Reviewed native source inventory differs')
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



# This exact installed header package carries its complete BSD-3-Clause notice
# in queue.h and BSD-2-Clause notice in tree.h. Its tiny cdefs.h has no separate
# notice: retain it verbatim with the original package declaration, never invent
# a per-file attribution or derive license text from an SPDX name.
BSD_ORIGIN = 'bsd-compat-headers'
BSD_VERSION = '0.7.2-r6'
BSD_COMMIT = 'f578a91aef36679e703bd8badf6725cf838244da'
BSD_EXPRESSION = 'BSD-2-Clause AND BSD-3-Clause'
BSD_RECIPE_SHA256 = '362d5bf294bcc22f5c24e7addad966e4cd655ef6ee6b59b96c4bcecd334c1819'
BSD_HEADERS = {'cdefs.h': {'bytes': 612, 'sha256': '15b1dd86710a4c5fc0654dbd871965b227474eb7f54531eebafffe8c1061f10e', 'sha512': '37c8fc73c7aea7b490f7850927e2bb91d12137c9e59e22c084146d515696dbc7973b5de92f4c987ba080dd2502ba83127006442c3f019b6447a620c0cae73178'}, 'queue.h': {'bytes': 30075, 'sha256': 'c13407edd0e33be73cae72514cb234f8612e1c0e54401c9448daffd3a240158b', 'sha512': '2f0d5e6e4dc3350285cf17009265dddcbe12431c111868eea39bc8cb038ab7c1f2acacbb21735c4e9d4a1fd106a8fc0f8611ea33987d4faba37dde5ce6da0750'}, 'tree.h': {'bytes': 26161, 'sha256': 'e0ea17940260f9c1fdd2d35f74eec141d21f09844eaea91131993cb950901a16', 'sha512': 'd9ac210d81feb8ad2655bc80fb065d3fe20ae4417b32b4a1711e6738a4870140005c13373b5d1846ef3ce5ae6da45f2dacef2092881eded0a2e94f6a07752ef3'}}


def _bsd_recipe(recipe):
    if set(recipe) != {'APKBUILD', *BSD_HEADERS} or sha(recipe['APKBUILD']) != BSD_RECIPE_SHA256:
        raise ValueError('Exact BSD header source recipe differs')
    sums = recipe_checksums(recipe['APKBUILD'], BSD_VERSION)
    if sums != {name: row['sha512'] for name, row in BSD_HEADERS.items()}:
        raise ValueError('Exact BSD header checksums differ')
    for name, row in BSD_HEADERS.items():
        data = recipe[name]
        if (len(data) != row['bytes'] or sha(data) != row['sha256']
                or hashlib.sha512(data).hexdigest() != row['sha512']):
            raise ValueError('Exact BSD original header bytes differ')
    return sums


def bsd_header_notices(origin, version, commit, selected, recipe):
    if origin != BSD_ORIGIN:
        return []
    if (version != BSD_VERSION or commit != BSD_COMMIT or len(selected) != 1
            or selected[0]['id'] != BSD_ORIGIN + '.' + BSD_VERSION
            or selected[0]['licenseExpression'] != BSD_EXPRESSION):
        raise ValueError('Unreviewed BSD header package identity')
    _bsd_recipe(recipe)
    return [_notice('aports/' + name, recipe[name]) for name in ('queue.h', 'tree.h')]


def reviewed_header_source_notice(name, data):
    # Consumer discovery never broadens to arbitrary .h source. Only these two
    # reviewed original complete headers may supply a primary license hash.
    return any(name == 'aports/' + key and len(data) == BSD_HEADERS[key]['bytes']
        and sha(data) == BSD_HEADERS[key]['sha256'] for key in ('queue.h', 'tree.h'))


def requires_bsd_header_review(component):
    return component['name'] == 'apk/' + BSD_ORIGIN or BSD_ORIGIN + '.' + BSD_VERSION in component['packageIds']


def validate_bsd_header_component(component):
    if not requires_bsd_header_review(component):
        return
    if (component['name'] != 'apk/' + BSD_ORIGIN or component['version'] != BSD_VERSION or component['packageIds'] != [BSD_ORIGIN + '.' + BSD_VERSION]
            or component['licenseExpression'] != BSD_EXPRESSION or 'licenseEvidence' in component):
        raise ValueError('Unreviewed BSD header component identity')
    notices = component['notices']
    if not isinstance(notices, list) or len(notices) != 2:
        raise ValueError('Both original BSD header notices are required')
    for item, name in zip(notices, ('queue.h', 'tree.h')):
        try:
            data = item['text'].encode('utf8')
        except (KeyError, AttributeError, UnicodeError):
            raise ValueError('Invalid BSD header notice text') from None
        if (len(data) != BSD_HEADERS[name]['bytes'] or sha(data) != BSD_HEADERS[name]['sha256']
                or item != _notice('aports/' + name, data)):
            raise ValueError('Original BSD header notice differs')
    source = component['correspondingSource']
    expected_name = 'apk-' + BSD_ORIGIN + '-' + BSD_VERSION + '-' + BSD_COMMIT[:12] + '.tar.xz'
    if (not isinstance(source, dict) or source.get('filename') != expected_name
            or source.get('url') != 'https://codeload.github.com/alpinelinux/aports/tar.gz/' + BSD_COMMIT):
        raise ValueError('Exact BSD header source provenance differs')


def validate_bsd_header_source(component, data):
    if not requires_bsd_header_review(component):
        return
    validate_bsd_header_component(component)
    if len(data) > 256 * 1024:
        raise ValueError('BSD source bundle exceeds exact package bound')
    decoder = lzma.LZMADecompressor(format=lzma.FORMAT_XZ, memlimit=64 * 1024**2)
    expanded = decoder.decompress(data, max_length=128 * 1024 + 1)
    if len(expanded) > 128 * 1024 or not decoder.eof or decoder.unused_data:
        raise ValueError('BSD source expansion exceeds exact package bound')
    members = {}
    with tarfile.open(fileobj=io.BytesIO(expanded), mode='r:') as archive:
        for item in archive:
            name = safe_name(item.name)
            if (not item.isfile() or item.linkname or name in members or len(members) >= 5
                    or item.size > 128 * 1024):
                raise ValueError('Invalid BSD header source bundle member')
            members[name] = archive.extractfile(item).read(item.size + 1)
    if set(members) != {'aports/APKBUILD', *( 'aports/' + name for name in BSD_HEADERS), 'native-source-metadata.json'}:
        raise ValueError('Incomplete BSD header source bundle')
    recipe = {name.removeprefix('aports/'): content for name, content in members.items() if name.startswith('aports/')}
    sums = _bsd_recipe(recipe)
    url = 'https://codeload.github.com/alpinelinux/aports/tar.gz/' + BSD_COMMIT
    expected = {'format': 'gp-compiler-native-source/v1', 'aportsCommit': BSD_COMMIT, 'origin': BSD_ORIGIN,
        'version': BSD_VERSION, 'packageIds': [BSD_ORIGIN + '.' + BSD_VERSION], 'recipeFiles': [
            {'path': name, 'sha256': sha(content), 'bytes': len(content)} for name, content in sorted(recipe.items())],
        'distfiles': [{'filename': name, 'url': url, 'bytes': len(recipe[name]),
            'sha512': digest, 'sha256': sha(recipe[name])} for name, digest in sorted(sums.items())],
        'sourceExecutionPerformed': False}
    if members['native-source-metadata.json'] != encoded(expected):
        raise ValueError('Original BSD header source metadata differs')
    actual = [_notice('aports/' + name, recipe[name]) for name in ('queue.h', 'tree.h')]
    if component['notices'] != actual:
        raise ValueError('BSD header notice is not its actual retained original')


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
        distfiles, notices = [], bsd_header_notices(origin, version, commit, selected, recipe)
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
            notices.extend(source_notices(name, data, origin=origin, version=version, commit=commit))
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

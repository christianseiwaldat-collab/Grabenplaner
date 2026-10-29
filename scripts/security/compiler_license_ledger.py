"""Capture the actual compiler image and retain its dependency source/licenses.

The immutable image, installed opam metadata and native archive/header owners
define the closure. No coverage boolean, license-name guess or source waiver
can turn an incomplete collection into a publishable ledger. Build-container
capture is retained before downloads, so a collection failure needs no rebuild.
"""
import argparse
import base64
import hashlib
import io
import json
import lzma
import os
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
import tarfile
import urllib.request
from urllib.parse import urlsplit
import zipfile

FORMAT = 'gp-semgrep-core-dependency-license-ledger/v3'
CAPTURE = 'gp-semgrep-core-license-capture/v1'
MAX_JSON = 4 * 1024**2
MAX_CAPTURE_JSON = 64 * 1024**2
# Actual linux-headers corresponding source alone exceeds 128 MiB. Retain the
# complete source with finite per-file/aggregate bounds, never drop its owner.
MAX_FILE = 512 * 1024**2
MAX_SOURCE = 2 * 1024**3
HASH = re.compile('[a-f0-9]{64}')
NOTICE = re.compile(r'^(?:licen[cs]e|copying|copyright|notice)(?:[._-].*)?$', re.I)
CURL_SHA = '05fc17ff25b793a437a0906e0484b82172a9f4de02be5ed447e0cab8c3475add'


def notice_candidate(name):
    name = PurePosixPath(name).name
    return not name.endswith('.symlink-target') and NOTICE.fullmatch(name)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def encoded(value):
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')) + '\n').encode()


def unique(data):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError('Duplicate license metadata key')
            result[key] = value
        return result
    return json.loads(data, object_pairs_hook=pairs)


def regular(file, maximum=MAX_FILE):
    file = Path(file).absolute()
    before = file.lstat()
    if (file.resolve() != file or not stat.S_ISREG(before.st_mode)
            or before.st_nlink != 1 or before.st_size > maximum):
        raise ValueError('Unsafe compiler license input')
    with file.open('rb') as stream:
        data = stream.read(maximum + 1)
        opened = os.fstat(stream.fileno())
    after = file.lstat()
    def identity(value):
        return value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns, value.st_nlink
    if len(data) > maximum or identity(before) != identity(opened) or identity(before) != identity(after):
        raise ValueError('Changed compiler license input')
    return data


def relative(name):
    value = PurePosixPath(name)
    if (not isinstance(name, str) or not name or '\\' in name or ':' in name
            or any(ord(c) < 32 or ord(c) == 127 for c in name)
            or value.is_absolute() or value.as_posix() != name or any(p in ('.', '..') for p in value.parts)):
        raise ValueError('Unsafe compiler source path')
    return name


def https(url):
    value = urlsplit(url)
    if (value.scheme != 'https' or not value.hostname or value.username or value.password
            or value.fragment or value.query or any(ord(c) < 32 for c in url)):
        raise ValueError('Source provenance requires credential-free HTTPS')
    return url


def opam_ids(text):
    result = []
    for line in text.splitlines():
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        parts = line.split()
        if len(parts) != 2 or any(not re.fullmatch(r'[A-Za-z0-9_+.-]+', part) for part in parts):
            raise ValueError('Invalid actual installed opam closure')
        result.append(parts[0] + '.' + parts[1])
    if not result or len(result) != len(set(result)):
        raise ValueError('Empty or duplicate actual opam closure')
    return sorted(result)


def field(text, name):
    # Parse only a string or a literal list of strings. Package definitions are
    # retained verbatim too; unsupported metadata is an error, never a guess.
    found = re.search(r'(?m)^\s*' + re.escape(name) + r'\s*:\s*("(?:[^"\\]|\\.)*"|\[(?:[^\]"\\]|"(?:[^"\\]|\\.)*")*\])', text)
    if not found:
        return []
    return [json.loads(value) for value in re.findall(r'"(?:[^"\\]|\\.)*"', found.group(1))]


def opam_blocks(text, name):
    # A bounded lexical scan, not a newline-sensitive brace regex. Braces and
    # fake section headers inside escaped/triple-quoted strings or comments
    # cannot terminate/create a URL block. Inline closing braces are valid.
    if len(text) > MAX_JSON:
        raise ValueError('Opam definition exceeds bound')
    result, depth, quote, body, i = [], 0, None, None, 0
    header = re.compile(r'[ \t]*' + re.escape(name) + r'\s*\{')
    while i < len(text):
        if quote:
            if quote == 'triple' and text.startswith('"""', i):
                quote = None; i += 3; continue
            if quote == 'single' and text[i] == '"':
                quote = None; i += 1; continue
            if text[i] == '\\':
                i += 2; continue
            i += 1; continue
        if text[i] == '#':
            stop = text.find('\n', i); i = len(text) if stop < 0 else stop + 1; continue
        if depth == 0 and (i == 0 or text[i - 1] == '\n'):
            match = header.match(text, i)
            if match:
                body = match.end(); depth = 1; i = body; continue
        if text.startswith('"""', i):
            quote = 'triple'; i += 3; continue
        if text[i] == '"':
            quote = 'single'; i += 1; continue
        if text[i] == '{':
            depth += 1
        elif text[i] == '}':
            if depth <= 0:
                raise ValueError('Unbalanced opam source braces')
            depth -= 1
            if body is not None and depth == 0:
                result.append(text[body:i]); body = None
        i += 1
    if body is not None or quote or depth:
        raise ValueError('Unterminated opam source block/string')
    return result


def source_url(text):
    values = opam_blocks(text, 'url')
    if not values:
        return None, []
    if len(values) != 1:
        raise ValueError('Duplicate opam source URL blocks')
    urls = field(values[0], 'src')
    hashes = field(values[0], 'checksum')
    if len(urls) == 1 and urls[0].startswith('git+https://'):
        repository, separator, commit = urls[0][4:].partition('#')
        if not separator or not re.fullmatch('[a-f0-9]{40}', commit):
            raise ValueError('Git package source requires an exact commit')
        return https(repository.removesuffix('.git') + '/tree/' + commit), []
    if len(urls) != 1 or not hashes:
        raise ValueError('Source metadata lacks exact URL/checksum')
    return https(urls[0]), hashes


def download(url, maximum=MAX_FILE):
    request = urllib.request.Request(https(url), headers={'User-Agent': 'gp-compiler-license-closure'})
    with urllib.request.urlopen(request, timeout=120) as response:
        https(response.url)
        data = response.read(maximum + 1)
    if len(data) > maximum:
        raise ValueError('Compiler source download exceeds bound')
    return data


def checked_download(url, checksums, cache):
    parsed = []
    for item in checksums:
        name, separator, expected = item.partition('=')
        if not separator or name not in ('sha256', 'sha512', 'md5') or not re.fullmatch('[a-f0-9]+', expected):
            raise ValueError('Unsupported source checksum')
        parsed.append((name, expected))
    data = None
    for name, expected in parsed:
        candidates = (cache / name / expected[:2] / expected, cache / name / expected)
        for file in candidates:
            if file.exists():
                data = regular(file)
                break
        if data is not None:
            break
    if data is None:
        if not any(name in ('sha256', 'sha512') for name, _ in parsed):
            raise ValueError('A fetched source requires SHA-256 or SHA-512; legacy MD5 is allowed only for captured image bytes')
        data = download(url)
    if any(hashlib.new(name, data).hexdigest() != expected for name, expected in parsed):
        raise ValueError('Actual opam source checksum differs')
    return data


def notice(path, data):
    if not data.strip() or len(data) > MAX_JSON // 2:
        raise ValueError('Empty or oversized primary license text')
    encoding = 'utf8'
    try:
        text = data.decode('utf8')
    except UnicodeDecodeError:
        encoding, text = 'latin1', data.decode('latin1')
    if not text.strip() or '\x00' in text:
        raise ValueError('Primary license file is not text')
    return {'path': relative(path), 'text': text, 'sha256': digest(text.encode()),
            'sourceBytesSha256': digest(data), 'encoding': encoding}


def notice_path(value):
    if not isinstance(value, str) or len(value) > 2048 or value.count('::') > 1:
        raise ValueError('Unsafe primary notice path')
    for part in value.split('::'):
        relative(part)
    return value


def archive_notices(data):
    result = []
    if zipfile.is_zipfile(io.BytesIO(data)):
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            if len(archive.infolist()) > 100000:
                raise ValueError('Source archive inventory exceeds bound')
            for item in archive.infolist():
                name = relative(item.filename.rstrip('/'))
                if (not item.is_dir() and stat.S_IFMT(item.external_attr >> 16) in (0, stat.S_IFREG)
                        and len(PurePosixPath(name).parts) <= 3 and notice_candidate(name)):
                    if item.file_size > MAX_JSON // 2:
                        raise ValueError('Primary notice exceeds bound')
                    result.append(notice(name, archive.read(item)))
        if not result:
            raise ValueError('Source archive has no primary license/copyright text')
        return result
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:*') as archive:
        for item in archive:
            raw = item.name.rstrip('/')
            if raw in ('.', '') and item.isdir():
                continue
            name = relative(raw.removeprefix('./'))
            # Full archives retain every original nested notice. The ledger
            # displays primary top-level/package notices, not arbitrary README.
            if item.isfile() and len(PurePosixPath(name).parts) <= 3 and notice_candidate(name):
                if item.size > MAX_JSON // 2:
                    raise ValueError('Primary notice exceeds bound')
                result.append(notice(name, archive.extractfile(item).read()))
    if not result:
        raise ValueError('Source archive has no primary license/copyright text')
    return result


def source_archive(files):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode='w', format=tarfile.PAX_FORMAT) as archive:
        for name, data in sorted(files.items()):
            relative(name)
            if len(data) > MAX_FILE:
                raise ValueError('Source member exceeds bound')
            info = tarfile.TarInfo(name); info.size = len(data); info.mode = 0o644
            info.uid = info.gid = info.mtime = 0; info.uname = info.gname = ''
            archive.addfile(info, io.BytesIO(data))
    return lzma.compress(output.getvalue(), preset=0)


def tree_files(root):
    root = root.resolve(); result, total = {}, 0
    for directory, folders, names in os.walk(root, followlinks=False):
        folders[:] = sorted(name for name in folders if name not in ('.git', '_build'))
        for name in folders:
            file = Path(directory) / name
            if file.is_symlink():
                result[relative(file.relative_to(root).as_posix() + '.symlink-target')] = os.readlink(file).encode()
        for name in sorted(names):
            file = Path(directory) / name
            if file.is_symlink():
                # Preserve the link's exact bytes as source evidence without
                # following it outside this captured upstream source tree.
                data = os.readlink(file).encode()
                key = file.relative_to(root).as_posix() + '.symlink-target'
            else:
                data, key = regular(file), file.relative_to(root).as_posix()
            total += len(data)
            if total > MAX_SOURCE:
                raise ValueError('Captured source tree exceeds bound')
            result[relative(key)] = data
    return result


def retain_source(output, prefix, files, url):
    data = source_archive(files)
    if len(data) > MAX_FILE:
        raise ValueError('Dependency source archive exceeds publication bound')
    filename = prefix + '-' + digest(data)[:16] + '.tar.xz'
    relative(filename); target = output / filename
    if target.exists():
        if regular(target) != data:
            raise ValueError('Conflicting dependency source archive')
    else:
        with target.open('xb') as stream:
            stream.write(data)
    return {'filename': filename, 'bytes': len(data), 'sha256': digest(data), 'url': https(url)}


def validate_ledger(value, binary_sha256, native=None):
    if (not isinstance(value, dict) or set(value) != {'format', 'status', 'binarySha256', 'reviewReference', 'closure', 'components'}
            or value['format'] != FORMAT or value['status'] != 'complete' or value['binarySha256'] != binary_sha256
            or value['reviewReference'] != 'reviewed-actual-container-closure-v1'):
        raise ValueError('License closure is incomplete or unbound')
    closure = value['closure']
    if (not isinstance(closure, dict) or set(closure) != {'imageId', 'captureSha256', 'opamInstalled', 'nativePackageIds', 'nativeInputsSha256'}
            or not re.fullmatch('sha256:[a-f0-9]{64}', str(closure['imageId']))
            or any(not HASH.fullmatch(str(closure[key])) for key in ('captureSha256', 'nativeInputsSha256'))):
        raise ValueError('Actual compiler closure is missing')
    for name in ('opamInstalled', 'nativePackageIds'):
        records = closure[name]
        if (not isinstance(records, list) or not records or records != sorted(set(records))
                or any(not isinstance(item, str) or not re.fullmatch('[A-Za-z0-9_+.-]+', item) for item in records)):
            raise ValueError('Invalid actual package identity set')
    if native is not None and (closure['imageId'] != native.get('imageId')
            or closure['opamInstalled'] != opam_ids(native.get('opamPackages', ''))):
        raise ValueError('License closure differs from actual qualified image/opam packages')
    if native is not None and 'nativePackageIds' in native and (
            closure['nativePackageIds'] != native['nativePackageIds']
            or closure['nativeInputsSha256'] != native.get('nativeInputsSha256')):
        raise ValueError('License closure differs from actual static archive/header inputs')
    components = value['components']
    if not isinstance(components, list) or not components or len(components) > 1000:
        raise ValueError('Actual dependency components are missing')
    covered = {'opam': set(), 'apk': set(), 'custom': set(), 'upstream': set()}
    seen = set()
    for component in components:
        if not isinstance(component, dict) or set(component) not in ({'name', 'version', 'packageIds', 'licenseExpression', 'notices', 'correspondingSource'},
                {'name', 'version', 'packageIds', 'licenseExpression', 'notices', 'correspondingSource', 'licenseEvidence'}):
            raise ValueError('Invalid dependency component fields')
        name, version, expression = component['name'], component['version'], component['licenseExpression']
        if (not isinstance(name, str) or '/' not in name or name in seen or len(name) > 240
                or not isinstance(version, str) or not 1 <= len(version) <= 240
                or not isinstance(expression, str) or not expression.strip() or len(expression) > 240
                or expression in ('UNKNOWN', 'NOASSERTION', 'NONE')):
            raise ValueError('Unreviewed or missing actual dependency license')
        seen.add(name); ecosystem = name.split('/', 1)[0]
        ids = component['packageIds']
        if (ecosystem not in covered or not isinstance(ids, list) or not ids or len(set(ids)) != len(ids)
                or any(not isinstance(item, str) or item in covered[ecosystem] for item in ids)):
            raise ValueError('Duplicate or invalid dependency coverage')
        covered[ecosystem].update(ids)
        if 'licenseEvidence' in component:
            from compiler_license_declaration import validate_declaration
            validate_declaration(component, native=native)
        else:
            notices = component['notices']
            if not isinstance(notices, list) or not notices:
                raise ValueError('Missing primary dependency notices')
            paths = set()
            for item in notices:
                if not isinstance(item, dict) or set(item) != {'path', 'text', 'sha256', 'sourceBytesSha256', 'encoding'}:
                    raise ValueError('Incomplete primary notice evidence')
                notice_path(item['path'])
                if item['path'] in paths or not isinstance(item['text'], str) or not item['text'].strip() or '\x00' in item['text']:
                    raise ValueError('Blank or duplicate primary notice')
                paths.add(item['path'])
                try:
                    original = item['text'].encode({'utf8': 'utf8', 'latin1': 'latin1'}[item['encoding']])
                except (KeyError, UnicodeError):
                    raise ValueError('Invalid primary notice encoding') from None
                if digest(item['text'].encode()) != item['sha256'] or digest(original) != item['sourceBytesSha256']:
                    raise ValueError('Primary notice bytes differ')
        reference = component['correspondingSource']
        # Conservative complete-source distribution for every component. No
        # SPDX-derived exception or None-source waiver is implemented here.
        if (not isinstance(reference, dict) or set(reference) != {'filename', 'sha256', 'bytes', 'url'}
                or not isinstance(reference['filename'], str) or '/' in relative(reference['filename'])
                or not HASH.fullmatch(str(reference['sha256'])) or type(reference['bytes']) is not int
                or not 0 < reference['bytes'] <= MAX_FILE):
            raise ValueError('Dependency corresponding source is required')
        https(reference['url'])
    if (covered['opam'] != set(closure['opamInstalled']) or covered['apk'] != set(closure['nativePackageIds'])
            or covered['custom'] != {'curl.8.5.0'} or covered['upstream'] != {'semgrep-corresponding-source'}):
        raise ValueError('Actual transitive compiler dependency closure is incomplete')
    if len(encoded(value)) > MAX_JSON:
        raise ValueError('Primary license notices exceed consumer JSON bound')
    return value


def source_notice_hashes(data, depth=0):
    if depth > 1:
        raise ValueError('Dependency source nesting exceeds reviewed bound')
    hashes, count, total = set(), 0, 0
    if zipfile.is_zipfile(io.BytesIO(data)):
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            if len(archive.infolist()) > 250000 or sum(item.file_size for item in archive.infolist()) > MAX_SOURCE:
                raise ValueError('Dependency source inventory exceeds bound')
            for item in archive.infolist():
                name = relative(item.filename.rstrip('/'))
                if (not item.is_dir() and stat.S_IFMT(item.external_attr >> 16) in (0, stat.S_IFREG)
                        and notice_candidate(name)):
                    if item.file_size > MAX_FILE:
                        raise ValueError('Dependency source member exceeds bound')
                    hashes.add(digest(archive.read(item)))
        return hashes
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:*') as archive:
        for item in archive:
            raw = item.name.rstrip('/')
            if raw in ('.', '') and item.isdir():
                continue
            name = relative(raw.removeprefix('./')); count += 1
            if count > 250000 or item.size > MAX_FILE:
                raise ValueError('Dependency source inventory exceeds bound')
            if not item.isfile():
                continue
            total += item.size
            if total > MAX_SOURCE:
                raise ValueError('Dependency source expansion exceeds bound')
            basename = PurePosixPath(name).name
            if notice_candidate(basename) or basename == 'OPAM-REPOSITORY-LICENSE':
                hashes.add(digest(archive.extractfile(item).read()))
            elif depth == 0 and (name == 'source/original-archive' or name == 'curl-8.5.0.tar.gz'
                    or name.startswith('distfiles/') and basename.endswith(('.tar.gz', '.tar.xz', '.tar.bz2', '.tbz', '.tgz', '.zip'))):
                hashes.update(source_notice_hashes(archive.extractfile(item).read(), depth + 1))
    return hashes


def declaration_source_files(data):
    # The exact config package is small; no filesystem extraction or nested
    # archive execution is required to verify its complete retained payload.
    if len(data) > 16 * 1024**2:
        raise ValueError('Config source package exceeds reviewed bound')
    files, total = {}, 0
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:xz') as archive:
        for item in archive:
            name = relative(item.name)
            if not item.isfile() or name in files or len(files) >= 10000:
                raise ValueError('Invalid config source member')
            total += item.size
            if total > 16 * 1024**2:
                raise ValueError('Config source expansion exceeds reviewed bound')
            files[name] = archive.extractfile(item).read()
    return files


def validate_sources(value, read_source):
    checked = {}
    for component in value['components']:
        reference = component['correspondingSource']; name = reference['filename']
        if name not in checked:
            data = read_source(name)
            if len(data) != reference['bytes'] or digest(data) != reference['sha256']:
                raise ValueError('Dependency corresponding-source bytes differ')
            checked[name] = (reference, source_notice_hashes(data))
        previous, actual_notices = checked[name]
        if previous != reference:
            raise ValueError('Shared corresponding source has conflicting identity')
        if 'licenseEvidence' in component:
            from compiler_license_declaration import validate_declaration
            validate_declaration(component, declaration_source_files(read_source(name)))
        elif any(item['sourceBytesSha256'] not in actual_notices for item in component['notices']):
            raise ValueError('Primary dependency notice is not present in retained source')
    return checked


def embedded_dependency_sources(data, value):
    expected = {component['correspondingSource']['filename'] for component in value['components']}
    sources, total, seen = {}, 0, set()
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:xz') as archive:
        for item in archive:
            name = relative(item.name.rstrip('/'))
            if name in seen:
                raise ValueError('Duplicate corresponding-source archive member')
            seen.add(name)
            if not name.startswith('dependency-sources/'):
                continue
            filename = name.removeprefix('dependency-sources/')
            if filename not in expected or not item.isfile() or item.size > MAX_FILE:
                raise ValueError('Unexpected dependency source member')
            total += item.size
            if total > MAX_SOURCE:
                raise ValueError('Dependency sources exceed bound')
            sources[filename] = archive.extractfile(item).read()
    if set(sources) != expected:
        raise ValueError('Retained transitive dependency source set is incomplete')
    validate_sources(value, sources.__getitem__)
    return sources


# This script executes only in the already-built upstream-only image. It does
# not update packages, load GP files, contact a server or execute fetched code.
CAPTURE_SCRIPT = r'''
import base64, hashlib, json, os, pathlib, subprocess
prefix = subprocess.check_output(['opam','var','prefix','--safe'], stderr=subprocess.DEVNULL).decode().strip()
assert prefix == '/root/.opam/5.4.0'
listing = subprocess.check_output(['opam','list','--installed','--columns=name,version','--color=never','--safe'], stderr=subprocess.DEVNULL).decode()
pins = subprocess.check_output(['opam','pin','list','--normalise','--safe'], stderr=subprocess.DEVNULL).decode()
packages=[]
for line in listing.splitlines():
    if not line.strip() or line.lstrip().startswith('#'): continue
    name,version=line.split(); identity=name+'.'+version
    metadata=pathlib.Path(prefix+'/.opam-switch/packages/'+identity+'/opam')
    install=pathlib.Path(prefix+'/.opam-switch/install/'+name+'.install')
    changes=pathlib.Path(prefix+'/.opam-switch/install/'+name+'.changes')
    sources=pathlib.Path(prefix+'/.opam-switch/sources')
    pin = next((line.split()[2] for line in pins.splitlines() if len(line.split()) >= 3 and line.split()[0] == identity), None)
    # opam omits the version for pinned source directories. Prefer that exact
    # current package name; regular releases remain bound to their installed id.
    candidates=([name, identity, name+'.dev'] if pin else [identity])
    source_directory=next((item for item in dict.fromkeys(candidates) if (sources/item).is_dir()), None)
    packages.append({'name':name,'version':version,'id':identity,'opam':base64.b64encode(metadata.read_bytes()).decode(),'sourcePin':pin,
        'install':base64.b64encode(install.read_bytes() if install.exists() else b'').decode(),
        'changes':base64.b64encode(changes.read_bytes() if changes.exists() else b'').decode(),'sourceDirectory':source_directory})
    if identity == 'ocaml-config.3':
        installed=pathlib.Path(prefix+'/share/ocaml-config/gen_ocaml_config.ml')
        assert installed.is_file() and not installed.is_symlink()
        data=installed.read_bytes(); assert 0 < len(data) <= 65536
        packages[-1]['installedSource']={'imagePath':str(installed),'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest(),'content':base64.b64encode(data).decode()}
database=pathlib.Path('/lib/apk/db/installed').read_text()
apks=[]; owners={}
for paragraph in database.strip().split('\n\n'):
    fields={}; directory=''
    for line in paragraph.splitlines():
        key,_,value=line.partition(':')
        if key in ['P','V','o','c','L','U']: fields[key]=value
        if key=='F': directory=value
        if key=='R': owners[directory+'/'+value]=fields.get('P','')+'.'+fields.get('V','')
    if 'P' in fields: apks.append({'name':fields['P'],'version':fields['V'],'id':fields['P']+'.'+fields['V'],
        'origin':fields.get('o',fields['P']),'commit':fields.get('c',''),'licenseExpression':fields.get('L',''),'url':fields.get('U','')})
native=[]
for root in ['/usr/lib','/usr/local/lib','/usr/include']:
    for directory,folders,files in os.walk(root,followlinks=False):
        for name in files:
            if not (name.endswith('.a') or root=='/usr/include' and name.endswith(('.h','.hpp'))): continue
            file=pathlib.Path(directory)/name
            if file.is_symlink(): continue
            data=file.read_bytes(); owner=owners.get(str(file).lstrip('/'))
            if str(file)=='/usr/local/lib/libcurl.a': owner='custom-curl.8.5.0'
            assert owner, 'Unowned native input: '+str(file)
            native.append({'path':str(file),'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest(),'owner':owner})
print(json.dumps({'opamPackages':packages,'opamListing':listing,'apkPackages':apks,'nativeInputs':sorted(native,key=lambda v:v['path']),
    'alpineRelease':pathlib.Path('/etc/alpine-release').read_text().strip()}))
'''


class CaptureCommandError(ValueError):
    """Details stay in encrypted qualification evidence, never console output."""
    def __init__(self, arguments, returncode, stdout=b'', stderr=b''):
        super().__init__('Compiler license capture command failed (' + str(returncode) + ')')
        self.evidence = {'format': 'gp-compiler-capture-command-failure/v1',
            'commandSha256': digest(encoded([str(item) for item in arguments])),
            'operation': str(arguments[0]) + '/' + (str(arguments[1]) if len(arguments) > 1 else ''),
            'returncode': returncode}
        for key, data in (('stdout', stdout or b''), ('stderr', stderr or b'')):
            if isinstance(data, str): data = data.encode('utf8', errors='replace')
            self.evidence[key] = {'bytes': len(data), 'sha256': digest(data),
                'tailBase64': base64.b64encode(data[-16384:]).decode(), 'truncated': len(data) > 16384}


def command(arguments, timeout=300):
    try:
        result = subprocess.run(arguments, capture_output=True, check=False, timeout=timeout,
            env={key: value for key, value in os.environ.items() if key in ('PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'XDG_RUNTIME_DIR')})
    except subprocess.TimeoutExpired as error:
        raise CaptureCommandError(arguments, 'timeout', error.stdout, error.stderr) from None
    if result.returncode:
        raise CaptureCommandError(arguments, result.returncode, result.stdout, result.stderr)
    return result.stdout


def actual_license_closure(native):
    """Independently reread the qualified image at publication, not the ledger."""
    image = native.get('imageId', '')
    if not re.fullmatch('sha256:[a-f0-9]{64}', image):
        raise ValueError('Missing exact qualified license image')
    captured = unique(command(['docker', 'run', '--rm', '--network', 'none', '--read-only', '--entrypoint', 'python3',
        image, '-I', '-c', CAPTURE_SCRIPT]))
    if opam_ids(captured['opamListing']) != opam_ids(native.get('opamPackages', '')):
        raise ValueError('Fresh actual opam closure differs from qualified compiler')
    from compiler_license_declaration import actual_source_evidence
    sources = actual_source_evidence(captured)
    return {'nativePackageIds': sorted({item['owner'] for item in captured['nativeInputs']
            if item['owner'] != 'custom-curl.8.5.0'}), 'nativeInputsSha256': digest(encoded(captured['nativeInputs'])),
        **({'opamSourceEvidence': sources} if sources else {})}


def capture_image(image, binary_sha, qualification, output):
    capture_root = output / 'capture'
    capture_root.mkdir(mode=0o700)
    report = {'format': 'gp-semgrep-core-compiler-license-review/v1', 'imageId': image, 'binarySha256': binary_sha,
        'captureSha256': None, 'phase': 'raw-source-export-started', 'publicationReady': False}
    # Persist BEFORE the first external command. A failed observation must not
    # erase its command error or require another expensive build to read source.
    (qualification / 'sourcebuild-compiler-license-review.json').write_bytes(encoded(report))
    (capture_root / 'capture.json').write_bytes(encoded({'format': 'gp-semgrep-core-source-capture-observation/v1',
        'imageId': image, 'binarySha256': binary_sha, 'captureComplete': False}))
    container = None
    try:
        container = command(['docker', 'create', '--network', 'none', '--read-only', '--entrypoint', '/bin/true', image]).decode().strip()
        if not re.fullmatch('[a-f0-9]{64}', container):
            container = None
            raise ValueError('Invalid owned compiler capture container')
        for source, target in (
            ('/root/.opam/download-cache', 'opam-download-cache'),
            ('/root/.opam/5.4.0/.opam-switch/sources', 'opam-sources'),
            ('/root/.opam/5.4.0/.opam-switch/packages', 'opam-package-metadata'),
            ('/root/.opam/5.4.0/.opam-switch/install', 'opam-install-evidence'),
            ('/root/.opam/5.4.0/.opam-switch/switch-state', 'opam-switch-state'),
            ('/lib/apk/db/installed', 'apk-installed-database'),
            ('/tmp/curl-8.5.0.tar.gz', 'custom-curl.tar.gz')):
            command(['docker', 'cp', container + ':' + source, str(capture_root / target)], timeout=600)
        report['phase'] = 'raw-sources-exported'
        (qualification / 'sourcebuild-compiler-license-review.json').write_bytes(encoded(report))
        value = unique(command(['docker', 'run', '--rm', '--network', 'none', '--read-only', '--entrypoint', 'python3', image, '-I', '-c', CAPTURE_SCRIPT]))
        value.update(format='gp-semgrep-core-actual-license-inputs/v1', imageId=image, binarySha256=binary_sha,
            captureComplete=True)
        (capture_root / 'capture.json').write_bytes(encoded(value))
        report.update(opamInstalled=opam_ids(value['opamListing']),
            nativePackageIds=sorted({item['owner'] for item in value['nativeInputs'] if item['owner'] != 'custom-curl.8.5.0'}),
            nativeInputsSha256=digest(encoded(value['nativeInputs'])), phase='inventory-captured', actualInputs=value)
        if len(encoded(report)) > MAX_CAPTURE_JSON:
            raise ValueError('Actual compiler metadata exceeds private receipt bound')
    except Exception as error:
        report.update(phase='capture-observation-failed', errorType=type(error).__name__)
        if isinstance(error, CaptureCommandError):
            (qualification / 'sourcebuild-compiler-capture-command-failure.json').write_bytes(encoded(error.evidence))
        raise
    finally:
        try:
            if container is not None: command(['docker', 'rm', container])
        finally:
            # The manifest says exactly which upstream bytes were recovered.
            # A partial capture is diagnostic evidence; it never authorizes tool
            # publication and its capture.json cannot be read as a full closure.
            files = tree_files(capture_root)
            archive = source_archive(files)
            (output / 'capture.tar.xz').write_bytes(archive)
            receipt = {'format': CAPTURE, 'archive': {'bytes': len(archive), 'sha256': digest(archive)},
                'imageId': image, 'binarySha256': binary_sha, 'upstreamOnly': True, 'compilerRebuilt': False,
                'memberInventory': [{'path': name, 'bytes': len(data), 'sha256': digest(data)} for name, data in sorted(files.items())]}
            (output / 'capture-receipt.json').write_bytes(encoded(receipt))
            report.update(captureSha256=digest(archive))
            if report['phase'] == 'inventory-captured': report['phase'] = 'captured'
            (qualification / 'sourcebuild-compiler-license-review.json').write_bytes(encoded(report))
    return value, capture_root, report


def verify_capture(output):
    receipt = unique(regular(output / 'capture-receipt.json', MAX_CAPTURE_JSON))
    if (set(receipt) != {'format', 'archive', 'imageId', 'binarySha256', 'upstreamOnly', 'compilerRebuilt', 'memberInventory'}
            or receipt['format'] != CAPTURE or receipt['upstreamOnly'] is not True or receipt['compilerRebuilt'] is not False):
        raise ValueError('Invalid upstream-only capture receipt')
    data = regular(output / 'capture.tar.xz', MAX_SOURCE)
    if receipt['archive'] != {'bytes': len(data), 'sha256': digest(data)}:
        raise ValueError('Capture archive bytes differ')
    actual = []
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:xz') as archive:
        for item in archive:
            name = relative(item.name)
            if (not item.isfile() or not (name in ('capture.json', 'custom-curl.tar.gz', 'opam-switch-state', 'apk-installed-database')
                    or name.startswith(('opam-download-cache/', 'opam-sources/', 'opam-package-metadata/', 'opam-install-evidence/')))):
                raise ValueError('Unexpected compiler capture member')
            if item.size > MAX_FILE:
                raise ValueError('Oversized compiler capture member')
            content = archive.extractfile(item).read()
            actual.append({'path': name, 'bytes': len(content), 'sha256': digest(content)})
    if actual != receipt['memberInventory'] or len({item['path'] for item in actual}) != len(actual):
        raise ValueError('Capture source inventory differs')
    return receipt


def collect_opam(capture, root, output):
    repo_url = 'https://raw.githubusercontent.com/ocaml/opam-repository/'
    from build_semgrep_source import OPAM_REPOSITORY, COMMIT
    repository_license = download(repo_url + OPAM_REPOSITORY + '/COPYING')
    components = []
    for package in capture['opamPackages']:
        if (not re.fullmatch('[A-Za-z0-9_+.-]+', package['name']) or not re.fullmatch('[A-Za-z0-9_+.-]+', package['version'])
                or package['id'] != package['name'] + '.' + package['version']
                or package['sourceDirectory'] is not None and ('/' in relative(package['sourceDirectory'])
                    or not (package['sourceDirectory'] == package['name'] and package.get('sourcePin')
                        or package['sourceDirectory'].startswith(package['name'] + '.')))):
            raise ValueError('Invalid captured opam package/source identity')
        metadata = base64.b64decode(package['opam'], validate=True)
        install = base64.b64decode(package['install'], validate=True)
        changes = base64.b64decode(package['changes'], validate=True)
        definition = metadata.decode('utf8')
        licenses = field(definition, 'license')
        files = {'metadata/opam': metadata, 'metadata/install': install, 'metadata/changes': changes}
        tree = root / 'opam-sources' / package['sourceDirectory'] if package['sourceDirectory'] else None
        if package['id'] == 'ocaml-config.3':
            from compiler_license_declaration import ORIGINALS, DECLARATION_URL, build_evidence, validate_declaration
            original = {name: checked_download(url, ['sha256=' + sha], root / 'opam-download-cache')
                for name, url, _size, sha in ORIGINALS}
            evidence, config_files = build_evidence(package, metadata, original, tree_files(tree) if tree and tree.is_dir() else {})
            component = {'name': 'opam/ocaml-config', 'version': '3', 'packageIds': ['ocaml-config.3'],
                'licenseExpression': 'ISC', 'notices': [], 'licenseEvidence': evidence,
                'correspondingSource': retain_source(output, 'opam-ocaml-config.3', config_files, DECLARATION_URL)}
            validate_declaration(component, config_files)
            components.append(component)
            continue
        # A retained actual pin tree is the source authority for git/file pins;
        # it need not pretend to be an independently downloadable release URL.
        url, checksums = (None, []) if tree and tree.is_dir() else source_url(definition)
        if tree and tree.is_dir():
            current = tree_files(tree)
            files.update({'source/' + name: data for name, data in current.items()})
            primary = [notice('source/' + name, data) for name, data in current.items()
                if len(PurePosixPath(name).parts) <= 2 and notice_candidate(name)]
            dev = field(definition, 'dev-repo')
            url = url or (dev[0].removeprefix('git+') if len(dev) == 1 else None)
            if url and '#' in url:
                url = url.replace('.git#', '/tree/')
            if not url:
                url = 'https://opam.ocaml.org/packages/' + package['name'] + '/' + package['id'] + '/'
            pin = package.get('sourcePin')
            if pin and pin.startswith('git+https://'):
                repository, separator, commit = pin[4:].partition('#')
                if not separator or not re.fullmatch('[a-f0-9]{40}', commit):
                    raise ValueError('Captured pinned opam source lacks exact commit')
                url = https(repository.removesuffix('.git') + '/tree/' + commit)
            elif pin == 'file:///src/semgrep/libs/ocaml-tree-sitter-semgrep/core':
                url = 'https://github.com/semgrep/semgrep/tree/' + COMMIT + '/libs/ocaml-tree-sitter-semgrep/core'
        elif url:
            data = checked_download(url, checksums, root / 'opam-download-cache')
            files['source/original-archive'] = data
            primary = archive_notices(data)
        else:
            # Virtual/configuration packages have no source payload. Retain the
            # exact installed definition/manifest under the pinned repository's
            # actual license. A nonempty install manifest cannot take this path.
            if re.search(rb'"[^"\n]+"', install) or not (package['name'].startswith(('base-', 'conf-', 'host-'))
                    or package['name'] in ('ocaml', 'ocaml-compiler', 'ocaml-config', 'ocaml-option-flambda', 'seq', 'ocurl')):
                raise ValueError('Installed opam package has no retained corresponding source: ' + package['id'])
            files['metadata/OPAM-REPOSITORY-LICENSE'] = repository_license
            primary = [notice('metadata/OPAM-REPOSITORY-LICENSE', repository_license)]
            licenses = ['CC0-1.0']
            url = repo_url + OPAM_REPOSITORY + '/packages/' + package['name'] + '/' + package['id'] + '/opam'
        if not primary or not licenses or any(not value.strip() for value in licenses):
            raise ValueError('Actual primary opam license remains missing: ' + package['id'])
        reference = retain_source(output, 'opam-' + package['id'], files, url)
        components.append({'name': 'opam/' + package['name'], 'version': package['version'], 'packageIds': [package['id']],
            'licenseExpression': licenses[0] if len(licenses) == 1 else 'LicenseRef-Opam-Declared-Multiple',
            'notices': primary, 'correspondingSource': reference})
    return components


def collect_curl(root, output):
    data = regular(root / 'custom-curl.tar.gz')
    if digest(data) != CURL_SHA:
        raise ValueError('Actual custom curl source differs from pinned recipe')
    url = 'https://curl.se/download/curl-8.5.0.tar.gz'
    return {'name': 'custom/curl', 'version': '8.5.0', 'packageIds': ['curl.8.5.0'], 'licenseExpression': 'curl',
        'notices': archive_notices(data), 'correspondingSource': retain_source(output, 'custom-curl-8.5.0', {'curl-8.5.0.tar.gz': data}, url)}


def collect_upstream(source, qualification, output):
    from build_semgrep_source import COMMIT, UPSTREAM
    inventory = unique(regular(qualification / 'sourcebuild-source-inventory.json', MAX_JSON * 8))
    files, notices = {}, []
    for item in inventory:
        name = relative(item['path']); file = source / name
        data = os.readlink(file).encode() if item['kind'] == 'symlink-text' else regular(file)
        if len(data) != item['bytes'] or digest(data) != item['sha256']:
            raise ValueError('Corresponding upstream source changed')
        files[name + ('.symlink-target' if item['kind'] == 'symlink-text' else '')] = data
        if item['kind'] == 'regular' and (notice_candidate(name) or name == 'COPYRIGHT'):
            notices.append(notice(name, data))
    return {'name': 'upstream/semgrep-corresponding-source', 'version': COMMIT,
        'packageIds': ['semgrep-corresponding-source'], 'licenseExpression': 'LicenseRef-Upstream-Per-File',
        'notices': notices, 'correspondingSource': retain_source(output, 'semgrep-upstream', files,
            UPSTREAM.removesuffix('.git') + '/tree/' + COMMIT)}


def produce(image_file, binary, source, qualification, output):
    from build_semgrep_source import ALPINE
    from publish_semgrep_core_tool import validate_qualification
    from compiler_license_native import collect_native
    if output.exists() or output.is_symlink() or output.absolute().parent.resolve() != output.absolute().parent:
        raise ValueError('License output requires a fresh canonical directory')
    image = regular(image_file, 1024).decode().strip()
    if not re.fullmatch('sha256:[a-f0-9]{64}', image):
        raise ValueError('Invalid immutable compiler image')
    core = regular(binary, 256 * 1024**2)
    _provenance, native = validate_qualification(qualification, core)
    if native['imageId'] != image or native['baseImage'] != ALPINE:
        raise ValueError('License capture image differs from qualified core')
    output.mkdir(mode=0o700)
    try:
        capture, root, report = capture_image(image, digest(core), qualification, output)
    except Exception as error:
        # This file is sealed with all private qualification evidence. Never
        # print source paths or raw command diagnostics in the public receipt.
        import traceback
        failure = {'format': 'gp-compiler-capture-private-failure/v1', 'imageId': image,
            'binarySha256': digest(core), 'errorType': type(error).__name__,
            'tracebackTail': traceback.format_exc()[-16384:], 'publicationReady': False}
        (qualification / 'sourcebuild-compiler-capture-failure.json').write_bytes(encoded(failure))
        raise
    from compiler_license_declaration import actual_source_evidence
    actual_sources = actual_source_evidence(capture)
    if actual_sources:
        native = {**native, 'opamSourceEvidence': actual_sources}
    verify_capture(output)
    if opam_ids(capture['opamListing']) != opam_ids(native['opamPackages']):
        raise ValueError('Actual image opam packages differ from qualified image')
    sources = output / 'dependency-sources'; sources.mkdir(mode=0o700)
    try:
        components = collect_opam(capture, root, sources)
        components += collect_native(capture, root, sources)
        components += [collect_curl(root, sources), collect_upstream(source, qualification, sources)]
        value = {'format': FORMAT, 'status': 'complete', 'binarySha256': digest(core),
            'reviewReference': 'reviewed-actual-container-closure-v1', 'closure': {
                'imageId': image, 'captureSha256': report['captureSha256'], 'opamInstalled': report['opamInstalled'],
                'nativePackageIds': report['nativePackageIds'], 'nativeInputsSha256': report['nativeInputsSha256']},
            'components': sorted(components, key=lambda item: item['name'])}
        validate_ledger(value, digest(core), native)
        (output / 'ledger.json').write_bytes(encoded(value))
        report.update(phase='source-and-notices-collected', ledgerSha256=digest(encoded(value)), componentCount=len(components))
    except Exception:
        report['phase'] = 'source-or-license-collection-failed'
        raise
    finally:
        (qualification / 'sourcebuild-compiler-license-review.json').write_bytes(encoded(report))
    return {'ledgerSha256': digest(encoded(value)), 'componentCount': len(components), 'compilerRebuilt': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--verify-capture', type=Path)
    for argument in ('image-id-file', 'binary', 'source', 'qualification', 'output'):
        parser.add_argument('--' + argument, type=Path)
    args = parser.parse_args()
    try:
        if args.verify_capture:
            result = verify_capture(args.verify_capture)
            result = {key: result[key] for key in ('format', 'archive', 'imageId', 'binarySha256', 'upstreamOnly', 'compilerRebuilt')}
        elif all(getattr(args, name) is not None for name in ('image_id_file', 'binary', 'source', 'qualification', 'output')):
            result = produce(args.image_id_file, args.binary, args.source, args.qualification, args.output)
        else:
            raise ValueError('License collector requires all exact build paths')
        print(json.dumps(result, sort_keys=True))
    except Exception as error:
        print(json.dumps({'publicationReady': False, 'compilerRebuilt': False,
            'error': str(error) if isinstance(error, ValueError) else 'Compiler license collection failed'}))
        raise SystemExit(2) from None

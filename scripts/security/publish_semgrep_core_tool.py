"""Prepare a nonsensitive scanner tool artifact; never publish scan evidence.

This module is deliberately separate from the GP evidence sealer.  It reads
specific qualification receipts, an exact upstream checkout and a separately
reviewed dependency-license ledger.  It never recursively archives the private
qualification directory and never uploads anything or changes a security gate.
"""
import argparse
import hashlib
import io
import json
import lzma
import os
from pathlib import Path, PurePosixPath
import stat
import subprocess
import tarfile
from urllib.parse import urlsplit

from build_semgrep_source import (
    ALPINE, COMMIT, COMPILER, DOCKERFILE, LIMITS, LIMITS_AFTER, LIMITS_BEFORE,
    OPAM_REPOSITORY, SUBMODULE, TAG, TAG_OBJECT, UPSTREAM, VERSION,
    pinned_recipe,
)
from semgrep_core_tool import ARCHIVE, check_elf, unique_json

FORMAT = 'gp-semgrep-core-tool/v1'
LEDGER_FORMAT = 'gp-semgrep-core-dependency-license-ledger/v1'
FILES = (
    'bin/semgrep-core', 'upstream/LICENSE', 'upstream/source.patch',
    'upstream/provenance.json', 'upstream/toolchain-sbom.cdx.json',
    'upstream/corresponding-source.tar.xz',
    'upstream/dependency-license-notices.json',
)
CASES = {
    'control-require', 'control-sql', 'control-loop', 'control-async',
    'server-common', 'server-express', 'server-script_tag',
    'server-express_property', 'server-express_response', 'small-common',
}
MAX_CORE = 256 * 1024**2
MAX_INPUT = 64 * 1024**2
MAX_SOURCE_FILE = 128 * 1024**2
MAX_SOURCE_TOTAL = 768 * 1024**2


def sha(data):
    return hashlib.sha256(data).hexdigest()


def encoded(value):
    return (json.dumps(value, ensure_ascii=False, sort_keys=True,
                       separators=(',', ':')) + '\n').encode('utf8')


def exact_keys(value, keys):
    if not isinstance(value, dict) or set(value) != set(keys):
        raise ValueError('Unexpected metadata fields')


def regular(file, maximum=MAX_INPUT):
    file = Path(file)
    info = file.lstat()
    if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1
            or file.resolve() != file.absolute() or info.st_size > maximum):
        raise ValueError('Unsafe or oversized input file')
    return file.read_bytes()


def read_json(file):
    return unique_json(regular(file))


def safe_relative(value):
    if (not isinstance(value, str) or not value or '\\' in value
            or any(ord(c) < 32 or ord(c) == 127 for c in value)):
        raise ValueError('Unsafe source member')
    path = PurePosixPath(value)
    if path.is_absolute() or path.as_posix() != value or any(p in ('.', '..') for p in path.parts):
        raise ValueError('Unsafe source member')
    return value


def _git(source, *arguments):
    environment = {'PATH': os.environ.get('PATH', ''), 'LANG': 'C.UTF-8',
                   'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': os.devnull,
                   'GIT_TERMINAL_PROMPT': '0'}
    result = subprocess.run(
        ['git', '--no-replace-objects', '-c', 'core.fsmonitor=false', '-c', 'core.filemode=true',
         '-c', 'core.hooksPath=' + os.devnull, '-c', 'color.ui=false',
         '-C', str(source), *arguments], env=environment, check=False,
        capture_output=True, timeout=120,
    )
    if result.returncode:
        raise ValueError('Pinned upstream Git verification failed')
    return result.stdout


def validate_qualification(directory, core):
    gate = read_json(directory / 'gate-result.json')
    native = read_json(directory / 'sourcebuild-native-provenance.json')
    source = read_json(directory / 'sourcebuild-source-provenance.json')
    if (gate.get('gate') != 'sast-diagnostic' or gate.get('diagnosticOnly') is not True
            or gate.get('securityGatePassed') is not False
            or gate.get('complete') is not False or gate.get('passed') is not False
            or gate.get('diagnosticExecutionComplete') is not True
            or gate.get('controlsPassed') is not True or gate.get('scannerVersion') != VERSION
            or gate.get('sourceModified') is not True or gate.get('officialReleaseBinary') is not False):
        raise ValueError('Actual complete source qualification is required')
    cases = gate.get('cases')
    if (not isinstance(cases, list) or len(cases) != len(CASES)
            or {case.get('name') for case in cases} != CASES):
        raise ValueError('The ten original qualification cases are required')
    for case in cases:
        findings = case.get('findingCount')
        if (case.get('executionEvidenceValid') is not True
                or case.get('analysisCompleteForCase') is not True
                or case.get('fixpointFieldPresent') is not True
                or type(case.get('fixpointTimeoutCount')) is not int or case['fixpointTimeoutCount'] != 0
                or type(case.get('scannedFiles')) is not int
                or case['scannedFiles'] != (2 if case['name'].startswith('control-') else 1)
                or type(findings) is not int or findings < 0
                or type(case.get('exitCode')) is not int or case['exitCode'] not in (0, 1)
                or (case.get('exitCode') == 1) != bool(findings)
                or case['name'].startswith('control-') and findings == 0
                or case['name'].startswith('control-') and case.get('controlPassed') is not True):
            raise ValueError('Incomplete qualification case')
    if (sha(core) != gate.get('nativeCoreSha256') or sha(core) != native.get('binarySha256')
            or len(core) != native.get('binaryBytes')
            or native.get('sourceModified') is not True or native.get('officialReleaseBinary') is not False
            or native.get('baseImage') != ALPINE or VERSION not in native.get('versionOutput', '')
            or COMPILER not in native.get('compilerOutput', '')):
        raise ValueError('Core differs from the actually qualified binary')
    image = native.get('imageId')
    if (not isinstance(image, str) or not image.startswith('sha256:') or len(image) != 71
            or any(c not in '0123456789abcdef' for c in image[7:])):
        raise ValueError('Invalid qualified build image identity')
    for key in ('versionOutput', 'compilerOutput'):
        if (not isinstance(native.get(key), str) or not 1 <= len(native[key]) <= 512
                or any(ord(c) < 32 or ord(c) == 127 for c in native[key])):
            raise ValueError('Invalid native tool version metadata')
    expected = {
        'repository': UPSTREAM, 'tag': TAG, 'tagObject': TAG_OBJECT, 'commit': COMMIT,
        'limitsBeforeSha256': LIMITS_BEFORE, 'limitsAfterSha256': LIMITS_AFTER,
        'changedSourcePaths': [LIMITS], 'variableSetGraphLimitsUnchanged': True,
        'upstreamDockerfileSha256': DOCKERFILE, 'officialTarget': 'semgrep-core-container',
        'baseImage': ALPINE, 'compilerSourceCommit': COMPILER,
        'opamRepositoryCommit': OPAM_REPOSITORY,
    }
    if any(source.get(key) != value for key, value in expected.items()):
        raise ValueError('Source-build provenance exceeds the reviewed change')
    check_elf(core)
    return source, native


def source_members(source, qualification, provenance):
    if _git(source, 'rev-parse', 'HEAD').decode().strip() != COMMIT:
        raise ValueError('Corresponding source commit differs')
    if _git(source, 'remote', 'get-url', 'origin').decode().strip() != UPSTREAM:
        raise ValueError('Unexpected corresponding source repository')
    modules = _git(source, 'submodule', 'status', '--recursive').decode().splitlines()
    if len(modules) != 1 or not modules[0].startswith(' ' + SUBMODULE[1] + ' ' + SUBMODULE[0] + ' '):
        raise ValueError('Corresponding submodule closure differs')
    changes = _git(source, 'diff', '--name-only').decode().splitlines()
    staged = _git(source, 'diff', '--cached', '--name-only').decode().splitlines()
    if changes != [LIMITS] or staged:
        raise ValueError('Corresponding source has an unreviewed delta')
    # Only tracked upstream files enter the archive. Adjacent/ignored GP files,
    # even if present, are never discovered by a filesystem-recursive archive.
    names = _git(source, 'ls-files', '-z', '--recurse-submodules').decode().split('\0')
    inventory = read_json(qualification / 'sourcebuild-source-inventory.json')
    if not isinstance(inventory, list):
        raise ValueError('Missing upstream source inventory')
    for item in inventory:
        exact_keys(item, ('path', 'kind', 'bytes', 'sha256'))
        safe_relative(item['path'])
        if type(item['bytes']) is not int or item['bytes'] < 0:
            raise ValueError('Invalid upstream inventory byte count')
    expected = {item['path']: item for item in inventory}
    if len(expected) != len(inventory):
        raise ValueError('Duplicate upstream source inventory')
    names = [safe_relative(name) for name in names if name]
    if len(names) != len(set(names)) or set(names) != set(expected):
        raise ValueError('Upstream tracked source set differs')
    members, total = {}, 0
    for name in sorted(names):
        file = source / name
        record = expected[name]
        if file.is_symlink():
            data = os.readlink(file).encode('utf8')
            if (record.get('kind') != 'symlink-text'
                    or not file.resolve().is_relative_to(source.resolve())):
                raise ValueError('Unsafe upstream symlink')
            kind = 'symlink'
        else:
            data = regular(file, MAX_SOURCE_FILE)
            if record.get('kind') != 'regular':
                raise ValueError('Upstream source type differs')
            kind = 'regular'
        total += len(data)
        if total > MAX_SOURCE_TOTAL or len(data) != record.get('bytes') or sha(data) != record.get('sha256'):
            raise ValueError('Upstream source bytes differ')
        members['upstream/' + name] = (data, 0o755 if file.lstat().st_mode & 0o111 else 0o644, kind)
    if sha(regular(source / LIMITS)) != LIMITS_AFTER:
        raise ValueError('Corresponding source budget differs')
    recipe = pinned_recipe(regular(source / 'Dockerfile'))
    if sha(recipe) != provenance.get('derivedRecipeSha256'):
        raise ValueError('Derived build recipe differs')
    patch = _git(source, 'diff', '--no-ext-diff', '--no-textconv', '--binary', '--', LIMITS)
    if sha(patch) != provenance.get('patchSha256'):
        raise ValueError('Corresponding patch differs')
    members['build/pinned-upstream.Dockerfile'] = (recipe, 0o644, 'regular')
    members['SOURCE-MANIFEST.json'] = (encoded({'format': 'gp-upstream-corresponding-source/v1',
        'commit': COMMIT, 'submodules': [{'path': SUBMODULE[0], 'commit': SUBMODULE[1]}], 'sourceInventory': inventory,
        'patchSha256': sha(patch), 'recipeSha256': sha(recipe)}), 0o644, 'regular')
    return members, patch


def license_ledger(file, source_root, binary_sha256):
    value = read_json(file)
    exact_keys(value, ('format', 'status', 'binarySha256', 'coverage', 'reviewReference', 'components'))
    if (value['format'] != LEDGER_FORMAT or value['status'] != 'complete'
            or value['binarySha256'] != binary_sha256):
        raise ValueError('Static dependency license/source review remains incomplete')
    exact_keys(value['coverage'], ('staticallyLinkedDependenciesReviewed', 'noticesComplete', 'correspondingSourceComplete'))
    if any(flag is not True for flag in value['coverage'].values()):
        raise ValueError('Static dependency license/source review remains incomplete')
    if not isinstance(value['reviewReference'], str) or not 1 <= len(value['reviewReference']) <= 160:
        raise ValueError('A bounded reviewed license reference is required')
    if not isinstance(value['components'], list) or not value['components']:
        raise ValueError('Reviewed static dependency notices are required')
    members, identities = {}, set()
    for component in value['components']:
        exact_keys(component, ('name', 'version', 'licenseExpression', 'notices', 'correspondingSource'))
        for key in ('name', 'version', 'licenseExpression'):
            if not isinstance(component[key], str) or not 1 <= len(component[key]) <= 240:
                raise ValueError('Invalid license component')
        identity = (component['name'], component['version'])
        if identity in identities:
            raise ValueError('Duplicate license component')
        identities.add(identity)
        if not isinstance(component['notices'], list) or not component['notices']:
            raise ValueError('Missing dependency notice text')
        for notice in component['notices']:
            exact_keys(notice, ('text', 'sha256'))
            if not isinstance(notice['text'], str) or sha(notice['text'].encode('utf8')) != notice['sha256']:
                raise ValueError('Dependency notice digest differs')
        reference = component['correspondingSource']
        if reference is None:
            continue  # Reviewed permissive/exception source obligation, not an inferred waiver.
        exact_keys(reference, ('filename', 'sha256', 'bytes', 'url'))
        filename = safe_relative(reference['filename'])
        if '/' in filename:
            raise ValueError('Dependency source must be a single explicit archive')
        url = urlsplit(reference['url'])
        if (url.scheme != 'https' or not url.hostname or url.username or url.password
                or url.fragment or url.query):
            raise ValueError('Dependency source provenance requires credential-free HTTPS')
        data = regular(source_root / filename, MAX_SOURCE_FILE)
        if len(data) != reference['bytes'] or sha(data) != reference['sha256']:
            raise ValueError('Dependency corresponding source digest differs')
        destination = 'dependency-sources/' + filename
        if destination in members:
            raise ValueError('Duplicate dependency source archive')
        members[destination] = (data, 0o644, 'regular')
    return encoded(value), members


def public_sbom(value):
    # Retain software/license inventory, not arbitrary Syft image paths, file
    # contents, environment, logs, timestamps or source-location properties.
    if (not isinstance(value, dict) or value.get('bomFormat') != 'CycloneDX'
            or value.get('specVersion') not in ('1.4', '1.5', '1.6')
            or not isinstance(value.get('components'), list) or not value['components']):
        raise ValueError('Missing upstream-only toolchain SBOM')
    components = []
    for component in value['components']:
        item = {}
        for key in ('type', 'name', 'version', 'group', 'purl', 'cpe', 'bom-ref', 'scope'):
            if key in component:
                field = component[key]
                if not isinstance(field, str) or len(field) > 2048 or any(ord(c) < 32 for c in field):
                    raise ValueError('Invalid toolchain SBOM field')
                item[key] = field
        if not item.get('type') or not item.get('name'):
            raise ValueError('Incomplete toolchain SBOM component')
        licenses = []
        for license_item in component.get('licenses', []):
            if 'expression' in license_item:
                licenses.append({'expression': str(license_item['expression'])})
            elif isinstance(license_item.get('license'), dict):
                definition = license_item['license']
                licenses.append({'license': {key: str(definition[key]) for key in ('id', 'name') if key in definition}})
            else:
                raise ValueError('Invalid toolchain SBOM license')
        if licenses:
            item['licenses'] = licenses
        components.append(item)
    return encoded({'bomFormat': 'CycloneDX', 'specVersion': value.get('specVersion', '1.6'),
                    'version': 1, 'components': components})


def archive_bytes(members, corresponding_source=False):
    buffer = io.BytesIO()
    # Upstream can contain long tracked paths. PAX path/link headers there are
    # deterministic because no filesystem metadata is inherited. The outer
    # executable tool archive uses only short fixed USTAR regular-file names.
    with tarfile.open(fileobj=buffer, mode='w', format=(tarfile.PAX_FORMAT if corresponding_source else tarfile.USTAR_FORMAT)) as archive:
        for name, (content, mode, kind) in sorted(members.items()):
            safe_relative(name)
            info = tarfile.TarInfo(name)
            info.uid = info.gid = info.mtime = 0
            info.uname = info.gname = ''
            info.mode = mode
            if kind == 'symlink':
                info.type = tarfile.SYMTYPE
                info.linkname = content.decode('utf8')
                archive.addfile(info)
            else:
                info.size = len(content)
                archive.addfile(info, io.BytesIO(content))
    return lzma.compress(buffer.getvalue(), format=lzma.FORMAT_XZ, preset=6)


def prepare(source, qualification, binary, ledger, dependency_sources, output):
    if output.exists():
        raise ValueError('Tool output directory must be new')
    roots = [Path(path).resolve() for path in (source, qualification, dependency_sources)]
    destination = output.absolute()
    if destination.parent.resolve() != destination.parent:
        raise ValueError('Tool output parent must be canonical and free of symlinks')
    if any(destination.is_relative_to(root) or root.is_relative_to(destination) for root in roots):
        raise ValueError('Tool output and input trees must be separate')
    core = regular(binary, MAX_CORE)
    provenance, native = validate_qualification(qualification, core)
    notices, dependency_members = license_ledger(ledger, dependency_sources, sha(core))
    upstream, patch = source_members(source, qualification, provenance)
    upstream.update(dependency_members)
    corresponding = archive_bytes(upstream, corresponding_source=True)
    raw_sbom = regular(qualification / 'sourcebuild-toolchain-sbom.json')
    if sha(raw_sbom) != native.get('sbomSha256'):
        raise ValueError('Qualified build SBOM digest differs')
    sbom = public_sbom(json.loads(raw_sbom.decode('utf8')))
    public_provenance = {
        'format': 'gp-semgrep-core-build-provenance/v1',
        'source': {key: provenance[key] for key in ('repository', 'tag', 'tagObject', 'commit',
            'limitsBeforeSha256', 'limitsAfterSha256', 'changedSourcePaths', 'patchSha256',
            'upstreamDockerfileSha256', 'derivedRecipeSha256', 'officialTarget', 'baseImage',
            'compilerSourceCommit', 'opamRepositoryCommit')},
        'native': {key: native[key] for key in ('imageId', 'binarySha256', 'binaryBytes',
            'versionOutput', 'compilerOutput')},
        'sourceModified': True, 'officialReleaseBinary': False,
        'bitIdenticalRebuildVerified': False,
        'originalBuildSbomSha256': sha(raw_sbom), 'publishedInventorySbomSha256': sha(sbom),
        'correspondingSourceSha256': sha(corresponding),
    }
    members = dict(zip(FILES, (
        core, regular(source / 'LICENSE'), patch, encoded(public_provenance), sbom,
        corresponding, notices,
    )))
    manifest = {'format': FORMAT,
        'source': {'commit': COMMIT, 'limitsBeforeSha256': LIMITS_BEFORE,
                   'limitsAfterSha256': LIMITS_AFTER, 'sourceModified': True, 'officialReleaseBinary': False},
        'wrapperVersion': VERSION,
        'qualification': {'complete': True, 'controlsPassed': True, 'caseCount': 10,
                          'scope': 'four-synthetic-controls-and-six-whole-file-cases'},
        'files': {name: {'bytes': len(data), 'sha256': sha(data)} for name, data in members.items()}}
    manifest_bytes = encoded(manifest)
    tar_members = {name: (data, 0o755 if name == 'bin/semgrep-core' else 0o644, 'regular')
                   for name, data in members.items()}
    tar_members['tool-manifest.json'] = (manifest_bytes, 0o644, 'regular')
    tool = archive_bytes(tar_members)
    receipt = {'format': 'gp-semgrep-core-tool-publisher-receipt/v1', 'publicationReady': True,
        'archive': {'filename': ARCHIVE, 'bytes': len(tool), 'sha256': sha(tool)},
        'manifest': {'bytes': len(manifest_bytes), 'sha256': sha(manifest_bytes)},
        'core': {'bytes': len(core), 'sha256': sha(core)},
        'sourceCommit': COMMIT, 'wrapperVersion': VERSION,
        'securityGateApproved': False, 'uploadPerformed': False}
    output.mkdir(mode=0o700)
    with (output / ARCHIVE).open('xb') as file:
        file.write(tool)
    with (output / 'publisher-receipt.json').open('xb') as file:
        file.write(encoded(receipt))
    return receipt


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    for name in ('source', 'qualification', 'binary', 'ledger', 'dependency-sources', 'output'):
        parser.add_argument('--' + name, required=True, type=Path)
    arguments = parser.parse_args()
    try:
        receipt = prepare(arguments.source.resolve(), arguments.qualification.resolve(),
                          arguments.binary.absolute(), arguments.ledger.absolute(),
                          arguments.dependency_sources.resolve(), arguments.output.absolute())
    except Exception as error:
        # No private filenames, captured scanner stderr, environment or source
        # contents enter public workflow logs through an exception traceback.
        print(json.dumps({'publicationReady': False, 'uploadPerformed': False,
                          'error': str(error) if isinstance(error, ValueError) else 'Tool input verification failed'}))
        raise SystemExit(2) from None
    else:
        # Tool-only identities, never private scanner data or native base64 bytes.
        print(json.dumps(receipt, sort_keys=True))

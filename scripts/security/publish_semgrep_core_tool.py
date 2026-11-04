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
import re
import stat
import subprocess
import tarfile
from urllib.parse import urlsplit

from build_semgrep_source import (
    ALPINE, COMMIT, COMPILER, DOCKERFILE, LIMITS, LIMITS_AFTER, LIMITS_BEFORE,
    OPAM_REPOSITORY, SUBMODULE, TAG, TAG_OBJECT, UPSTREAM, VERSION,
    pinned_recipe,
)
from semgrep_core_tool import ARCHIVE, MAX_ARCHIVE, check_elf, unique_json, verify_tar
from source_core_identity import inputs as build_inputs, digest as input_digest, canonical as input_canonical

FORMAT = 'gp-semgrep-core-tool/v2'
LEDGER_FORMAT = 'gp-semgrep-core-dependency-license-ledger/v3'
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
MAX_SOURCE_FILE = 512 * 1024**2
MAX_SOURCE_TOTAL = 2 * 1024**3


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


def license_ledger(file, source_root, binary_sha256, native=None):
    from compiler_license_ledger import MAX_LEDGER_JSON, validate_ledger, validate_sources
    value = unique_json(regular(file, MAX_LEDGER_JSON))
    validate_ledger(value, binary_sha256, native)
    checked = validate_sources(value, lambda name: regular(source_root / name, MAX_SOURCE_FILE))
    members = {}
    for component in value['components']:
        reference = component['correspondingSource']
        filename = safe_relative(reference['filename'])
        data = regular(source_root / filename, MAX_SOURCE_FILE)
        destination = 'dependency-sources/' + filename
        if destination in members:
            if members[destination][0] != data:
                raise ValueError('Conflicting shared dependency source archive')
            continue
        members[destination] = (data, 0o644, 'regular')
    return encoded(value), members


def public_sbom(value):
    # Retain software/license inventory, not arbitrary Syft image paths, file
    # contents, environment, logs, timestamps or source-location properties.
    if (not isinstance(value, dict) or value.get('bomFormat') != 'CycloneDX'
            or value.get('specVersion') not in ('1.4', '1.5', '1.6', '1.7')
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
    return lzma.compress(buffer.getvalue(), format=lzma.FORMAT_XZ, preset=0)


def prepare(source, qualification, binary, ledger, dependency_sources, output, root=None):
    if output.exists():
        raise ValueError('Tool output directory must be new')
    roots = [Path(path).resolve() for path in (source, qualification, dependency_sources)]
    destination = output.absolute()
    if destination.parent.resolve() != destination.parent:
        raise ValueError('Tool output parent must be canonical and free of symlinks')
    if any(destination.is_relative_to(root) or root.is_relative_to(destination) for root in roots):
        raise ValueError('Tool output and input trees must be separate')
    core = regular(binary, MAX_CORE)
    identity = build_inputs(root or Path(__file__).resolve().parents[2])
    recorded_inputs = regular(qualification / 'sourcebuild-input-identity.json')
    if recorded_inputs != input_canonical(identity):
        raise ValueError('Qualified compiler build inputs differ from publisher inputs')
    input_key = input_digest(recorded_inputs)
    provenance, native = validate_qualification(qualification, core)
    # Actual installed opam and native archive/header inputs are independently
    # observed again. A smaller set asserted only by the ledger cannot publish.
    from compiler_license_ledger import actual_license_closure
    native = {**native, **actual_license_closure(native)}
    notices, dependency_members = license_ledger(ledger, dependency_sources, sha(core), native)
    upstream, patch = source_members(source, qualification, provenance)
    upstream.update(dependency_members)
    corresponding = archive_bytes(upstream, corresponding_source=True)
    raw_sbom = regular(qualification / 'sourcebuild-toolchain-sbom.json')
    if sha(raw_sbom) != native.get('sbomSha256'):
        raise ValueError('Qualified build SBOM digest differs')
    sbom = public_sbom(json.loads(raw_sbom.decode('utf8')))
    public_provenance = {
        'format': 'gp-semgrep-core-build-provenance/v2',
        'buildInputsSha256': input_key,
        'source': {key: provenance[key] for key in ('repository', 'tag', 'tagObject', 'commit',
            'limitsBeforeSha256', 'limitsAfterSha256', 'changedSourcePaths', 'patchSha256',
            'upstreamDockerfileSha256', 'derivedRecipeSha256', 'officialTarget', 'baseImage',
            'compilerSourceCommit', 'opamRepositoryCommit')},
        'native': {key: native[key] for key in ('imageId', 'binarySha256', 'binaryBytes',
            'versionOutput', 'compilerOutput', 'opamPackages', 'nativePackageIds', 'nativeInputsSha256')
            + (('opamSourceEvidence',) if 'opamSourceEvidence' in native else ())},
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
        'buildInputs': identity, 'buildInputsSha256': input_key,
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


def verify_publication(output, root=None):
    """Check the exact nonsensitive upload set immediately before publication.

    These local byte identities do not invent a trusted Actions producer pin.
    Repository/run/artifact provenance must still be reviewed after upload.
    """
    output = Path(output).absolute()
    if output.resolve() != output or not output.is_dir():
        raise ValueError('Unsafe tool publication directory')
    if {file.name for file in output.iterdir()} != {ARCHIVE, 'publisher-receipt.json'}:
        raise ValueError('Unexpected public tool upload file')
    receipt = read_json(output / 'publisher-receipt.json')
    exact_keys(receipt, ('format', 'publicationReady', 'archive', 'manifest', 'core',
                        'sourceCommit', 'wrapperVersion', 'securityGateApproved', 'uploadPerformed'))
    if (receipt['format'] != 'gp-semgrep-core-tool-publisher-receipt/v1'
            or receipt['publicationReady'] is not True or receipt['sourceCommit'] != COMMIT
            or receipt['wrapperVersion'] != VERSION or receipt['securityGateApproved'] is not False
            or receipt['uploadPerformed'] is not False):
        raise ValueError('Unqualified public tool receipt')
    exact_keys(receipt['archive'], ('filename', 'bytes', 'sha256'))
    exact_keys(receipt['manifest'], ('bytes', 'sha256'))
    exact_keys(receipt['core'], ('bytes', 'sha256'))
    if receipt['archive']['filename'] != ARCHIVE:
        raise ValueError('Unexpected public tool archive name')
    identity = build_inputs(root or Path(__file__).resolve().parents[2])
    archive = regular(output / ARCHIVE, MAX_ARCHIVE)
    # The consumer's strict member, type, license, source, ELF and actual hash
    # checks also protect this boundary. This descriptor has no run identity and
    # is never persisted or accepted as an externally reviewed producer pin.
    descriptor = {'archive': {key: receipt['archive'][key] for key in ('bytes', 'sha256')},
        'manifestSha256': receipt['manifest']['sha256'], 'native': receipt['core'],
        'wrapper': {'version': VERSION}, 'buildInputs': identity,
        'buildInputsSha256': input_digest(input_canonical(identity))}
    _, manifest = verify_tar(archive, descriptor)
    if receipt['manifest']['bytes'] != len(encoded(manifest)):
        raise ValueError('Public tool manifest length differs')
    return receipt


def uploaded_receipt(artifact_id, artifact_digest):
    if (not isinstance(artifact_id, str) or not re.fullmatch('[1-9][0-9]{0,19}', artifact_id)
            or not isinstance(artifact_digest, str) or not re.fullmatch('[a-f0-9]{64}', artifact_digest)):
        raise ValueError('Missing immutable tool artifact upload identity')
    return {'format': 'gp-semgrep-core-tool-upload/v1', 'artifactId': artifact_id,
        'artifactArchiveSha256': artifact_digest, 'retentionDays': 90,
        'securityGateApproved': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    for name in ('source', 'qualification', 'binary', 'ledger', 'dependency-sources', 'output'):
        parser.add_argument('--' + name, type=Path)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument('--verify-upload', type=Path,
                        help='Verify the exact public tool upload set; creates or uploads nothing')
    parser.add_argument('--uploaded-receipt', action='store_true',
                        help='Require the immutable ID and digest returned by the upload action')
    arguments = parser.parse_args()
    try:
        preparation = (arguments.source, arguments.qualification, arguments.binary, arguments.ledger,
                       arguments.dependency_sources, arguments.output)
        if arguments.uploaded_receipt:
            if arguments.verify_upload is not None or any(item is not None for item in preparation):
                raise ValueError('Upload identity validation cannot also prepare or inspect a tool')
            receipt = uploaded_receipt(os.environ.get('ARTIFACT_ID'), os.environ.get('ARTIFACT_DIGEST'))
        elif arguments.verify_upload is not None:
            if any(item is not None for item in preparation):
                raise ValueError('Upload verification cannot also prepare a tool')
            receipt = verify_publication(arguments.verify_upload, arguments.root.resolve())
        else:
            if any(item is None for item in preparation):
                raise ValueError('All explicit tool preparation paths are required')
            receipt = prepare(arguments.source.resolve(), arguments.qualification.resolve(),
                              arguments.binary.absolute(), arguments.ledger.absolute(),
                              arguments.dependency_sources.resolve(), arguments.output.absolute(), arguments.root.resolve())
    except Exception as error:
        # No private filenames, captured scanner stderr, environment or source
        # contents enter public workflow logs through an exception traceback.
        print(json.dumps({'publicationReady': False, 'uploadPerformed': False,
                          'error': str(error) if isinstance(error, ValueError) else 'Tool input verification failed'}))
        raise SystemExit(2) from None
    else:
        # Tool-only identities, never private scanner data or native base64 bytes.
        print(json.dumps(receipt, sort_keys=True))

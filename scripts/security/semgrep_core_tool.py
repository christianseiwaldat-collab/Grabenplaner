"""Consume a separately reviewed, immutable modified-core tool artifact.

No pin is learned from a download. No original-core fallback or security approval
is provided here. The publisher retains upstream source/licenses separately from
encrypted GP findings; this consumer extracts only an externally pinned ELF.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import io
import json
import os
from pathlib import Path
import re
import stat
import struct
import tarfile
import urllib.error
import urllib.request
from urllib.parse import urlsplit
import zipfile
from source_core_identity import validate as validate_inputs, canonical as input_canonical

FORMAT = 'gp-semgrep-qualified-core-pin/v2'
ARCHIVE = 'semgrep-core-tool.tar.xz'
MEMBERS = frozenset(('bin/semgrep-core', 'upstream/LICENSE', 'upstream/source.patch',
    'upstream/provenance.json', 'upstream/toolchain-sbom.cdx.json',
    'upstream/corresponding-source.tar.xz', 'upstream/dependency-license-notices.json'))
UPSTREAM = {'commit': '72d3525fe7e02f486428386078f192f8c4756804',
    'limitsBeforeSha256': '3ed5f57cd546ab78208a944bd35b6e974116d6aa1d59f1fe318d5a087f5fdeb1',
    'limitsAfterSha256': '92b07fd747b597a3e5eb59b3325c61812bb29e2aef1ee848251498feabf3f526',
    'sourceModified': True, 'officialReleaseBinary': False}
QUALIFICATION = {'complete': True, 'controlsPassed': True, 'caseCount': 10,
    'scope': 'four-synthetic-controls-and-six-whole-file-cases'}
# Finite retained/downloaded size for the exact externally pinned compiler
# artifact and its inner XZ only. Source expansion, per-file and JSON bounds
# remain independent. Activate only after actual source packaging measurement.
MAX_ARCHIVE = 1536 * 1024**2
MAX_TOTAL = 2 * 1024**3
MAX_JSON = 4 * 1024**2


class ToolUnavailable(ValueError):
    """Only an authenticated missing/expired artifact permits a cold rebuild."""


def digest(value):
    return hashlib.sha256(value).hexdigest()


def canonical(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False) + '\n').encode()


def unique_json(data):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError('Duplicate JSON key')
            result[key] = value
        return result
    return json.loads(data, object_pairs_hook=pairs)


def identity(value, maximum):
    if (not isinstance(value, dict) or set(value) != {'sha256', 'bytes'}
            or not re.fullmatch('[a-f0-9]{64}', str(value['sha256']))
            or type(value['bytes']) is not int or not 0 < value['bytes'] <= maximum):
        raise ValueError('Invalid pinned file identity')
    return value


def validate_pin(pin):
    if not isinstance(pin, dict) or set(pin) != {'format', 'repository', 'run', 'artifact',
            'archive', 'manifestSha256', 'native', 'wrapper', 'toolsConfigurationSha256', 'source',
            'buildInputs', 'buildInputsSha256'}:
        raise ValueError('Incomplete or unexpected tool pin')
    if pin['format'] != FORMAT or pin['source'] != UPSTREAM:
        raise ValueError('Unreviewed core source identity')
    repository, run, artifact = pin['repository'], pin['run'], pin['artifact']
    if (set(repository) != {'fullName', 'id'} or not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repository['fullName'])
            or type(repository['id']) is not int or repository['id'] <= 0):
        raise ValueError('Invalid repository identity')
    if (set(run) != {'id', 'attempt', 'headSha', 'workflowId', 'workflowPath'}
            or any(type(run[key]) is not int or run[key] <= 0 for key in ('id', 'attempt', 'workflowId'))
            or not re.fullmatch('[a-f0-9]{40}', run['headSha'])
            or run['workflowPath'] != '.github/workflows/sast-source-build.yml'):
        raise ValueError('Invalid qualification run identity')
    if (set(artifact) != {'id', 'name', 'sha256', 'bytes'} or type(artifact['id']) is not int or artifact['id'] <= 0
            or artifact['name'] != f"semgrep-core-tool-{run['id']}-{run['attempt']}"):
        raise ValueError('Invalid tool artifact identity')
    identity({key: artifact[key] for key in ('sha256', 'bytes')}, MAX_ARCHIVE)
    if set(pin['archive']) != {'name', 'sha256', 'bytes'} or pin['archive']['name'] != ARCHIVE:
        raise ValueError('Unexpected tool archive')
    identity({key: pin['archive'][key] for key in ('sha256', 'bytes')}, MAX_ARCHIVE)
    identity(pin['native'], 256 * 1024**2)
    for key in ('manifestSha256', 'toolsConfigurationSha256'):
        if not re.fullmatch('[a-f0-9]{64}', str(pin[key])):
            raise ValueError('Missing external configuration pin')
    if set(pin['wrapper']) != {'version', 'requirementsSha256'} or pin['wrapper']['version'] != '1.181.0':
        raise ValueError('Unreviewed wrapper version')
    if not re.fullmatch('[a-f0-9]{64}', str(pin['wrapper']['requirementsSha256'])):
        raise ValueError('Unpinned wrapper requirements')
    validate_inputs(pin['buildInputs'])
    if (pin['buildInputsSha256'] != digest(input_canonical(pin['buildInputs']))
            or pin['buildInputs']['requirementsSha256'] != pin['wrapper']['requirementsSha256']
            or pin['buildInputs']['toolsConfigurationSha256'] != pin['toolsConfigurationSha256']):
        raise ValueError('Compiler build inputs differ from their external pin')
    return pin


def validate_metadata(pin, run, artifact, now=None):
    validate_pin(pin)
    expected, repo = pin['run'], pin['repository']
    if (run.get('id') != expected['id'] or run.get('run_attempt') != expected['attempt']
            or run.get('head_sha') != expected['headSha'] or run.get('workflow_id') != expected['workflowId']
            or str(run.get('path', '')).split('@')[0] != expected['workflowPath']
            or run.get('repository', {}).get('id') != repo['id']
            or run.get('repository', {}).get('full_name') != repo['fullName']
            or run.get('head_repository', {}).get('id') != repo['id']
            or run.get('status') != 'completed' or run.get('conclusion') != 'success'
            or run.get('event') not in ('push', 'workflow_dispatch')):
        raise ValueError('Tool qualification run is not the reviewed successful run')
    pinned, binding = pin['artifact'], artifact.get('workflow_run', {})
    if (artifact.get('id') != pinned['id'] or artifact.get('name') != pinned['name']
            or artifact.get('size_in_bytes') != pinned['bytes'] or type(artifact.get('expired')) is not bool
            or artifact.get('digest') != 'sha256:' + pinned['sha256']
            or binding.get('id') != expected['id'] or binding.get('head_sha') != expected['headSha']
            or binding.get('repository_id') != repo['id'] or binding.get('head_repository_id') != repo['id']):
        raise ValueError('Tool artifact provenance differs from the external pin')
    expiry = datetime.fromisoformat(str(artifact.get('expires_at', '')).replace('Z', '+00:00'))
    if expiry.tzinfo is None:
        raise ValueError('Tool artifact has an invalid expiry')
    if artifact['expired'] or expiry <= (now or datetime.now(timezone.utc)):
        raise ToolUnavailable('Reviewed tool artifact has expired')


def check_bytes(data, expected, label):
    if len(data) != expected['bytes'] or digest(data) != expected['sha256']:
        raise ValueError(label + ' identity mismatch')


def check_elf(data):
    if (len(data) < 64 or data[:7] != b'\x7fELF\x02\x01\x01'
            or struct.unpack_from('<H', data, 16)[0] not in (2, 3)
            or struct.unpack_from('<H', data, 18)[0] != 62):
        raise ValueError('Expected a Linux x86-64 ELF')
    offset = struct.unpack_from('<Q', data, 32)[0]
    size, count = struct.unpack_from('<HH', data, 54)
    if offset < 64 or size != 56 or not 0 < count <= 256 or offset + size * count > len(data):
        raise ValueError('Malformed ELF program headers')
    dynamic = None
    for index in range(count):
        kind, _, start, _, _, length, memory_length, _ = struct.unpack_from('<IIQQQQQQ', data, offset + index * size)
        if start > len(data) or length > len(data) - start or kind == 1 and length > memory_length:
            raise ValueError('Malformed ELF segment bounds')
        if kind == 3:  # PT_INTERP
            raise ValueError('The reviewed tool must be static, without PT_INTERP')
        if kind == 2:  # PT_DYNAMIC: static PIE may legitimately retain relocation metadata.
            if dynamic is not None or length < 16 or length % 16:
                raise ValueError('Malformed ELF dynamic segment')
            dynamic = (start, length)
    if dynamic is not None:
        start, length = dynamic
        for position in range(start, start + length, 16):
            tag, _ = struct.unpack_from('<qQ', data, position)
            if tag == 0:  # DT_NULL terminates the entries interpreted by the loader.
                break
            if tag == 1:  # DT_NEEDED is an external dependency even without PT_INTERP.
                raise ValueError('The reviewed tool must be static, without DT_NEEDED')
        else:
            raise ValueError('Unterminated ELF dynamic segment')


def verify_tar(data, pin, with_contents=False):
    from compiler_license_ledger import MAX_LEDGER_JSON
    check_bytes(data, pin['archive'], 'Inner archive')
    contents, total = {}, 0
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:xz') as archive:
        for item in archive:
            if (item.name not in MEMBERS | {'tool-manifest.json'} or item.name in contents
                    or not item.isfile() or item.linkname or item.pax_headers
                    or item.uid != 0 or item.gid != 0 or item.uname or item.gname or item.mtime != 0
                    or item.mode != (0o755 if item.name == 'bin/semgrep-core' else 0o644)
                    or not 0 < item.size <= MAX_TOTAL):
                raise ValueError('Unexpected tool tar member or metadata')
            total += item.size
            json_limit = MAX_LEDGER_JSON if item.name == 'upstream/dependency-license-notices.json' else MAX_JSON
            if total > MAX_TOTAL or (item.name.endswith('.json') and item.size > json_limit):
                raise ValueError('Tool archive exceeds its declared retention bounds')
            stream = archive.extractfile(item)
            value = stream.read(item.size + 1)
            if len(value) != item.size:
                raise ValueError('Truncated tool tar member')
            contents[item.name] = value
    if set(contents) != MEMBERS | {'tool-manifest.json'}:
        raise ValueError('Incomplete tool archive')
    manifest_bytes = contents['tool-manifest.json']
    if digest(manifest_bytes) != pin['manifestSha256']:
        raise ValueError('Externally pinned tool manifest differs')
    manifest = unique_json(manifest_bytes)
    if (set(manifest) != {'format', 'source', 'wrapperVersion', 'qualification', 'files',
            'buildInputs', 'buildInputsSha256'}
            or manifest['format'] != 'gp-semgrep-core-tool/v2' or manifest['source'] != UPSTREAM
            or manifest['wrapperVersion'] != pin['wrapper']['version'] or manifest['qualification'] != QUALIFICATION
            or manifest['buildInputs'] != pin['buildInputs'] or manifest['buildInputsSha256'] != pin['buildInputsSha256']
            or set(manifest['files']) != MEMBERS or canonical(manifest) != manifest_bytes):
        raise ValueError('Unqualified or unexpected tool manifest')
    for name, entry in manifest['files'].items():
        identity(entry, MAX_TOTAL)
        check_bytes(contents[name], entry, 'Tool member')
    native = contents['bin/semgrep-core']
    check_bytes(native, pin['native'], 'Native core')
    check_elf(native)
    ledger = unique_json(contents['upstream/dependency-license-notices.json'])
    provenance = unique_json(contents['upstream/provenance.json'])
    inputs = pin['buildInputs']
    expected_source = {**{key: inputs['source'][key] for key in ('repository', 'tag', 'tagObject', 'commit')},
        'limitsBeforeSha256': inputs['patchRecipe']['beforeSha256'],
        'limitsAfterSha256': inputs['patchRecipe']['afterSha256'],
        'changedSourcePaths': [inputs['patchRecipe']['path']],
        'upstreamDockerfileSha256': inputs['patchRecipe']['upstreamDockerfileSha256'],
        'derivedRecipeSha256': inputs['patchRecipe']['derivedRecipeSha256'],
        'officialTarget': inputs['toolchain']['target'],
        **{key: inputs['toolchain'][key] for key in ('baseImage', 'compilerSourceCommit', 'opamRepositoryCommit')},
        'patchSha256': digest(contents['upstream/source.patch'])}
    if (not isinstance(provenance, dict) or set(provenance) != {'format', 'source', 'native',
            'sourceModified', 'officialReleaseBinary', 'bitIdenticalRebuildVerified',
            'originalBuildSbomSha256', 'publishedInventorySbomSha256', 'correspondingSourceSha256',
            'buildInputsSha256'}
            or provenance.get('format') != 'gp-semgrep-core-build-provenance/v2'
            or provenance.get('source') != expected_source
            or provenance.get('buildInputsSha256') != pin['buildInputsSha256']
            or provenance.get('sourceModified') is not True or provenance.get('officialReleaseBinary') is not False
            or provenance.get('bitIdenticalRebuildVerified') is not False
            or provenance.get('publishedInventorySbomSha256') != digest(contents['upstream/toolchain-sbom.cdx.json'])
            or provenance.get('correspondingSourceSha256') != digest(contents['upstream/corresponding-source.tar.xz'])
            or not re.fullmatch('[a-f0-9]{64}', str(provenance.get('originalBuildSbomSha256')))):
        raise ValueError('Published compiler provenance differs from reviewed build inputs')
    native_provenance = provenance['native']
    if (not isinstance(native_provenance, dict) or set(native_provenance) != {
            'imageId', 'binarySha256', 'binaryBytes', 'versionOutput', 'compilerOutput', 'opamPackages',
            'nativePackageIds', 'nativeInputsSha256'} | ({'opamSourceEvidence'} if 'opamSourceEvidence' in native_provenance else set())
            or native_provenance.get('binarySha256') != pin['native']['sha256']
            or native_provenance.get('binaryBytes') != pin['native']['bytes']
            or not re.fullmatch('sha256:[a-f0-9]{64}', str(native_provenance.get('imageId')))
            or any(not isinstance(native_provenance.get(key), str) or not 1 <= len(native_provenance[key]) <= 512
                or any(ord(c) < 32 or ord(c) == 127 for c in native_provenance[key])
                for key in ('versionOutput', 'compilerOutput'))
            or inputs['wrapperVersion'] not in native_provenance['versionOutput']
            or inputs['toolchain']['compilerSourceCommit'] not in native_provenance['compilerOutput']):
        raise ValueError('Published native toolchain provenance is unbound')
    from compiler_license_ledger import validate_ledger, embedded_dependency_sources
    try:
        validate_ledger(ledger, pin['native']['sha256'], native_provenance)
        embedded_dependency_sources(contents['upstream/corresponding-source.tar.xz'], ledger)
    except (ValueError, KeyError, TypeError, tarfile.TarError, OSError):
        raise ValueError('Static dependency notice/source ledger is incomplete or unbound') from None
    return (native, manifest, contents) if with_contents else (native, manifest)


def verify_zip(data, pin, with_contents=False):
    validate_pin(pin)
    check_bytes(data, pin['artifact'], 'Outer Actions ZIP')
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        entries = archive.infolist()
        if len(entries) != 1 or entries[0].filename != ARCHIVE:
            raise ValueError('Unexpected Actions ZIP members')
        item = entries[0]
        kind = stat.S_IFMT(item.external_attr >> 16)
        if (item.is_dir() or kind not in (0, stat.S_IFREG) or item.flag_bits & 1
                or item.file_size != pin['archive']['bytes'] or item.file_size > MAX_ARCHIVE):
            raise ValueError('Unsafe Actions ZIP member')
        return verify_tar(archive.read(item), pin, with_contents)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def storage_url(value):
    parsed = urlsplit(value)
    if (parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password
            or parsed.fragment or '\n' in value or '\r' in value):
        raise ValueError('Unsafe artifact storage redirect')
    return value


class HttpsStorageRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return super().redirect_request(req, fp, code, msg, headers, storage_url(newurl))


def github_request(path, token, limit):
    # Never propagate the GitHub bearer to the signed artifact storage URL.
    request = urllib.request.Request('https://api.github.com/' + path, headers={
        'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
        'Authorization': 'Bearer ' + token, 'User-Agent': 'gp-pinned-semgrep-tool'})
    try:
        response = urllib.request.build_opener(NoRedirect).open(request, timeout=60)
    except urllib.error.HTTPError as error:
        if error.code in (404, 410):
            raise ToolUnavailable('Reviewed GitHub tool artifact is unavailable') from None
        if error.code != 302:
            raise ValueError('GitHub tool metadata/download request failed') from None
        location = storage_url(error.headers.get('Location', ''))
        # A new request contains no Authorization header. The default redirect
        # handler can only forward this fresh, token-free storage request.
        response = urllib.request.build_opener(HttpsStorageRedirect).open(location, timeout=120)
    with response:
        data = response.read(limit + 1)
        if len(data) > limit:
            raise ValueError('Tool download exceeded its pinned size bound')
        return data


def fetch(pin, token, with_contents=False):
    validate_pin(pin)
    prefix = 'repos/' + pin['repository']['fullName'] + '/actions/'
    run = unique_json(github_request(prefix + 'runs/' + str(pin['run']['id']), token, MAX_JSON))
    artifact = unique_json(github_request(prefix + 'artifacts/' + str(pin['artifact']['id']), token, MAX_JSON))
    validate_metadata(pin, run, artifact)
    data = github_request(prefix + 'artifacts/' + str(pin['artifact']['id']) + '/zip', token, pin['artifact']['bytes'])
    return verify_zip(data, pin, with_contents)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--pin', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    pin = validate_pin(unique_json(args.pin.read_bytes()))
    from source_core_identity import inputs
    here = Path(__file__).resolve().parent
    if (inputs(here.parents[1]) != pin['buildInputs']
            or digest((here / 'requirements.txt').read_bytes()) != pin['wrapper']['requirementsSha256']
            or digest((here / 'tools.json').read_bytes()) != pin['toolsConfigurationSha256']):
        raise ValueError('Current wrapper/rule configuration differs from the reviewed tool pin')
    args.output = args.output.absolute()
    if (not args.output.parent.is_dir() or args.output.parent.resolve() != args.output.parent
            or args.output.exists() or args.output.is_symlink()):
        raise ValueError('A new private output directory is required')
    token = os.environ.get('GITHUB_TOKEN', '')
    if not token:
        raise ValueError('The tool download requires a read-only Actions token')
    native, manifest = fetch(pin, token)
    # No downloaded executable is started here, and nothing is written until
    # the complete external/internal provenance and byte chain has passed.
    args.output.mkdir(mode=0o700)
    with (args.output / 'semgrep-core').open('xb') as stream:
        stream.write(native)
    (args.output / 'semgrep-core').chmod(0o700)
    (args.output / 'tool-manifest.json').write_bytes(canonical(manifest))
    print('Pinned modified upstream core verified; no security-gate approval implied.')


if __name__ == '__main__':
    main()

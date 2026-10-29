"""Acquire only an externally pinned compiler; always qualify current sources.

There is intentionally no checked-in production pin. An eligible tool must first
pass the separate corresponding-source/license publisher and trusted producer.
Absence/expiry or another valid input key permits a cold build; corrupt evidence
for the selected key stays a hard failure.
"""
import base64
import lzma
import os

from source_core_identity import inputs, canonical, digest, regular
from semgrep_core_tool import ToolUnavailable, fetch, validate_pin, unique_json

PIN = '.github/security-semgrep-core-pin.json'
RECEIPT = 'sourcebuild-acquisition.json'
INPUTS = 'sourcebuild-input-identity.json'


def acquire(root, tools, work, output, source, recipe, commands, force_cold=False):
    from build_semgrep_source import build_core, write
    identity = inputs(root)
    key = digest(canonical(identity))
    (output / INPUTS).write_bytes(canonical(identity))
    pin_path = root / PIN
    reason, producer, pin = 'explicit_producer_build' if force_cold else 'no_reviewed_pin', None, None
    if not force_cold and (pin_path.exists() or pin_path.is_symlink()):
        pin_bytes = regular(pin_path)
        pin = validate_pin(unique_json(pin_bytes))
        if canonical(pin) != pin_bytes:
            raise ValueError('Reviewed compiler pin is not canonical')
        if pin['buildInputs'] != identity or pin['buildInputsSha256'] != key:
            # This is a valid compiler for another key, never authority to run
            # it against changed rules/wrapper/recipe. Build the current key.
            reason, pin = 'reviewed_inputs_changed', None
    if pin is not None:
        # The reviewed producer must belong to this repository, including when
        # the consuming workflow runs for a fork pull request. Metadata cannot
        # turn an arbitrary repository's successful run into our trusted tool.
        if pin['repository'] != {'fullName': os.environ.get('GITHUB_REPOSITORY'),
                'id': int(os.environ.get('GITHUB_REPOSITORY_ID', '0'))}:
            raise ValueError('Reviewed compiler producer is not this GitHub repository')
        token = os.environ.get('GITHUB_TOKEN', '')
        if not token:
            raise ValueError('Reviewed compiler reuse requires a read-only Actions token')
        try:
            core, manifest, members = fetch(pin, token, with_contents=True)
        except ToolUnavailable:
            reason = 'reviewed_artifact_unavailable'
        else:
            binary = work / 'semgrep-core-reviewed-reuse'
            with binary.open('xb') as stream:
                stream.write(core)
            binary.chmod(0o700)
            public = unique_json(members['upstream/provenance.json'])
            for option, field, label in (('-version', 'versionOutput', 'reused-core-version'),
                                        ('-ocaml_version', 'compilerOutput', 'reused-compiler-version')):
                actual = commands.run([binary, option], label).decode().strip()
                if actual != public['native'][field]:
                    raise ValueError('Reused compiler execution differs from its reviewed producer provenance')
            sbom = members['upstream/toolchain-sbom.cdx.json']
            (output / 'sourcebuild-toolchain-sbom.json').write_bytes(sbom)
            (output / 'sourcebuild-native-provenance.json').write_bytes(canonical({**public['native'],
                'baseImage': identity['toolchain']['baseImage'], 'sourceModified': True,
                'officialReleaseBinary': False, 'bitIdenticalRebuildVerified': False,
                'sbomSha256': digest(sbom), 'originalBuildSbomSha256': public['originalBuildSbomSha256']}))
            compressed = lzma.compress(core, preset=6)
            write(output / 'sourcebuild-native-core.json', {'format': 'gp-diagnostic-native-binary-xz-v1',
                'filename': binary.name, 'sourceModified': True, 'officialReleaseBinary': False,
                'sha256': digest(core), 'bytes': len(core), 'xzSha256': digest(compressed),
                'xzBase64': base64.b64encode(compressed).decode()})
            producer = {name: pin[name] for name in ('repository', 'run', 'artifact', 'manifestSha256')}
            producer['pinSha256'] = digest(pin_bytes)
            (output / 'sourcebuild-reuse-pin.json').write_bytes(pin_bytes)
            (output / 'sourcebuild-reuse-manifest.json').write_bytes(canonical(manifest))
            (output / 'sourcebuild-reuse-provenance.json').write_bytes(members['upstream/provenance.json'])
            reason = None
    if producer is None:
        binary = build_core(work, output, tools, source, recipe, commands)
    data = binary.read_bytes()
    receipt = {'format': 'gp-semgrep-core-acquisition/v1',
        'mode': 'reviewed_reuse' if producer is not None else 'cold_build', 'reason': reason,
        'buildInputsSha256': key, 'nativeSha256': digest(data), 'nativeBytes': len(data),
        'producer': producer, 'freshCurrentQualificationRequired': True,
        'fullProjectScanApproved': False}
    write(output / RECEIPT, receipt)
    return binary


def verify(directory, root, native):
    """Bind acquisition evidence again before ordinary SAST, without a network call."""
    identity = unique_json(regular(directory / INPUTS))
    expected = inputs(root)
    if identity != expected or canonical(identity) != regular(directory / INPUTS):
        raise ValueError('Compiler inputs changed after acquisition')
    key = digest(canonical(identity))
    receipt = unique_json(regular(directory / RECEIPT))
    if (not isinstance(receipt, dict) or set(receipt) != {'format', 'mode', 'reason',
            'buildInputsSha256', 'nativeSha256', 'nativeBytes', 'producer',
            'freshCurrentQualificationRequired', 'fullProjectScanApproved'}
            or receipt.get('format') != 'gp-semgrep-core-acquisition/v1'
            or receipt.get('buildInputsSha256') != key or receipt.get('nativeSha256') != digest(native)
            or receipt.get('nativeBytes') != len(native)
            or receipt.get('freshCurrentQualificationRequired') is not True
            or receipt.get('fullProjectScanApproved') is not False):
        raise ValueError('Compiler acquisition is incomplete or unbound')
    if receipt['mode'] == 'cold_build':
        if receipt['producer'] is not None or receipt['reason'] not in (
                'no_reviewed_pin', 'reviewed_artifact_unavailable', 'explicit_producer_build', 'reviewed_inputs_changed'):
            raise ValueError('Invalid cold compiler acquisition evidence')
    elif receipt['mode'] == 'reviewed_reuse':
        pin_bytes = regular(root / PIN)
        if pin_bytes != regular(directory / 'sourcebuild-reuse-pin.json'):
            raise ValueError('Reviewed compiler pin changed after acquisition')
        pin = validate_pin(unique_json(pin_bytes))
        expected_producer = {name: pin[name] for name in ('repository', 'run', 'artifact', 'manifestSha256')}
        expected_producer['pinSha256'] = digest(pin_bytes)
        if (receipt['reason'] is not None or receipt['producer'] != expected_producer
                or pin['buildInputs'] != identity or pin['buildInputsSha256'] != key
                or pin['native'] != {'sha256': digest(native), 'bytes': len(native)}):
            raise ValueError('Reused compiler differs from its reviewed producer pin')
        manifest_bytes = regular(directory / 'sourcebuild-reuse-manifest.json')
        manifest = unique_json(manifest_bytes)
        if (digest(manifest_bytes) != pin['manifestSha256'] or manifest['buildInputs'] != identity
                or manifest['buildInputsSha256'] != key):
            raise ValueError('Reused compiler manifest changed after acquisition')
        public_bytes = regular(directory / 'sourcebuild-reuse-provenance.json')
        sbom = regular(directory / 'sourcebuild-toolchain-sbom.json')
        for name, data in (('upstream/provenance.json', public_bytes), ('upstream/toolchain-sbom.cdx.json', sbom)):
            if manifest['files'][name] != {'sha256': digest(data), 'bytes': len(data)}:
                raise ValueError('Reused compiler provenance changed after acquisition')
        public = unique_json(public_bytes)
        native_bytes = regular(directory / 'sourcebuild-native-provenance.json')
        native_provenance = unique_json(native_bytes)
        if native_provenance != {**public['native'], 'baseImage': identity['toolchain']['baseImage'],
                'sourceModified': True, 'officialReleaseBinary': False, 'bitIdenticalRebuildVerified': False,
                'sbomSha256': digest(sbom), 'originalBuildSbomSha256': public['originalBuildSbomSha256']} \
                or native_bytes != canonical(native_provenance):
            raise ValueError('Reused native compiler provenance differs from its producer')
    else:
        raise ValueError('Unknown compiler acquisition mode')
    return receipt

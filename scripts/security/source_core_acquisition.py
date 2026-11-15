"""Acquire only an externally pinned compiler; always qualify current sources.

An optional checked-in pin selects an externally reviewed producer artifact.
An eligible tool must first pass the separate source/license publisher.
Absence/expiry or another valid input key permits a cold build; corrupt evidence
for the selected key stays a hard failure.
"""
import base64
import lzma
import os
import re

from source_core_identity import (inputs, canonical, digest, regular, native_compiler_identity,
                                 LEGACY_PROGRAMS, PROGRAMS)
from semgrep_core_tool import ToolUnavailable, fetch, validate_pin, unique_json

PIN = '.github/security-semgrep-core-pin.json'
RECEIPT = 'sourcebuild-acquisition.json'
INPUTS = 'sourcebuild-input-identity.json'
APPROVAL = '.github/security-semgrep-core-reuse.json'


def reuse_approval(root, pin, pin_bytes, identity):
    """Authenticate an explicitly reviewed exact legacy/current transition.

    This versioned approval is not generated or learned by a consuming job.
    Original producer documents retain their original identities. A stale
    approval is not authority for later input changes; selected corruption is
    a hard failure, never a reason to conceal evidence with a cold retry.
    """
    path = root / APPROVAL
    if not path.exists() and not path.is_symlink():
        return None
    raw = regular(path)
    approval = unique_json(raw)
    fields = {'format', 'migration', 'producerPinSha256', 'producerBuildInputsSha256',
              'consumerBuildInputsSha256', 'native', 'compilerInputsSha256',
              'freshCurrentQualificationRequired', 'fullProjectScanApproved',
              'requirements', 'installer'}
    hashes = ('producerPinSha256', 'producerBuildInputsSha256',
              'consumerBuildInputsSha256', 'compilerInputsSha256')
    if (not isinstance(approval, dict) or set(approval) != fields
            or canonical(approval) != raw
            or approval.get('format') != 'gp-semgrep-core-reuse-approval/v1'
            or approval.get('migration') != 'legacy-native-current-wrapper-v1'
            or any(not isinstance(approval.get(name), str)
                   or not re.fullmatch('[a-f0-9]{64}', approval[name]) for name in hashes)
            or approval.get('freshCurrentQualificationRequired') is not True
            or approval.get('fullProjectScanApproved') is not False
            or not isinstance(approval.get('requirements'), dict)
            or set(approval['requirements']) != {'producerSha256', 'consumerSha256'}
            or any(not isinstance(value, str) or not re.fullmatch('[a-f0-9]{64}', value)
                   for value in approval['requirements'].values())
            or not isinstance(approval.get('installer'), dict)
            or set(approval['installer']) != {'path', 'sha256'}
            or approval['installer']['path'] != 'install_semgrep_runtime.py'
            or not isinstance(approval['installer']['sha256'], str)
            or not re.fullmatch('[a-f0-9]{64}', approval['installer']['sha256'])
            or not isinstance(approval.get('native'), dict)
            or set(approval['native']) != {'sha256', 'bytes'}
            or not isinstance(approval['native']['sha256'], str)
            or not re.fullmatch('[a-f0-9]{64}', approval['native']['sha256'])
            or type(approval['native']['bytes']) is not int
            or not 0 < approval['native']['bytes'] <= 256 * 1024**2):
        raise ValueError('Invalid reviewed compiler reuse approval')
    current_key = digest(canonical(identity))
    if (approval['producerPinSha256'] != digest(pin_bytes)
            or approval['consumerBuildInputsSha256'] != current_key):
        return None
    producer = pin['buildInputs']
    producer_native = native_compiler_identity(producer)
    current_native = native_compiler_identity(identity)
    if (set(producer['programs']) != set(LEGACY_PROGRAMS)
            or set(identity['programs']) != set(PROGRAMS)
            or approval['producerBuildInputsSha256'] != pin['buildInputsSha256']
            or approval['native'] != pin['native']
            or producer_native != current_native
            or approval['compilerInputsSha256'] != digest(canonical(current_native))
            or approval['requirements'] != {'producerSha256': producer['requirementsSha256'],
                                             'consumerSha256': identity['requirementsSha256']}
            or approval['installer']['sha256'] != identity['programs']['install_semgrep_runtime.py']):
        raise ValueError('Reviewed compiler reuse approval contradicts protected inputs')
    return {'path': APPROVAL, 'sha256': digest(raw)}


def acquire(root, tools, work, output, source, recipe, commands, force_cold=False):
    from build_semgrep_source import build_core, write
    identity = inputs(root)
    key = digest(canonical(identity))
    (output / INPUTS).write_bytes(canonical(identity))
    pin_path = root / PIN
    reason, producer, pin = 'explicit_producer_build' if force_cold else 'no_reviewed_pin', None, None
    approval = None
    if not force_cold and (pin_path.exists() or pin_path.is_symlink()):
        pin_bytes = regular(pin_path)
        pin = validate_pin(unique_json(pin_bytes))
        if canonical(pin) != pin_bytes:
            raise ValueError('Reviewed compiler pin is not canonical')
        if pin['buildInputs'] != identity or pin['buildInputsSha256'] != key:
            approval = reuse_approval(root, pin, pin_bytes, identity)
            if approval is None:
                # A valid tool for another key is not permission to reuse it.
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
    if producer is not None and approval is not None:
        receipt.update(format='gp-semgrep-core-acquisition/v2', reuseApproval=approval)
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
    fields = {'format', 'mode', 'reason',
            'buildInputsSha256', 'nativeSha256', 'nativeBytes', 'producer',
            'freshCurrentQualificationRequired', 'fullProjectScanApproved'}
    bridged = isinstance(receipt, dict) and receipt.get('format') == 'gp-semgrep-core-acquisition/v2'
    if bridged:
        fields.add('reuseApproval')
    if (not isinstance(receipt, dict) or set(receipt) != fields
            or receipt.get('format') not in ('gp-semgrep-core-acquisition/v1', 'gp-semgrep-core-acquisition/v2')
            or receipt.get('buildInputsSha256') != key or receipt.get('nativeSha256') != digest(native)
            or receipt.get('nativeBytes') != len(native)
            or receipt.get('freshCurrentQualificationRequired') is not True
            or receipt.get('fullProjectScanApproved') is not False):
        raise ValueError('Compiler acquisition is incomplete or unbound')
    if receipt['mode'] == 'cold_build':
        if bridged or receipt['producer'] is not None or receipt['reason'] not in (
                'no_reviewed_pin', 'reviewed_artifact_unavailable', 'explicit_producer_build', 'reviewed_inputs_changed'):
            raise ValueError('Invalid cold compiler acquisition evidence')
    elif receipt['mode'] == 'reviewed_reuse':
        pin_bytes = regular(root / PIN)
        if pin_bytes != regular(directory / 'sourcebuild-reuse-pin.json'):
            raise ValueError('Reviewed compiler pin changed after acquisition')
        pin = validate_pin(unique_json(pin_bytes))
        expected_producer = {name: pin[name] for name in ('repository', 'run', 'artifact', 'manifestSha256')}
        expected_producer['pinSha256'] = digest(pin_bytes)
        exact_identity = pin['buildInputs'] == identity and pin['buildInputsSha256'] == key
        approval = reuse_approval(root, pin, pin_bytes, identity) if not exact_identity else None
        if (bridged and (approval is None or receipt['reuseApproval'] != approval)
                or not bridged and not exact_identity):
            raise ValueError('Reused compiler has no matching reviewed current-input approval')
        if (receipt['reason'] is not None or receipt['producer'] != expected_producer
                or pin['native'] != {'sha256': digest(native), 'bytes': len(native)}):
            raise ValueError('Reused compiler differs from its reviewed producer pin')
        manifest_bytes = regular(directory / 'sourcebuild-reuse-manifest.json')
        manifest = unique_json(manifest_bytes)
        if (digest(manifest_bytes) != pin['manifestSha256'] or manifest['buildInputs'] != pin['buildInputs']
                or manifest['buildInputsSha256'] != pin['buildInputsSha256']):
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

"""Bind the acquired and freshly qualified private core to ordinary SAST.

This is an internal source-build path. It publishes no reusable executable and
grants no scan approval. The complete original project profiles and disposition
rules run afterwards, with their original budgets and strict completeness tests.
"""
import argparse
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import re
import sys
import datetime as dt

from build_semgrep_source import VERSION, SMALL_TARGET, control_sources, validate_result
from publish_semgrep_core_tool import validate_qualification
from semgrep_core_tool import canonical, unique_json
from source_core_acquisition import verify as verify_acquisition


def sha(value):
    return hashlib.sha256(value).hexdigest()


def require_regular(path, limit=96 * 1024**2):
    info = path.lstat()
    if (path.resolve() != path.absolute() or not path.is_file() or info.st_nlink != 1
            or not 0 < info.st_size <= limit):
        raise ValueError('Unsafe source-core qualification file')
    return path.read_bytes()


def verify_case_results(directory, root, gate):
    plan = unique_json(require_regular(directory / 'sourcebuild-diagnostic-plan.json'))
    entries = plan.get('wholeUnmodifiedFiles')
    if (plan.get('diagnosticOnly') is not True or plan.get('securityGatePassed') is not False
            or not isinstance(entries, list) or len(entries) != 2
            or {entry.get('path') for entry in entries} != {'server.js', SMALL_TARGET}):
        raise ValueError('Both original whole-file qualification source identities are required')
    for entry in entries:
        data = require_regular(root / entry['path'])
        if len(data) != entry['bytes'] or sha(data) != entry['sha256']:
            raise ValueError('The source changed after whole-file tool qualification')
    controls = {name: (sources, rule) for name, rule, sources in control_sources()}
    for case in gate['cases']:
        name = case['name']
        result_bytes = require_regular(directory / (name + '.json'))
        if sha(result_bytes) != case['resultSha256']:
            raise ValueError('A qualified raw scanner result changed')
        result = unique_json(result_bytes)
        expected = set(controls[name.removeprefix('control-')][0]) if name.startswith('control-') else {
            SMALL_TARGET if name == 'small-common' else 'server.js'}
        count = validate_result(result, expected, directory / 'stages' / name, case['exitCode'])
        if count != case['scannedFiles'] or len(result['results']) != case['findingCount']:
            raise ValueError('Raw qualification count differs from its receipt')
        if name.startswith('control-'):
            _, rule = controls[name.removeprefix('control-')]
            suffix = rule.removesuffix('.yaml').replace('/', '.')
            if ({Path(item['path']).name for item in result['results']} != {'unsafe.js'}
                    or any(not item['check_id'].endswith(suffix) for item in result['results'])):
                raise ValueError('The original positive/negative control is not preserved')


def prepare(directory, root, output, core, prefix, runner_temp, wrapper_version):
    directory, root, output, core, prefix, runner_temp = [Path(p).absolute() for p in (
        directory, root, output, core, prefix, runner_temp)]
    if (prefix.resolve() != runner_temp.resolve() / 'semgrep-source-venv'
            or not core.resolve().is_relative_to(prefix.resolve()) or wrapper_version != VERSION):
        raise ValueError('Only the explicitly hash-locked private source-build venv may be used')
    native = require_regular(core, 256 * 1024**2)
    acquisition = verify_acquisition(directory, root, native)
    source, provenance = validate_qualification(directory, native)
    gate = unique_json(require_regular(directory / 'gate-result.json'))
    verify_case_results(directory, root, gate)
    if output.exists() or output.is_symlink() or output.parent.resolve() != output.parent:
        raise ValueError('A new canonical security-results directory is required')
    # Explicit qualification-only evidence. No source-tree recursion, plaintext
    # public artifact, new tool-only upload or redistribution approval occurs.
    permitted = re.compile(r'^(?:gate-result|sourcebuild-[a-z0-9-]+|control-(?:require|sql|loop|async)|server-(?:common|express|script_tag|express_property|express_response)|small-common)\.json$')
    files, total = [], 0
    for file in sorted(directory.iterdir()):
        if not permitted.fullmatch(file.name):
            continue
        data = require_regular(file)
        total += len(data)
        if total > 112 * 1024**2:
            raise ValueError('Source-core proof exceeds the private evidence bound')
        files.append((file.name, data))
    binding = {'format': 'gp-sast-source-core-binding/v1', 'wrapperVersion': VERSION,
        'nativeCoreSha256': sha(native), 'nativeCoreBytes': len(native),
        'sourceCommit': source['commit'], 'limitsBeforeSha256': source['limitsBeforeSha256'],
        'limitsAfterSha256': source['limitsAfterSha256'], 'sourceModified': True,
        'officialReleaseBinary': False, 'qualificationCaseCount': len(gate['cases']),
        'qualificationComplete': True, 'fullProjectScanApproved': False,
        'requirementsSha256': sha(require_regular(root / 'scripts/security/requirements.txt')),
        'toolsConfigurationSha256': sha(require_regular(root / 'scripts/security/tools.json')),
        'corePath': str(core), 'qualificationReceiptSha256': sha(require_regular(directory / 'gate-result.json')),
        'bitIdenticalRebuildVerified': False}
    binding.update(buildInputsSha256=acquisition['buildInputsSha256'], acquisitionMode=acquisition['mode'])
    output.mkdir(mode=0o700)
    for name, data in files:
        with (output / ('sourcecore-' + name)).open('xb') as stream:
            stream.write(data)
    (output / 'source-core-binding.json').write_bytes(canonical(binding))
    return binding


def verify_bound_core(root, output):
    """Recheck actual bytes/raw controls before the ordinary gate uses the core."""
    from semgrep.semgrep_core import SemgrepCore
    runner = Path(os.environ.get('RUNNER_TEMP', '')).absolute()
    prefix = Path(sys.prefix).resolve()
    core = Path(SemgrepCore.path()).absolute()
    if (not os.environ.get('RUNNER_TEMP') or prefix != runner / 'semgrep-source-venv'
            or not core.resolve().is_relative_to(prefix) or importlib.metadata.version('semgrep') != VERSION):
        raise ValueError('The SAST gate requires its hash-locked private source-build venv')
    binding = unique_json(require_regular(output / 'source-core-binding.json'))
    raw = require_regular(core, 256 * 1024**2)
    directory = runner / 'security-source-core-qualification'
    acquisition = verify_acquisition(directory, root, raw)
    source, native = validate_qualification(directory, raw)
    gate = unique_json(require_regular(directory / 'gate-result.json'))
    verify_case_results(directory, root, gate)
    expected = {'format': 'gp-sast-source-core-binding/v1', 'wrapperVersion': VERSION,
        'nativeCoreSha256': sha(raw), 'nativeCoreBytes': len(raw), 'sourceCommit': source['commit'],
        'limitsBeforeSha256': source['limitsBeforeSha256'], 'limitsAfterSha256': source['limitsAfterSha256'],
        'sourceModified': True, 'officialReleaseBinary': False, 'qualificationCaseCount': 10,
        'qualificationComplete': True, 'fullProjectScanApproved': False,
        'requirementsSha256': sha(require_regular(root / 'scripts/security/requirements.txt')),
        'toolsConfigurationSha256': sha(require_regular(root / 'scripts/security/tools.json')),
        'corePath': str(core), 'qualificationReceiptSha256': sha(require_regular(directory / 'gate-result.json')),
        'bitIdenticalRebuildVerified': False}
    expected.update(buildInputsSha256=acquisition['buildInputsSha256'], acquisitionMode=acquisition['mode'])
    if binding != expected:
        raise ValueError('The actual SAST core or raw qualification differs from its binding')
    wrapper = prefix / 'bin/semgrep'
    require_regular(wrapper)
    return {'wrapperExecutable': str(wrapper), **{key: binding[key] for key in ('wrapperVersion', 'nativeCoreSha256', 'nativeCoreBytes',
        'sourceCommit', 'limitsBeforeSha256', 'limitsAfterSha256', 'sourceModified',
        'officialReleaseBinary', 'qualificationCaseCount', 'qualificationComplete', 'bitIdenticalRebuildVerified')}}


def select_scanner(configured, verified):
    # A bare default never resolves through PATH. The externally supplied CLI
    # option may only repeat this already verified absolute venv entrypoint.
    if configured not in ('semgrep', verified):
        raise ValueError('An unqualified scanner override cannot replace the bound private venv CLI')
    return verified


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--qualification', type=Path, required=True)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if sys.prefix == sys.base_prefix or not os.environ.get('RUNNER_TEMP'):
        raise ValueError('An isolated Actions source-build venv is required')
    from semgrep.semgrep_core import SemgrepCore
    try:
        binding = prepare(args.qualification, args.root, args.output, SemgrepCore.path(),
            sys.prefix, os.environ['RUNNER_TEMP'], importlib.metadata.version('semgrep'))
    except Exception as error:
        # A failed cold build still gets the ordinary private incomplete gate
        # receipt. Do not write into a pre-existing/unrelated output directory.
        output = args.output.absolute()
        if not output.exists() and not output.is_symlink() and output.parent.resolve() == output.parent:
            output.mkdir(mode=0o700)
            receipt = {'schemaVersion': 1, 'gate': 'sast', 'checkedAt': dt.datetime.now(dt.timezone.utc).isoformat(),
                'complete': False, 'passed': False, 'status': 'tool_or_coverage_error', 'exitCode': 2,
                'error': str(error)[:1000], 'commands': []}
            (output / 'gate-result.json').write_bytes(canonical(receipt))
            failure = args.qualification / 'gate-result.json'
            if failure.is_file() and not failure.is_symlink():
                (output / 'sourcecore-gate-result.json').write_bytes(require_regular(failure))
        print('Source-core qualification is incomplete; the SAST gate remains failed.')
        raise SystemExit(2) from None
    print(json.dumps({'format': binding['format'], 'qualificationComplete': True,
        'qualificationCaseCount': binding['qualificationCaseCount'], 'fullProjectScanApproved': False}))


if __name__ == '__main__':
    main()

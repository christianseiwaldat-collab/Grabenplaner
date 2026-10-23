"""Build one narrowly patched upstream core; qualification only, never a gate.

The official hash-locked Python wrapper is unchanged. Its native core is replaced
only inside a disposable virtual environment. Every ordinary Semgrep completeness
check remains enabled; this module grants no security-gate approval.
"""
import argparse
import base64
import hashlib
import json
import lzma
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

from gates import check_sast_result, read, sha, source_files, stage_sources, write
from sast_profile import build_rule_profiles, PROFILE_TIMEOUTS
from diagnose_sast_fixpoints import REQUIRE_RULE, SQL_RULE, SMALL_TARGET

UPSTREAM = 'https://github.com/semgrep/semgrep.git'
TAG = 'v1.181.0'
TAG_OBJECT = '77a9477dbb1d7e8780d6113adc7c8204dac83150'
COMMIT = '72d3525fe7e02f486428386078f192f8c4756804'
VERSION = '1.181.0'
SUBMODULE = ('tests/semgrep-rules', '40b8c63f75dc7c22c8a77482d73bfb864b146f7e')
LIMITS = 'src/configuring/Limits_semgrep.ml'
LIMITS_BEFORE = '3ed5f57cd546ab78208a944bd35b6e974116d6aa1d59f1fe318d5a087f5fdeb1'
LIMITS_AFTER = '92b07fd747b597a3e5eb59b3325c61812bb29e2aef1ee848251498feabf3f526'
DOCKERFILE = '3e652845bad6453f4583c843be19cc883fc44a995d53830903ab0127da35c981'
ALPINE = 'alpine@sha256:3d67941fed5ae436b2bb9791cb3f50a252441c7706bbc5b4e738936df8ff8306'
COMPILER = '4046c817ed2ed5c2431300902d1bd306230bf3dd'
OPAM_REPOSITORY = '78d29aba187e8362b8ab86c189790c0af9153d4b'
PATCH_FROM = b'let taint_FIXPOINT_TIMEOUT = 0.2'
PATCH_TO = b'let taint_FIXPOINT_TIMEOUT = 30.0'


def digest(content):
    return hashlib.sha256(content).hexdigest()


def approved_patch(content):
    if digest(content) != LIMITS_BEFORE or content.count(PATCH_FROM) != 1:
        raise ValueError('Upstream limit bytes differ from the reviewed source')
    result = content.replace(PATCH_FROM, PATCH_TO)
    if digest(result) != LIMITS_AFTER:
        raise ValueError('Unreviewed source patch')
    return result


def pinned_recipe(content):
    if digest(content) != DOCKERFILE or content.count(b'FROM alpine:3.23 ') != 2:
        raise ValueError('Unreviewed upstream Dockerfile')
    # Infrastructure-only derived recipe, outside the Git source tree. The
    # selected official target has exactly this external base image dependency.
    return content.replace(b'FROM alpine:3.23 ', ('FROM ' + ALPINE + ' ').encode())


def assert_delta(paths, content):
    if paths != [LIMITS] or digest(content) != LIMITS_AFTER:
        raise ValueError('Source changes exceed the single reviewed budget line')


def validate_result(result, expected, stage, exit_code):
    # Strengthen schema/exit validation around the unchanged Semgrep gate check.
    if not isinstance(result, dict) or result.get('version') != VERSION:
        raise ValueError('Unpinned result version')
    if result.get('errors') != [] or not isinstance(result.get('results'), list):
        raise ValueError('Missing or malformed result arrays')
    paths = result.get('paths')
    if not isinstance(paths, dict) or not isinstance(paths.get('scanned'), list):
        raise ValueError('Missing target evidence')
    scanned = paths['scanned']
    if len(scanned) != len(set(scanned)):
        raise ValueError('Duplicate scanner target evidence')
    for field in ('skipped',):
        if field in paths and not isinstance(paths[field], list):
            raise ValueError('Malformed skipped target evidence')
    if 'skipped_rules' in result and not isinstance(result['skipped_rules'], list):
        raise ValueError('Malformed skipped rule evidence')
    count = check_sast_result(result, expected, stage)
    if exit_code not in (0, 1) or ((exit_code == 1) != bool(result['results'])):
        raise ValueError('Inconsistent process exit and finding evidence')
    return count


def subprocess_environment():
    environment = dict(os.environ)
    for key in ('SEMGREP_APP_TOKEN', 'SEMGREP_APP_URL', 'SEMGREP_API_TOKEN'):
        environment.pop(key, None)
    environment.update(SEMGREP_SEND_METRICS='off', SEMGREP_ENABLE_VERSION_CHECK='0',
                       GIT_TERMINAL_PROMPT='0', GIT_ALLOW_PROTOCOL='https',
                       GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL=os.devnull)
    return environment


class Commands:
    def __init__(self, output):
        self.output, self.records = output, []

    def run(self, args, label, cwd=None, timeout=600, acceptable=(0,)):
        started = time.monotonic()
        try:
            result = subprocess.run([str(arg) for arg in args], cwd=cwd,
                                    env=subprocess_environment(), capture_output=True,
                                    timeout=timeout, check=False)
            record = {'label': label, 'argv': [str(a) for a in args],
                      'exitCode': result.returncode,
                      'stdout': result.stdout.decode('utf8', errors='replace'),
                      'stderr': result.stderr.decode('utf8', errors='replace'),
                      'elapsedSeconds': time.monotonic() - started}
            write(self.output / ('sourcebuild-process-%02d.json' % len(self.records)), record)
            self.records.append({k: v for k, v in record.items() if k not in ('stdout', 'stderr')})
            if result.returncode not in acceptable:
                raise ValueError('Source-build command failed: ' + label)
            return result.stdout
        except subprocess.TimeoutExpired as error:
            write(self.output / ('sourcebuild-process-%02d.json' % len(self.records)), {
                'label': label, 'timedOut': True,
                'stdout': (error.stdout or b'').decode('utf8', errors='replace'),
                'stderr': (error.stderr or b'').decode('utf8', errors='replace')})
            raise ValueError('Source-build command timed out: ' + label) from None


def checkout_and_patch(work, output, commands):
    source = work / 'upstream'
    commands.run(['git', 'clone', '--no-checkout', '--depth=1', '--branch', TAG, '--filter=blob:none', UPSTREAM, source], 'clone', timeout=900)
    commands.run(['git', 'fetch', '--depth=1', 'origin', 'refs/tags/' + TAG], 'fetch-tag', cwd=source)
    tag = commands.run(['git', 'rev-parse', 'FETCH_HEAD'], 'tag-object', cwd=source).decode().strip()
    commit = commands.run(['git', 'rev-parse', 'FETCH_HEAD^{}'], 'tag-commit', cwd=source).decode().strip()
    if tag != TAG_OBJECT or commit != COMMIT:
        raise ValueError('Upstream tag/commit identity drift')
    commands.run(['git', 'checkout', '--detach', COMMIT], 'checkout', cwd=source)
    commands.run(['git', '-c', 'protocol.file.allow=never', '-c', 'protocol.ext.allow=never',
                  'submodule', 'update', '--init', '--recursive', '--depth=1'], 'submodules', cwd=source, timeout=900)
    modules = commands.run(['git', 'submodule', 'status', '--recursive'], 'submodule-status', cwd=source).decode().splitlines()
    if len(modules) != 1 or not modules[0].startswith(' ' + SUBMODULE[1] + ' ' + SUBMODULE[0] + ' '):
        raise ValueError('Unexpected or incomplete upstream submodule closure')
    if commands.run(['git', 'status', '--porcelain', '--untracked-files=all'], 'clean-source', cwd=source).strip():
        raise ValueError('Dirty upstream before the approved patch')
    limits = source / LIMITS
    limits.write_bytes(approved_patch(limits.read_bytes()))
    paths = commands.run(['git', 'diff', '--name-only'], 'patch-scope', cwd=source).decode().splitlines()
    assert_delta(paths, limits.read_bytes())
    diff = commands.run(['git', 'diff', '--binary', '--', LIMITS], 'source-patch', cwd=source)
    recipe = work / 'pinned-upstream.Dockerfile'
    recipe.write_bytes(pinned_recipe((source / 'Dockerfile').read_bytes()))
    files = []
    for name in commands.run(['git', 'ls-files', '-z', '--recurse-submodules'], 'source-files', cwd=source).decode().split('\0'):
        if not name:
            continue
        path = source / name
        if path.is_symlink():
            content = os.readlink(path).encode(); kind = 'symlink-text'
        elif path.is_file():
            content = path.read_bytes(); kind = 'regular'
        else:
            raise ValueError('Unexpected upstream tracked file type')
        files.append({'path': name, 'kind': kind, 'bytes': len(content), 'sha256': digest(content)})
    write(output / 'sourcebuild-source-inventory.json', files)
    license_bytes = (source / 'LICENSE').read_bytes()
    write(output / 'sourcebuild-license.json', {'upstreamLicensePath': 'LICENSE',
          'upstreamLicenseSha256': digest(license_bytes), 'upstreamLicenseText': license_bytes.decode(),
          'upstreamOpamLicense': 'LGPL-2.1-only', 'sourceModified': True,
          'correspondingSource': UPSTREAM, 'sourceCommit': COMMIT, 'patchUtf8': diff.decode(),
          'redistribution': 'Private qualification artifact; retain this source commit, exact patch and toolchain inventory with the binary.'})
    write(output / 'sourcebuild-source-provenance.json', {'repository': UPSTREAM, 'tag': TAG,
          'tagObject': TAG_OBJECT, 'commit': COMMIT, 'tagSignatureVerified': False,
          'submodules': modules, 'changedSourcePaths': paths, 'patchSha256': digest(diff),
          'limitsBeforeSha256': LIMITS_BEFORE, 'limitsAfterSha256': sha(limits),
          'onlySemanticChange': 'taint_FIXPOINT_TIMEOUT: 0.2 seconds -> 30.0 seconds',
          'variableSetGraphLimitsUnchanged': True, 'upstreamDockerfileSha256': DOCKERFILE,
          'derivedRecipeSha256': sha(recipe), 'recipeChange': 'Pin the selected official target base image to the independently observed linux/amd64 OCI manifest digest.',
          'officialTarget': 'semgrep-core-container', 'baseImage': ALPINE,
          'compilerSourceCommit': COMPILER, 'opamRepositoryCommit': OPAM_REPOSITORY,
          'bitIdenticalRebuildVerified': False})
    return source, recipe


def build_core(work, output, tools, source, recipe, commands):
    iid = work / 'image-id'
    commands.run(['docker', 'build', '--platform', 'linux/amd64', '--target', 'semgrep-core-container',
                  '--build-arg', 'VCS_REF_HEAD_REVISION=' + COMMIT, '--iidfile', iid, '-f', recipe, source],
                 'official-core-build', timeout=10800)
    image = iid.read_text().strip()
    if not image.startswith('sha256:') or len(image) != 71:
        raise ValueError('Invalid built image identity')
    container = commands.run(['docker', 'create', image], 'create-export-container').decode().strip()
    if not container or any(c not in '0123456789abcdef' for c in container):
        raise ValueError('Invalid owned export container')
    binary = work / 'semgrep-core-1.181.0-budget30'
    try:
        commands.run(['docker', 'cp', container + ':/src/semgrep/_build/default/src/main/Main.exe', binary], 'export-core')
    finally:
        commands.run(['docker', 'rm', container], 'remove-export-container')
    binary.chmod(0o700)
    version = commands.run([binary, '-version'], 'built-core-version').decode().strip()
    compiler = commands.run([binary, '-ocaml_version'], 'built-compiler-version').decode().strip()
    if VERSION not in version or COMPILER not in compiler:
        raise ValueError('Native version/compiler provenance mismatch')
    packages = commands.run(['docker', 'run', '--rm', image, 'apk', 'info', '-vv'], 'alpine-installed-packages').decode()
    opam = commands.run(['docker', 'run', '--rm', image, 'opam', 'list', '--installed', '--columns=name,version', '--color=never'], 'opam-installed-packages').decode()
    pins = commands.run(['docker', 'run', '--rm', image, 'opam', 'pin', 'list', '--normalise'], 'opam-source-pins').decode()
    if COMPILER not in pins:
        raise ValueError('Built compiler pin not recorded')
    sbom = output / 'sourcebuild-toolchain-sbom.json'
    commands.run([tools / 'syft', 'scan', 'docker:' + image, '-o', 'cyclonedx-json=' + str(sbom)], 'build-sbom', timeout=600)
    data = read(sbom)
    if data.get('bomFormat') != 'CycloneDX' or not data.get('components'):
        raise ValueError('Missing build toolchain SBOM')
    compressed = lzma.compress(binary.read_bytes(), preset=6)
    if len(compressed) > 60 * 1024 * 1024:
        raise ValueError('Native diagnostic artifact exceeds retention bound')
    write(output / 'sourcebuild-native-core.json', {'format': 'gp-diagnostic-native-binary-xz-v1',
          'filename': binary.name, 'sourceModified': True, 'officialReleaseBinary': False,
          'sha256': sha(binary), 'bytes': binary.stat().st_size, 'xzSha256': digest(compressed),
          'xzBase64': base64.b64encode(compressed).decode()})
    write(output / 'sourcebuild-native-provenance.json', {'imageId': image, 'baseImage': ALPINE,
          'binarySha256': sha(binary), 'binaryBytes': binary.stat().st_size, 'versionOutput': version,
          'compilerOutput': compiler, 'apkPackages': packages, 'opamPackages': opam, 'opamPins': pins,
          'sbomSha256': sha(sbom), 'officialReleaseBinary': False, 'sourceModified': True,
          'bitIdenticalRebuildVerified': False})
    return binary


def replace_venv_core(binary, output, commands):
    prefix = Path(sys.prefix).resolve()
    if prefix == Path(sys.base_prefix).resolve():
        raise ValueError('Only a disposable virtual environment may be changed')
    runner_temp = os.environ.get('RUNNER_TEMP')
    if not runner_temp or prefix != Path(runner_temp).resolve() / 'semgrep-source-venv':
        raise ValueError('Only the explicitly prepared runner diagnostic venv may be changed')
    from semgrep.semgrep_core import SemgrepCore
    core = SemgrepCore.path()
    if core.is_symlink() or not core.is_file() or not core.resolve().is_relative_to(prefix):
        raise ValueError('The wrapper core is not a private venv file')
    wrapper = prefix / 'bin/semgrep'
    if commands.run([wrapper, '--version'], 'python-wrapper-version').decode().strip() != VERSION:
        raise ValueError('The original hash-locked wrapper version differs')
    before = sha(core)
    original_version = commands.run([core, '-version'], 'official-wheel-native-version').decode().strip()
    original_compiler = commands.run([core, '-ocaml_version'], 'official-wheel-native-compiler').decode().strip()
    shutil.copyfile(binary, core); core.chmod(0o700)
    if sha(core) != sha(binary):
        raise ValueError('Private native core copy drift')
    write(output / 'sourcebuild-wrapper-binding.json', {'pythonVersion': sys.version,
          'pythonWrapperVersion': VERSION, 'wrapperSourceChanged': False,
          'venvOnly': True, 'officialWheelCoreSha256': before,
          'officialWheelNativeVersion': original_version, 'officialWheelCompilerVersion': original_compiler,
          'diagnosticCoreSha256': sha(core), 'sourceModified': True,
          'officialReleaseBinary': False})
    return wrapper


def control_sources():
    header = 'const express=require("express"); const {Client}=require("pg"); const db=new Client(); const app=express();\n'
    safe = header + 'app.get("/ok",function(req,res){db.query("SELECT * FROM entries WHERE id=$1",[req.query.id]);});\n'
    chain = ';'.join('a%d=a%d' % (n, n - 1) for n in range(8, 0, -1))
    return [
        ('require', REQUIRE_RULE, {'unsafe.js': 'function load(input){return require(input);}\n',
                                'safe.js': 'function load(input){return require("node:fs");}\n'}),
        ('sql', SQL_RULE, {'unsafe.js': header + 'app.get("/bad",function(req,res){db.query("SELECT * FROM entries WHERE id="+req.query.id);});\n', 'safe.js': safe}),
        ('loop', SQL_RULE, {'unsafe.js': header + 'app.get("/loop",function(req,res){let a0=req.query.id,a1,a2,a3,a4,a5,a6,a7,a8;for(let i=0;i<12;i++){' + chain + ';} db.query("SELECT * FROM entries WHERE id="+a8);});\n', 'safe.js': safe}),
        ('async', SQL_RULE, {'unsafe.js': header + 'app.get("/async",async function(req,res){await Promise.resolve();await Promise.all([db.query("SELECT * FROM entries WHERE id="+req.query.id),Promise.resolve()]);});\n', 'safe.js': safe}),
    ]


def diagnose(root, tools, output, wrapper, commands):
    config = read(root / 'scripts/security/tools.json')
    manifest = read(tools / 'rules-manifest.json')
    if manifest['commit'] != config['rules']['commit'] or manifest['archiveSha256'] != config['rules']['sha256']:
        raise ValueError('Rule bundle identity differs from security CI')
    profiles = build_rule_profiles(tools, output / 'profiles', manifest)
    inventory = {item['path']: item for item in source_files(root)}
    rules = {row['path']: row for rows in profiles['groups'].values() for row in rows}
    cases = [('control-' + name, [], [rules[rule]], controls, rule)
             for name, rule, controls in control_sources()]
    cases.extend(('server-' + name, ['server.js'], rows, None, None)
                 for name, rows in profiles['groups'].items())
    cases.append(('small-common', [SMALL_TARGET], profiles['groups']['common'], None, None))
    write(output / 'sourcebuild-diagnostic-plan.json', {'diagnosticOnly': True,
          'securityGatePassed': False, 'wholeUnmodifiedFiles': [inventory['server.js'], inventory[SMALL_TARGET]],
          'ruleManifestSha256': sha(tools / 'rules-manifest.json'), 'profiles': profiles,
          'cases': [{'name': n, 'targets': names, 'rules': rows, 'syntheticControl': control is not None}
                    for n, names, rows, control, _ in cases]})
    records, started = [], time.monotonic()
    for name, names, rows, controls, control_rule in cases:
        stage = output / 'stages' / name
        if controls:
            stage.mkdir(parents=True)
            for filename, text in controls.items():
                (stage / filename).write_text(text, encoding='utf8')
            expected = set(controls)
        else:
            stage_sources(root, stage, [inventory[p] for p in names]); expected = set(names)
        rule_dir = output / 'case-rules' / name
        for row in rows:
            destination = rule_dir / row['path']; destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(tools / 'rules' / row['path'], destination)
            if sha(destination) != row['sha256']:
                raise ValueError('Copied rule bytes drifted')
        result_path = output / (name + '.json')
        profile = name.removeprefix('server-')
        timeout = PROFILE_TIMEOUTS.get(profile, 120)
        remaining = 2400 - (time.monotonic() - started)
        if remaining <= 0:
            raise ValueError('Diagnostic wall budget exhausted')
        args = [wrapper, 'scan', '--config', rule_dir, '--json', '--output', result_path,
                '--metrics', 'off', '--disable-version-check', '--disable-nosem', '--no-git-ignore',
                '--time', '--max-target-bytes', '0', '--timeout', str(timeout), '--timeout-threshold', '0',
                '--max-memory', '4096', '--jobs', '1', '--strict', '--error', stage]
        before = len(commands.records)
        commands.run(args, name, timeout=min(remaining, 900), acceptable=(0, 1, 2, 3))
        exit_code = commands.records[before]['exitCode']
        result = read(result_path)
        count = validate_result(result, expected, stage, exit_code)
        control_passed = None
        if controls:
            findings = result['results']
            control_passed = bool(findings) and {Path(item['path']).name for item in findings} == {'unsafe.js'}
            suffix = control_rule.removesuffix('.yaml').replace('/', '.')
            control_passed = control_passed and all(item['check_id'].endswith(suffix) for item in findings)
            if not control_passed:
                raise ValueError('Positive/negative source-build control failed: ' + name)
        records.append({'name': name, 'executionEvidenceValid': True, 'analysisCompleteForCase': True,
                        'scannedFiles': count, 'findingCount': len(result['results']),
                        'fixpointTimeoutCount': len(result['time']['fixpoint_timeouts']),
                        'fixpointFieldPresent': True, 'controlPassed': control_passed,
                        'resultSha256': sha(result_path), 'exitCode': exit_code})
    return records


def run(root, tools, work, output):
    if output.exists() or work.exists():
        raise ValueError('Source-build work/output directories must be new')
    output.mkdir(parents=True); work.mkdir(parents=True)
    commands, started = Commands(output), time.monotonic()
    write(output / 'gate-result.json', {'schemaVersion': 1, 'gate': 'sast-diagnostic',
          'diagnosticOnly': True, 'securityGatePassed': False, 'complete': False, 'passed': False,
          'diagnosticExecutionComplete': False, 'controlsPassed': False, 'cases': []})
    try:
        if sys.platform != 'linux' or shutil.disk_usage(work).free < 20 * 1024**3:
            raise ValueError('Native Linux with at least 20 GiB free build space is required')
        source, recipe = checkout_and_patch(work, output, commands)
        binary = build_core(work, output, tools, source, recipe, commands)
        wrapper = replace_venv_core(binary, output, commands)
        records = diagnose(root, tools, output, wrapper, commands)
        assert_delta(commands.run(['git', 'diff', '--name-only'], 'final-patch-scope', cwd=source).decode().splitlines(),
                     (source / LIMITS).read_bytes())
        write(output / 'gate-result.json', {'schemaVersion': 1, 'gate': 'sast-diagnostic',
              'diagnosticOnly': True, 'securityGatePassed': False, 'complete': False, 'passed': False,
              'status': 'diagnostic_only', 'diagnosticExecutionComplete': True, 'controlsPassed': True,
              'scanner': 'semgrep-source-budget-diagnostic', 'scannerVersion': VERSION,
              'sourceModified': True, 'officialReleaseBinary': False,
              'nativeCoreSha256': sha(binary), 'elapsedSeconds': time.monotonic() - started, 'cases': records})
        print(json.dumps({'diagnosticOnly': True, 'securityGatePassed': False,
                          'executionComplete': True, 'controlsPassed': True, 'cases': len(records)}))
        return 0
    except Exception as error:
        write(output / 'gate-result.json', {'schemaVersion': 1, 'gate': 'sast-diagnostic',
              'diagnosticOnly': True, 'securityGatePassed': False, 'complete': False, 'passed': False,
              'status': 'diagnostic_only', 'diagnosticExecutionComplete': False, 'controlsPassed': False,
              'error': str(error), 'elapsedSeconds': time.monotonic() - started, 'cases': []})
        print('Source-build qualification incomplete; private evidence retained.')
        return 2


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    for argument in ('root', 'tools', 'work', 'output'):
        parser.add_argument('--' + argument, type=Path, required=True)
    arguments = parser.parse_args()
    raise SystemExit(run(arguments.root.resolve(), arguments.tools.resolve(),
                         arguments.work.resolve(), arguments.output.resolve()))

"""Diagnostic only: use the release scan profiles on changed whole files."""
import json
import os
from pathlib import Path, PurePosixPath
import subprocess
import sys

from build_semgrep_source import Commands, replace_venv_core
from gates import check_sast_result, source_files, stage_sources
from semgrep_core_tool import fetch, unique_json, validate_pin
from source_core_acquisition import reuse_approval
from source_core_identity import canonical, inputs
from sast_dispositions import canonical_rule_id, finding_identity, scanner_position
from sast_profile import PROFILE_TIMEOUTS, build_rule_profiles, source_partition

root = Path.cwd().resolve()
tools, output = (Path(value).resolve() for value in sys.argv[1:])
output.mkdir(parents=True, exist_ok=False)
receipt = output / 'gate-result.json'
receipt.write_text(json.dumps({
    'gate': 'sast-diagnostic', 'diagnosticOnly': True, 'passed': False,
    'complete': False, 'diagnosticExecutionComplete': False
}), encoding='utf-8')
pin_bytes = (root / '.github/security-semgrep-core-pin.json').read_bytes()
pin = validate_pin(unique_json(pin_bytes))
expected_repo = {'fullName': os.environ['GITHUB_REPOSITORY'], 'id': int(os.environ['GITHUB_REPOSITORY_ID'])}
if canonical(pin) != pin_bytes or pin['repository'] != expected_repo:
    raise ValueError('Invalid reviewed compiler pin or repository')
identity = inputs(root)
if pin['buildInputs'] != identity and reuse_approval(root, pin, pin_bytes, identity) is None:
    raise ValueError('The pinned compiler is not approved for this diagnostic input')
core, _, _ = fetch(pin, os.environ['GITHUB_TOKEN'], with_contents=True)
binary = output.parent / 'release-diagnostic-native'
binary.write_bytes(core)
binary.chmod(0o700)
scanner = replace_venv_core(binary, output, Commands(output))
base = '853f1432bc31748e63c7686c4ef2fd58ad238228'
changed = set(subprocess.check_output(
    ['git', 'diff', '--name-only', '-z', base, 'HEAD']
).decode().split('\0'))
suffixes = {'.js', '.cjs', '.mjs', '.ts', '.jsx', '.tsx'}
entries = [entry for entry in source_files(root)
           if PurePosixPath(entry['path']).suffix in suffixes
           and PurePosixPath(entry['path']).parts[0] not in {'test', 'tests', 'test-support'}
           and not entry['path'].startswith('public/vendor/')]
partitions = source_partition(root, entries)
manifest = json.loads((tools / 'rules-manifest.json').read_text(encoding='utf-8'))
profiles = build_rule_profiles(tools, output.parent / 'release-rule-profiles', manifest)
findings = []
scanned = set()
for name, candidates in partitions.items():
    targets = {entry['path']: entry for entry in candidates if entry['path'] in changed}
    if not targets:
        continue
    stage = output.parent / ('release-targets-' + name)
    stage_sources(root, stage, targets.values())
    result_path = output / (name + '.json')
    rules = output.parent / 'release-rule-profiles' / name / 'rules'
    with (output / (name + '.log')).open('wb') as log:
        run = subprocess.run([
            str(scanner), 'scan', '--config', str(rules), '--json', '--output', str(result_path),
            '--metrics', 'off', '--disable-version-check', '--disable-nosem', '--no-git-ignore',
            '--time', '--max-target-bytes', '0', '--timeout', str(PROFILE_TIMEOUTS[name]),
            '--timeout-threshold', '0', '--max-memory', '4096', '--jobs', '1', '--strict',
            '--error', str(stage)
        ], stdout=log, stderr=subprocess.STDOUT)
    raw = json.loads(result_path.read_text(encoding='utf-8'))
    check_sast_result(raw, targets, stage)
    if run.returncode != (1 if raw['results'] else 0):
        raise ValueError(f'Inconsistent {name} scan result')
    scanned.update(targets)
    for item in raw['results']:
        path = Path(item['path']).resolve().relative_to(stage).as_posix()
        rule = canonical_rule_id(item['check_id'], profiles['canonicalRuleIds'])
        start, end = (scanner_position(item[key]) for key in ('start', 'end'))
        findings.append({
            'rule': rule, 'path': path, 'start': start, 'end': end,
            'sourceSha256': targets[path]['sha256'],
            'fingerprint': finding_identity(rule, path, start, end)
        })
    print(f'{name}: {len(targets)} changed sources, {len(raw["results"])} findings', flush=True)
if not scanned or len({item['fingerprint'] for item in findings}) != len(findings):
    raise ValueError('Empty diagnostic or duplicate findings')
(output / 'release-findings.json').write_text(json.dumps({
    'commit': os.environ['GITHUB_SHA'],
    'targets': {entry['path']: entry['sha256'] for entry in entries if entry['path'] in scanned},
    'findings': findings
}, indent=2), encoding='utf-8')
receipt.write_text(json.dumps({
    'gate': 'sast-diagnostic', 'diagnosticOnly': True, 'passed': False,
    'complete': False, 'diagnosticExecutionComplete': True
}), encoding='utf-8')

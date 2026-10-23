"""Bounded, read-only Semgrep experiments; never a passing security gate."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import time

from gates import read, sha, source_files, stage_sources, write
from sast_profile import build_rule_profiles, PROFILE_TIMEOUTS
from prepare_upload import identity, regular_bytes

SMALL_TARGET = 'public/sales-bwl-actions.js'
REQUIRE_RULE = 'javascript/lang/security/audit/detect-non-literal-require.yaml'
SQL_RULE = 'javascript/express/security/injection/tainted-sql-string.yaml'
PROFILE_NAMES = ('common', 'express')
WALL_SECONDS = 1800


def rule_modes(tools, rows):
    # Reuse the parser already present in the hash-locked Semgrep graph.
    from ruamel.yaml import YAML
    yaml = YAML(typ='safe')
    result = []
    for row in rows:
        content = (tools / 'rules' / row['path']).read_bytes()
        if hashlib.sha256(content).hexdigest() != row['sha256']:
            raise ValueError('Rule bytes changed before diagnostic selection')
        rules = yaml.load(content).get('rules')
        if not isinstance(rules, list) or len(rules) != row['ruleCount']:
            raise ValueError('Unexpected diagnostic rule structure')
        if any(rule.get('mode', 'search') == 'taint' for rule in rules):
            result.append(row)
    return result


def result_summary(result, expected, stage, exit_code):
    scanned = [Path(p).resolve().relative_to(stage.resolve()).as_posix()
               for p in result.get('paths', {}).get('scanned', [])]
    fixpoints = result.get('time', {}).get('fixpoint_timeouts')
    if not isinstance(fixpoints, list):
        raise ValueError('Missing fixpoint diagnostic evidence')
    coverage = len(scanned) == len(expected) and set(scanned) == set(expected)
    errors = result.get('errors', [])
    skipped = result.get('paths', {}).get('skipped', [])
    skipped_rules = result.get('skipped_rules', [])
    findings = result.get('results', [])
    consistent = exit_code in (0, 1) and ((exit_code == 1) == bool(findings))
    return {'targetCoverageComplete': coverage, 'topLevelErrors': len(errors),
            'skippedTargets': len(skipped), 'skippedRules': len(skipped_rules),
            'fixpointTimeoutCount': len(fixpoints), 'findingCount': len(findings),
            'executionEvidenceValid': coverage and not errors and not skipped and not skipped_rules and consistent,
            'analysisCompleteForCase': coverage and not errors and not skipped and not skipped_rules and consistent and not fixpoints}


def run(root, tools, output, semgrep='semgrep'):
    if output.exists():
        raise ValueError('Diagnostic output directory must be new')
    output.mkdir(parents=True)
    started = time.monotonic()
    config = read(root / 'scripts/security/tools.json')
    upstream = read(tools / 'rules-manifest.json')
    if upstream['commit'] != config['rules']['commit'] or upstream['archiveSha256'] != config['rules']['sha256']:
        raise ValueError('Unpinned diagnostic rules')
    profiles = build_rule_profiles(tools, output / 'profiles', upstream)
    version = subprocess.run([semgrep, '--version'], capture_output=True, timeout=30, check=True).stdout.decode().strip()
    if version != config['semgrep']['version']:
        raise ValueError('Unpinned diagnostic scanner')
    (output / 'semgrep-version.stdout').write_text(version + '\n', encoding='utf8')
    from semgrep.semgrep_core import SemgrepCore
    core = Path(SemgrepCore.path())
    help_result = subprocess.run([str(core), '-help'], capture_output=True, timeout=30, check=False)
    write(output / 'native-core-help.json', {'scannerVersion': version,
          'coreExecutableSha256': sha(core), 'exitCode': help_result.returncode,
          'stdout': help_result.stdout.decode('utf8', errors='replace'),
          'stderr': help_result.stderr.decode('utf8', errors='replace'),
          'scope': 'Native pinned core option inventory only; no modified binary or analysis options.'})
    inventory = {row['path']: row for row in source_files(root)}
    selected = [inventory[p] for p in (SMALL_TARGET, 'server.js')]
    write(output / 'diagnostic-targets.json', selected)
    taint_rows = rule_modes(tools, profiles['groups']['express'])
    if not taint_rows or not any(row['path'] == SQL_RULE for row in taint_rows):
        raise ValueError('Mandatory Express taint rule missing')
    rule_by_path = {row['path']: row for rows in profiles['groups'].values() for row in rows}
    cases = [
        ('small-common-full', [SMALL_TARGET], profiles['groups']['common'], None),
        ('small-require-single', [SMALL_TARGET], [rule_by_path[REQUIRE_RULE]], None),
        ('server-express-full', ['server.js'], profiles['groups']['express'], None),
        ('server-express-taint', ['server.js'], taint_rows, None),
    ]
    cases.extend((f'server-taint-{index:02d}', ['server.js'], [row], None)
                 for index, row in enumerate(taint_rows, 1))
    cases.extend([
        ('controls-require', [], [rule_by_path[REQUIRE_RULE]], {
            'unsafe.js': 'function load(input) { return require(input); }\n',
            'safe.js': "function load(input) { return require('node:fs'); }\n"}),
        ('controls-sql', [], [rule_by_path[SQL_RULE]], {
            'unsafe.js': 'const express = require("express"); const { Client } = require("pg"); const db = new Client(); const app = express();\n'
                         'app.get("/entries", function unsafe(req, res) { const sql = "SELECT * FROM entries WHERE id=" + req.query.id; db.query(sql); res.send("ok"); });\n',
            'safe.js': 'const express = require("express"); const { Client } = require("pg"); const db = new Client(); const app = express();\n'
                       'app.get("/entries", function safe(req, res) { db.query("SELECT * FROM entries WHERE id=$1", [req.query.id]); res.send("ok"); });\n'}),
    ])
    # Establish the unsafe/safe controls before spending the bounded budget on
    # large exact-source cases. Exhaustion remains an incomplete diagnostic.
    cases = [case for case in cases if case[3] is not None] + [case for case in cases if case[3] is None]
    write(output / 'diagnostic-plan.json', {'diagnosticOnly': True, 'securityGatePassed': False,
          'sourceTargets': selected, 'ruleManifestSha256': sha(tools / 'rules-manifest.json'),
          'expressTaintRuleFiles': taint_rows,
          'cases': [{'name': name, 'targets': names, 'rules': rows, 'syntheticControl': control is not None}
                    for name, names, rows, control in cases]})
    records = []
    controls_passed = True
    execution_complete = True
    for name, names, rules, controls in cases:
        remaining = WALL_SECONDS - (time.monotonic() - started)
        if remaining <= 30:
            execution_complete = False
            break
        stage = output / 'stages' / name
        if controls:
            stage.mkdir(parents=True)
            for filename, text in controls.items():
                (stage / filename).write_text(text, encoding='utf8')
            expected = set(controls)
        else:
            stage_sources(root, stage, [inventory[p] for p in names])
            expected = set(names)
        rule_dir = output / 'case-rules' / name
        for row in rules:
            destination = rule_dir / row['path']
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(tools / 'rules' / row['path'], destination)
            if sha(destination) != row['sha256']:
                raise ValueError('Diagnostic rule copy drift')
        result_path = output / (name + '.json')
        command = [semgrep, 'scan', '--config', str(rule_dir), '--json', '--output', str(result_path),
                   '--metrics', 'off', '--disable-version-check', '--disable-nosem', '--no-git-ignore',
                   '--max-target-bytes', '0', '--timeout', str(PROFILE_TIMEOUTS['express']),
                   '--timeout-threshold', '0', '--max-memory', '4096', '--jobs', '1', '--strict', '--error', str(stage)]
        began = time.monotonic()
        try:
            completed = subprocess.run(command, capture_output=True, timeout=min(360, remaining - 10), check=False)
            (output / (name + '.stdout')).write_bytes(completed.stdout)
            (output / (name + '.stderr')).write_bytes(completed.stderr)
            raw = read(result_path)
            if raw['version'] != version:
                raise ValueError('Diagnostic result scanner mismatch')
            summary = result_summary(raw, expected, stage, completed.returncode)
            control_passed = None
            if controls:
                detected = {Path(finding['path']).name for finding in raw['results']}
                control_passed = summary['analysisCompleteForCase'] and detected == {'unsafe.js'}
                controls_passed = controls_passed and control_passed
            records.append({'name': name, 'argv': command, 'exitCode': completed.returncode,
                            'elapsedSeconds': time.monotonic() - began, 'resultSha256': sha(result_path),
                            'ruleFiles': rules, 'controlPassed': control_passed, **summary})
            execution_complete = execution_complete and summary['executionEvidenceValid']
        except subprocess.TimeoutExpired:
            execution_complete = False
            records.append({'name': name, 'executionEvidenceValid': False, 'caseWallTimeout': True})
    execution_complete = execution_complete and len(records) == len(cases)
    receipt = {'schemaVersion': 1, 'gate': 'sast-diagnostic', 'diagnosticOnly': True,
               'complete': False, 'passed': False, 'securityGatePassed': False,
               'status': 'diagnostic_only', 'diagnosticExecutionComplete': execution_complete,
               'controlsPassed': controls_passed and all(any(r['name'] == name for r in records) for name in ('controls-require', 'controls-sql')),
               'scannerVersion': version, 'ruleCommit': upstream['commit'],
               'elapsedSeconds': time.monotonic() - started, 'cases': records,
               'scope': 'Exact complete source files and unchanged pinned rules in independent processes. These selected experiments do not provide the full source/rule coverage of the security gate.'}
    write(output / 'gate-result.json', receipt)
    print(json.dumps({'diagnosticOnly': True, 'securityGatePassed': False,
                      'executionComplete': execution_complete, 'controlsPassed': receipt['controlsPassed'], 'cases': len(records)}))
    return 0 if execution_complete and receipt['controlsPassed'] else 2


def publish(private, public, key):
    receipt_bytes = regular_bytes(private / 'gate-result.json')
    receipt = json.loads(receipt_bytes)
    if receipt.get('gate') != 'sast-diagnostic' or receipt.get('diagnosticOnly') is not True or receipt.get('securityGatePassed') is not False or receipt.get('complete') is not False or receipt.get('passed') is not False:
        raise ValueError('Diagnostic evidence must never claim a security-gate pass')
    metadata = identity(os.environ.get('GITHUB_SHA'), os.environ.get('GITHUB_RUN_ID'), os.environ.get('GITHUB_RUN_ATTEMPT'))
    if {entry.name for entry in public.iterdir()} != {'private-evidence.gpe'}:
        raise ValueError('Unexpected public diagnostic content')
    envelope_bytes = regular_bytes(public / 'private-evidence.gpe')
    envelope = json.loads(envelope_bytes)
    pem = regular_bytes(key).decode('ascii').strip().splitlines()
    recipient = hashlib.sha256(base64.b64decode(''.join(pem[1:-1]), validate=True)).hexdigest()
    if pem[0] != '-----BEGIN PUBLIC KEY-----' or pem[-1] != '-----END PUBLIC KEY-----':
        raise ValueError('Invalid diagnostic recipient key')
    if set(envelope) != {'format', 'recipientSha256', 'wrappedKey', 'iv', 'tag', 'ciphertext'} or envelope.get('format') != 'gp-security-evidence-v1' or envelope.get('recipientSha256') != recipient:
        raise ValueError('Diagnostic recipient mismatch')
    lengths = {field: len(base64.b64decode(envelope[field], validate=True)) for field in ('wrappedKey', 'iv', 'tag', 'ciphertext')}
    if lengths['wrappedKey'] < 384 or lengths['iv'] != 12 or lengths['tag'] != 16 or lengths['ciphertext'] == 0:
        raise ValueError('Invalid diagnostic envelope')
    summary = {'schemaVersion': 1, 'kind': 'sast-diagnostic', 'diagnosticOnly': True,
               'securityGatePassed': False, **metadata,
               'executionComplete': receipt.get('diagnosticExecutionComplete') is True,
               'controlsPassed': receipt.get('controlsPassed') is True,
               'caseCount': len(receipt.get('cases', [])),
               'fixpointTimeoutCount': sum(row.get('fixpointTimeoutCount', 0) for row in receipt.get('cases', [])),
               'privateReceiptSha256': hashlib.sha256(receipt_bytes).hexdigest(),
               'privateEvidenceSha256': hashlib.sha256(envelope_bytes).hexdigest()}
    write(public / 'diagnostic-summary.json', summary)
    files = [{'name': name, 'bytes': (public / name).stat().st_size, 'sha256': sha(public / name)}
             for name in ('diagnostic-summary.json', 'private-evidence.gpe')]
    write(public / 'diagnostic-upload-manifest.json', {'schemaVersion': 1, 'kind': 'sast-diagnostic',
          'diagnosticOnly': True, 'securityGatePassed': False, **metadata, 'recipientSha256': recipient, 'files': files})
    return 0


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=Path, default=Path('.'))
    parser.add_argument('--tools', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--semgrep', default='semgrep')
    parser.add_argument('--publish', action='store_true')
    parser.add_argument('--public', type=Path)
    parser.add_argument('--key', type=Path)
    args = parser.parse_args()
    if args.publish:
        return publish(args.output, args.public, args.key)
    existed = args.output.exists()
    try:
        return run(args.root.resolve(), args.tools.resolve(), args.output.resolve(), args.semgrep)
    except Exception as error:
        if existed:
            raise
        args.output.mkdir(parents=True, exist_ok=True)
        write(args.output / 'gate-result.json', {'schemaVersion': 1, 'gate': 'sast-diagnostic',
              'diagnosticOnly': True, 'complete': False, 'passed': False, 'securityGatePassed': False,
              'status': 'diagnostic_only', 'diagnosticExecutionComplete': False, 'controlsPassed': False,
              'error': str(error), 'cases': []})
        print('Diagnostic execution failed; private receipt retained.')
        return 2


if __name__ == '__main__':
    raise SystemExit(main())

"""Fast parser/finding diagnostics only; never a substitute for qualified SAST."""
import argparse
import datetime as dt
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import subprocess

from gates import source_files, stage_sources, check_sast_result, sha, read, write
from sast_profile import build_rule_profiles

RULE_FILES = frozenset(('html-in-template-string.yaml', 'insecure-innerhtml.yaml',
                       'insecure-document-method.yaml'))


def assess(result, expected, stage, exit_code):
    if result.get('version') != '1.181.0' or exit_code not in (0, 1):
        raise ValueError('Unexpected diagnostic scanner version or exit')
    count = check_sast_result(result, expected, stage)
    if (exit_code == 1) != bool(result.get('results')):
        raise ValueError('Inconsistent diagnostic finding count')
    return {'syntaxReady': True, 'targetedFiles': count,
            'findingCount': len(result['results']), 'securityGatePassed': False}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--tools', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    root, tools, output = [p.resolve() for p in (args.root, args.tools, args.output)]
    output.mkdir(parents=True, exist_ok=False)
    record = {'schemaVersion': 1, 'gate': 'sast-syntax-diagnostic', 'passed': False,
              'securityGatePassed': False, 'checkedAt': dt.datetime.now(dt.timezone.utc).isoformat(),
              'commands': [], 'scope': 'Three pinned syntactic rules with all own JS/TS targets; diagnostic only. The full qualified five-profile SAST remains mandatory.'}
    code = 2
    try:
        commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip()
        if commit != os.environ.get('GITHUB_SHA'):
            raise ValueError('Diagnostic checkout differs from its workflow event')
        inventory = source_files(root)
        entries = [e for e in inventory if PurePosixPath(e['path']).suffix in ('.js', '.cjs', '.mjs', '.ts', '.jsx', '.tsx')
                   and PurePosixPath(e['path']).parts[0] not in ('test', 'tests', 'test-support')
                   and not e['path'].startswith('public/vendor/')]
        if not any(e['path'] == 'server.js' for e in entries):
            raise ValueError('Missing mandatory server target')
        manifest = read(tools / 'rules-manifest.json')
        config = read(root / 'scripts/security/tools.json')
        if manifest['commit'] != config['rules']['commit'] or manifest['archiveSha256'] != config['rules']['sha256']:
            raise ValueError('Unpinned diagnostic rule bundle')
        profiles = build_rule_profiles(tools, output / 'profiles', manifest)
        selected = [e for group in profiles['groups'].values() for e in group
                    if PurePosixPath(e['path']).name in RULE_FILES]
        if len(selected) != 3 or {PurePosixPath(e['path']).name for e in selected} != RULE_FILES:
            raise ValueError('Incomplete diagnostic rule selection')
        rules = output / 'syntax-rules'
        rules.mkdir()
        for entry in selected:
            target = rules / PurePosixPath(entry['path']).name
            shutil.copyfile(tools / 'rules' / entry['path'], target)
            if sha(target) != entry['sha256']:
                raise ValueError('Diagnostic rule bytes changed')
        write(output / 'syntax-inputs.json', {'commit': commit, 'targets': entries, 'rules': selected,
                                             'canonicalRuleIds': profiles['canonicalRuleIds']})
        stage = output / 'syntax-source'
        stage_sources(root, stage, entries)
        result_file = output / 'syntax-results.json'
        command = ['semgrep', 'scan', '--config', str(rules), '--json', '--output', str(result_file),
                   '--metrics', 'off', '--disable-version-check', '--disable-nosem', '--no-git-ignore',
                   '--optimizations', 'none', '--time', '--max-target-bytes', '0', '--timeout', '30',
                   '--timeout-threshold', '0', '--max-memory', '4096', '--jobs', '1', '--strict', '--error', str(stage)]
        env = {**os.environ, 'SEMGREP_SEND_METRICS': 'off', 'SEMGREP_ENABLE_VERSION_CHECK': '0'}
        env.pop('SEMGREP_APP_TOKEN', None)
        completed = subprocess.run(command, cwd=root, env=env, capture_output=True, timeout=600)
        (output / 'scanner.stdout').write_bytes(completed.stdout)
        (output / 'scanner.stderr').write_bytes(completed.stderr)
        record['commands'].append({'label': 'syntax-diagnostic', 'argv': command, 'exitCode': completed.returncode})
        details = assess(read(result_file), {e['path'] for e in entries}, stage, completed.returncode)
        record.update(details=details, complete=True, syntaxReady=True, status='syntax_ready')
        code = 0
    except Exception as error:
        record.update(complete=False, syntaxReady=False, status='tool_or_syntax_error', error=str(error))
    record['exitCode'] = code
    write(output / 'gate-result.json', record)
    print(json.dumps({key: record[key] for key in ('gate', 'syntaxReady', 'securityGatePassed', 'status', 'exitCode')}))
    return code


if __name__ == '__main__':
    raise SystemExit(main())

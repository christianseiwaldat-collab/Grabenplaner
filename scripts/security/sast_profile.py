"""Reproducible applicability profiles; upstream rule bytes remain unchanged."""
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import shutil

PROFILE_VERSION = 3
AWS_PREFIX = 'javascript/aws-lambda/'
EXPRESS_PREFIX = 'javascript/express/'
EXPENSIVE_RULE_FILES={
    'javascript/lang/security/audit/unknown-value-with-script-tag.yaml':'script_tag',
    'javascript/express/security/audit/remote-property-injection.yaml':'express_property',
    'javascript/express/security/audit/xss/direct-response-write.yaml':'express_response',
}
PROFILE_TIMEOUTS_BY_VERSION={
    1:{'common':60,'express':60},
    2:{'common':60,'express':60,'script_tag':300,'express_property':300,'express_response':300},
    3:{'common':120,'express':120,'script_tag':300,'express_property':300,'express_response':300},
}


def profile_timeouts(profile_version=PROFILE_VERSION):
    if profile_version not in PROFILE_TIMEOUTS_BY_VERSION:raise ValueError('Unknown SAST profile version')
    return dict(PROFILE_TIMEOUTS_BY_VERSION[profile_version])


PROFILE_TIMEOUTS=profile_timeouts()


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def source_partition(root, entries, profile_version=PROFILE_VERSION):
    if profile_version not in PROFILE_TIMEOUTS_BY_VERSION:raise ValueError('Unknown SAST profile version')
    backend=[entry for entry in entries if not entry['path'].startswith('public/')]
    if not entries or not backend or not any(e['path']=='server.js' for e in backend):
        raise ValueError('Missing mandatory server target')
    # A changed deployment/framework assumption requires an explicit profile
    # review. These are conservative tripwires, not a general JS interpreter.
    dependency_text='\n'.join((root/name).read_text(encoding='utf8') for name in ('package.json','pnpm-lock.yaml'))
    if re.search(r'(?i)(?:aws-lambda|@aws-sdk/|aws-sdk["@])',dependency_text):
        raise ValueError('AWS integration requires SAST applicability review')
    for entry in entries:
        text=(root/entry['path']).read_text(encoding='utf8')
        if re.search(r'(?:exports\s*(?:\.\s*handler\b|\[\s*["\']handler["\']\s*\])|export\s+(?:(?:async|const|let|function)\s+){1,3}handler\b|require\s*\(\s*["\'](?:aws-lambda|@aws-sdk/|aws-sdk)[^"\']*["\'])',text):
            raise ValueError('Lambda entrypoint/import requires SAST applicability review')
        if entry['path'].startswith('public/') and re.search(r'(?:require\s*\(\s*["\']express["\']|from\s*["\']express["\'])',text):
            raise ValueError('Express import in browser scope requires SAST applicability review')
    partitions={'common':entries,'express':backend}
    if profile_version>=2:partitions.update(script_tag=entries,express_property=backend,express_response=backend)
    return partitions


def deployment_guard(entries, root):
    for entry in entries:
        path=PurePosixPath(entry['path'])
        if path.name.lower() in ('serverless.yml','serverless.yaml','samconfig.toml'):
            raise ValueError('Lambda deployment declaration requires SAST applicability review')
        if path.suffix in ('.yaml','.yml','.json','.tf') and 'AWS::Lambda::' in (root/path).read_text(encoding='utf8'):
            raise ValueError('Lambda deployment resource requires SAST applicability review')


def build_rule_profiles(tools, output, upstream, expected_rules=169, profile_version=PROFILE_VERSION):
    if profile_version not in PROFILE_TIMEOUTS_BY_VERSION:raise ValueError('Unknown SAST profile version')
    if output.exists():raise ValueError('Rule profile directory must be new')
    files=upstream['files'];source=tools/'rules'
    if {p.relative_to(source).as_posix() for p in source.rglob('*') if p.is_file()} != {e['path'] for e in files}:
        raise ValueError('Unreviewed or missing upstream rule file')
    groups={'common':[],'express':[]}
    if profile_version>=2:groups.update(script_tag=[],express_property=[],express_response=[])
    excluded=[];count=0;canonical_ids=[]
    for entry in files:
        name=entry['path'];path=source/name
        if digest(path)!=entry['sha256']:raise ValueError('Upstream rule hash drift')
        if not name.endswith('.yaml'):continue
        ids=re.findall(r'^\s*-\s+id:\s*([A-Za-z0-9_.-]+)\s*$',path.read_text(encoding='utf8'),re.M)
        rules=len(ids)
        if not rules:raise ValueError('Unrecognized upstream rule structure')
        row={**entry,'ruleCount':rules};count+=rules
        if name.startswith(AWS_PREFIX):excluded.append(row);continue
        canonical_ids.extend('.'.join((*PurePosixPath(name).parent.parts,rule_id)) for rule_id in ids)
        group='express' if name.startswith(EXPRESS_PREFIX) else 'common'
        if profile_version>=2 and name in EXPENSIVE_RULE_FILES:
            if rules!=1:raise ValueError('Expensive rule file inventory changed')
            group=EXPENSIVE_RULE_FILES[name]
        target=output/group/'rules'/name;target.parent.mkdir(parents=True,exist_ok=True)
        shutil.copyfile(path,target)
        if digest(target)!=entry['sha256']:raise ValueError('Derived rule byte drift')
        groups[group].append(row)
    if count!=expected_rules or not all(groups.values()) or not excluded or len(canonical_ids)!=len(set(canonical_ids)):
        raise ValueError('Unexpected rule inventory; applicability review required')
    return {'schemaVersion':1,'profileVersion':profile_version,'upstreamCommit':upstream['commit'],
            'archiveSha256':upstream['archiveSha256'],'totalUpstreamRules':count,
            'groups':groups,'excludedRuleFiles':excluded,'canonicalRuleIds':sorted(canonical_ids),
            'exclusionReason':'AWS Lambda event/handler source rules do not model this Express/browser application. Deployment/import guards require review when that assumption changes. All language, browser, Node/library and applicable Express rules remain.'}

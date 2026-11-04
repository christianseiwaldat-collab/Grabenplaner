"""Exact, expiring SAST review decisions. No rule/path-wide suppression."""
import datetime as dt
import hashlib
import json
from pathlib import PurePosixPath
import re


def canonical_rule_id(raw, allowed):
    matches=[rule for rule in allowed if raw==rule or raw.endswith('.'+rule)]
    if len(matches)!=1:
        raise ValueError('Unknown or ambiguous SAST rule identity')
    return matches[0]


def scanner_position(position):
    """Semgrep JSON uses col; our stable review schema uses column."""
    if not isinstance(position,dict) or set(position)!={'line','col','offset'} or any(type(position[k]) is not int or position[k]<1 for k in ('line','col')) or type(position['offset']) is not int or position['offset']<0:
        raise ValueError('Malformed Semgrep JSON position')
    return {'line':position['line'],'column':position['col']}


def finding_identity(rule, path, start, end):
    if not isinstance(rule,str) or not rule or not isinstance(path,str):
        raise ValueError('Malformed SAST finding identity')
    relative=PurePosixPath(path)
    if relative.is_absolute() or '..' in relative.parts or str(relative)!=path or '\\' in path:
        raise ValueError('Unsafe SAST finding path')
    for position in (start,end):
        if set(position)!={'line','column'} or any(type(v) is not int or v<1 for v in position.values()):
            raise ValueError('Malformed SAST finding coordinates')
    if (end['line'],end['column'])<(start['line'],start['column']):
        raise ValueError('Reversed SAST finding coordinates')
    values=[rule,path,start['line'],start['column'],end['line'],end['column']]
    return hashlib.sha256(json.dumps(values,separators=(',',':')).encode()).hexdigest()


def newline_hash_variants(reviewed_bytes):
    """For review-time policy authoring only; retain every explicit raw digest.

    Only CRLF/LF are changed. Lone CR, encoding/BOM, whitespace and every other
    byte remain intact. The gate itself never normalizes a runtime file.
    """
    if not isinstance(reviewed_bytes,bytes):raise ValueError('Review source must be bytes')
    lf=reviewed_bytes.replace(b'\r\n',b'\n')
    return sorted({hashlib.sha256(value).hexdigest() for value in (reviewed_bytes,lf,lf.replace(b'\n',b'\r\n'))})


def approved_hash_variants(original, variants):
    if not isinstance(original,str) or not re.fullmatch(r'[a-f0-9]{64}',original):
        raise ValueError('Invalid reviewed source hash')
    if not isinstance(variants,list) or not 1<=len(variants)<=3 or any(not isinstance(v,str) or not re.fullmatch(r'[a-f0-9]{64}',v) for v in variants) or len(set(variants))!=len(variants) or original not in variants:
        raise ValueError('Invalid explicit newline hash variants')
    return set(variants)


def apply_dispositions(policy, findings, root, today=None):
    """An invalid/stale decision is a tool error, never a silent exemption."""
    today=today or dt.date.today()
    if set(policy)!={'schemaVersion','dispositions'} or policy['schemaVersion']!=1 or not isinstance(policy['dispositions'],list):
        raise ValueError('Malformed SAST disposition policy')
    actual={}
    for finding in findings:
        key=finding_identity(finding['rule'],finding['path'],finding['start'],finding['end'])
        if finding['fingerprint']!=key:raise ValueError('SAST fingerprint mismatch')
        if key in actual:raise ValueError('Duplicate SAST finding identity')
        actual[key]=finding
    accepted=set();reviewed=[];context_hashes={}
    for row in policy['dispositions']:
        fields={'rule','path','start','end','fingerprint','sourceSha256','sourceSha256Variants','classification','priority','reason','reviewer','reviewedOn','expiresOn','context'}
        if set(row)!=fields or row['classification']!='reviewed_false_positive':
            raise ValueError('Only explicitly reviewed false positives may be accepted')
        key=finding_identity(row['rule'],row['path'],row['start'],row['end'])
        if row['fingerprint']!=key or key in accepted:raise ValueError('Invalid/duplicate SAST disposition identity')
        variants=approved_hash_variants(row['sourceSha256'],row['sourceSha256Variants'])
        if key not in actual or actual[key]['sourceSha256'] not in variants:
            raise ValueError('Stale or unmatched SAST disposition')
        expiry=dt.date.fromisoformat(row['expiresOn']);reviewed_on=dt.date.fromisoformat(row['reviewedOn'])
        limit=14 if row['priority'] in ('P0','P1') else 30 if row['priority'] in ('P2','P3') else 0
        if not limit or reviewed_on>today or expiry<today or expiry<reviewed_on or expiry>reviewed_on+dt.timedelta(days=limit):
            raise ValueError('Expired or unbounded SAST disposition')
        if not isinstance(row['reason'],str) or len(row['reason'].strip())<80 or not isinstance(row['reviewer'],str) or not row['reviewer'].strip():
            raise ValueError('SAST disposition lacks a concrete review explanation')
        if not isinstance(row['context'],list) or not row['context']:
            raise ValueError('SAST disposition lacks source-bound context')
        seen=set()
        for context in row['context']:
            if set(context)!={'path','sha256','sha256Variants','reason'} or not isinstance(context['reason'],str) or len(context['reason'].strip())<20:
                raise ValueError('Malformed SAST context contract')
            path=PurePosixPath(context['path'])
            if path.is_absolute() or '..' in path.parts or str(path)!=context['path'] or '\\' in context['path'] or context['path'] in seen:
                raise ValueError('Unsafe/duplicate SAST context path')
            seen.add(context['path']);file=root/path
            context_variants=approved_hash_variants(context['sha256'],context['sha256Variants'])
            if file.is_symlink() or not file.is_file() or not file.resolve().is_relative_to(root.resolve()):
                raise ValueError('Invalid SAST context source')
            if context['path'] not in context_hashes:
                context_hashes[context['path']]=hashlib.sha256(file.read_bytes()).hexdigest()
            if context_hashes[context['path']] not in context_variants:
                raise ValueError('SAST context contract changed; repeat review')
        if row['path'] not in seen or not any(c['path']==row['path'] and c['sha256']==row['sourceSha256'] and set(c['sha256Variants'])==variants for c in row['context']):
            raise ValueError('SAST context must bind the finding source itself')
        if context_hashes[row['path']]!=actual[key]['sourceSha256']:
            raise ValueError('Actual finding hash does not match current raw source')
        accepted.add(key);reviewed.append({'fingerprint':key,'reviewer':row['reviewer'],'expiresOn':row['expiresOn']})
    return {'reviewedFalsePositives':reviewed,'blockingFindings':[f for key,f in actual.items() if key not in accepted]}

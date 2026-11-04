"""Publish only bounded, schema-selected metadata; raw scanner output is private.

Never copy scanner logs, source excerpts, arbitrary error messages, commands,
filenames, component properties or source-machine paths into an artifact.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re


def read(path):
    return json.loads(path.read_text(encoding='utf-8-sig'))


def write(path, value):
    path.write_text(json.dumps(value, indent=2)+'\n', encoding='utf8')


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def safe_component(item):
    item=dict(item)
    if not item.get('group') and isinstance(item.get('name'),str) and item['name'].startswith('@') and item['name'].count('/')==1:
        item['group'],item['name']=item['name'].split('/',1)
    result={'type':'library'}
    for key in ('name','group','version'):
        value=item.get(key)
        if value is None and key=='group':continue
        pattern={'name':r'[a-zA-Z0-9_.-]{1,214}','group':r'@[a-zA-Z0-9_.-]{1,214}',
                 'version':r'[0-9][a-zA-Z0-9_.+~-]{0,255}'}[key]
        if not isinstance(value,str) or not re.fullmatch(pattern,value):
            raise ValueError('Invalid package identity')
        result[key]=value
    result['bom-ref']=hashlib.sha256(json.dumps(result,sort_keys=True).encode()).hexdigest()
    return result


def publish(source, destination, gate):
    if gate not in ('sca','sast','secrets','sbom'):raise ValueError('Invalid gate')
    if destination.exists():raise ValueError('Publication directory must be new')
    destination.mkdir(parents=True)
    # This fallback deliberately omits all untrusted errors, including paths.
    summary={'schemaVersion':1,'gate':gate,'complete':False,'passed':False,
             'status':'tool_or_coverage_error','exitCode':2}
    try:
        receipt=read(source/'gate-result.json')
        if receipt.get('gate')!=gate:raise ValueError('Gate identity mismatch')
        code=receipt.get('exitCode')
        if type(code) is not int or code not in (0,1,2):raise ValueError('Invalid exit code')
        expected=('passed','findings','tool_or_coverage_error')[code]
        if receipt.get('status')!=expected or receipt.get('passed') is not (code==0) or receipt.get('complete') is not (code!=2):
            raise ValueError('Inconsistent receipt')
        summary.update(complete=code!=2,passed=code==0,status=expected,exitCode=code)
        summary['privateReceiptSha256']=digest(source/'gate-result.json')
        details=receipt.get('details',{})
        summary['findingCount']=len(details.get('findings',[]))
        summary['blockingFindingCount']=len(details.get('blockingFindings',[]))
        for key in ('scannedFiles','scannedPackages','scannedWorktreeFiles','serverBytes','components'):
            value=details.get(key)
            if type(value) is int and value>=0:summary[key]=value
        if gate=='sbom' and code==0:
            raw=read(source/'sbom.cdx.json')
            if raw.get('bomFormat')!='CycloneDX' or not raw.get('components'):raise ValueError('Invalid SBOM')
            # Syft also records the source lockfile as a file component with an
            # absolute runner path. Publish libraries only, never that path.
            libraries=[item for item in raw['components'] if item.get('type')=='library']
            if not libraries:raise ValueError('Empty package SBOM')
            if any(item.get('type') not in ('library','file') for item in raw['components']):raise ValueError('Unexpected component kind')
            public={'bomFormat':'CycloneDX','specVersion':'1.6','version':1,
                    'components':[safe_component(item) for item in libraries]}
            write(destination/'sbom.cdx.json',public)
            summary['sourceSbomSha256']=digest(source/'sbom.cdx.json')
            summary['publishedSbomSha256']=digest(destination/'sbom.cdx.json')
            summary['runnerInventorySha256']=digest(source/'release-inventory.json')
    except Exception:
        # No exception text enters public artifacts; failed sanitizer fails its
        # own step and cannot turn an earlier failing gate into a success.
        summary={'schemaVersion':1,'gate':gate,'complete':False,'passed':False,
                 'status':'publication_error','exitCode':2}
        write(destination/'gate-summary.json',summary)
        return 2
    write(destination/'gate-summary.json',summary)
    return 0


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--input',required=True);parser.add_argument('--output',required=True)
    parser.add_argument('--gate',required=True,choices=['sca','sast','secrets','sbom'])
    args=parser.parse_args()
    raise SystemExit(publish(Path(args.input),Path(args.output),args.gate))

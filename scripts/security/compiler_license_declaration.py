"""Typed exact-package declaration/source-notice evidence for five reviewed IDs.

Original OPAM declarations and normalized actual installed metadata are separate
byte-bound records. Standard license references keep original placeholders;
they never become invented upstream copyright notices. Ambient's genuine MIT
README notice and OCaml Atomic file directives keep their distinct file scopes.
All original release archives, actual retained sources and installation records
remain included. Every other dependency keeps the normal original-notice rule.
"""
import base64
import hashlib
import io
import json
from pathlib import PurePosixPath
import re
import tarfile

FORMAT = 'gp-reviewed-opam-declaration-and-source-notices/v2'
OPAM_COMMIT = '78d29aba187e8362b8ab86c189790c0af9153d4b'
METADATA_BASE = 'https://raw.githubusercontent.com/ocaml/opam-repository/' + OPAM_COMMIT + '/packages/'
MAX_METADATA = 4 * 1024**2
INSTALLED_PATH = '/root/.opam/5.4.0/share/ocaml-config/gen_ocaml_config.ml'
MAX_INSTALLED = 64 * 1024
AMBIENT_IDS = frozenset(('ambient-context.0.2','ambient-context-eio.0.2','ambient-context-lwt.0.2'))
CONFIG_ORIGINALS = (
    ('ocaml-config.install', 'https://raw.githubusercontent.com/ocaml/ocaml/363fb9f5a2fb87dbd5f8cc579af87dd04e14343b/tools/opam/ocaml-config.install', 31, '6e4fd93f4cce6bad0ed3c08afd0248dbe7d7817109281de6294e5b5ef5597051'),
    ('gen_ocaml_config.ml.in', 'https://raw.githubusercontent.com/ocaml/ocaml/66f33f6e08857f3c3cb53fc1759fbad6860c59bd/tools/opam/gen_ocaml_config.ml.in', 2697, 'a9ad8d84a08961159653a978db92d10f694510182b206cacb96d5c9f63b5121e'),
)
REFERENCE_BASE = 'https://raw.githubusercontent.com/spdx/license-list-data/617f1a78824394ada7525017d98c6fb215aad09b/text/'
REFERENCES = {
    'ISC': {'path':'reference/ISC.txt', 'url':REFERENCE_BASE+'ISC.txt', 'bytes':737, 'sha256':'521c6f0ed8e64736684f89843d16a4df6b4b7449acbcfc6ca6630a3037ca8c53', 'role':'standard-license-reference-with-unfilled-placeholders'},
    'MIT': {'path':'reference/MIT.txt', 'url':REFERENCE_BASE+'MIT.txt', 'bytes':1078, 'sha256':'b05785f9f18e6716bab63424b11454513b9943a222595b70411009202fc592b5', 'role':'standard-license-reference-with-unfilled-placeholders'},
    'OCaml-LICENSE': {'path':'reference/OCaml-LICENSE.txt', 'url':'https://raw.githubusercontent.com/ocaml/ocaml/66f33f6e08857f3c3cb53fc1759fbad6860c59bd/LICENSE', 'bytes':27179, 'sha256':'65f47d3bf5a921011ac7fa30f23d54f9dffbe7683921eeb116d5ce8dc26ff0c1', 'role':'original-system-license-terms-reference-for-file-directives'},
    'OCaml-atomic-origin': {'path':'reference/OCaml-atomic.mli.txt', 'url':'https://raw.githubusercontent.com/ocaml/ocaml/66f33f6e08857f3c3cb53fc1759fbad6860c59bd/stdlib/atomic.mli', 'bytes':7709, 'sha256':'2eaf7b870d3a45bd595ed448a341d39d6dd1ae9291c996680c854f787ad98316', 'role':'original-system-source-context-with-byte-identical-license-header'},
}
AMBIENT_NOTICES = (
    ('ambient-context-0.2/README.md',9199,'fd353274b61b524975b3f206b9178b3a36ba915f95076d2c787a32e9579f4e3b','MIT','Original project README license section; file-specific directives remain separate'),
    ('ambient-context-0.2/src/util/atomic/atomic.pre412.mli',2327,'e458e865daebad3527e495bc650645297f699d52043fa88f578a265a1a6fa94d','LGPL-2.1-only WITH OCaml-LGPL-linking-exception','Only this exact file; build/runtime selection is not asserted'),
    ('ambient-context-0.2/src/util/atomic/atomic.post412.mli',2348,'f8b9cf47214929df4469ad807fb3c3d1c905ffdd68ffc4fa19990b59b6edcd9b','LGPL-2.1-only WITH OCaml-LGPL-linking-exception','Only this exact file; build/runtime selection is not asserted'),
)
ATOMIC_HEADER_SHA = '2964705d9426bc313c668dace3bda3e3a34c5604f9b182838286dc9111462607'


def sha(data): return hashlib.sha256(data).hexdigest()
def canonical(value): return (json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':'))+'\n').encode()

def _policy(identity):
    if identity not in POLICIES: raise ValueError('License evidence is restricted to five exact reviewed package IDs')
    return POLICIES[identity]

def _metadata_url(identity):
    policy=_policy(identity)
    return METADATA_BASE+policy['name']+'/'+identity+'/opam'

def _bytes(package,key):
    data=base64.b64decode(package[key],validate=True)
    if len(data)>MAX_METADATA or key=='opam' and not data: raise ValueError('Actual installed metadata is empty or exceeds bound')
    return data

def _record(data): return {'bytes':len(data),'sha256':sha(data)}

def installed_source(package):
    value=package.get('installedSource')
    if (package.get('id')!='ocaml-config.3' or not isinstance(value,dict)
            or set(value)!={'imagePath','bytes','sha256','content'} or value['imagePath']!=INSTALLED_PATH
            or type(value['bytes']) is not int or not 0<value['bytes']<=MAX_INSTALLED):
        raise ValueError('Exact captured installed config source is required')
    data=base64.b64decode(value['content'],validate=True)
    if _record(data)!={k:value[k] for k in ('bytes','sha256')} or b'\x00' in data:
        raise ValueError('Captured installed config source bytes differ')
    data.decode('utf8')
    return data


def actual_source_evidence(capture):
    packages=capture.get('opamPackages',[])
    if not isinstance(packages,list): raise ValueError('Actual package records are missing')
    expected=set()
    for line in capture.get('opamListing','').splitlines():
        if not line.strip() or line.lstrip().startswith('#'): continue
        parts=line.split()
        if len(parts)!=2: raise ValueError('Invalid actual package listing')
        identity=parts[0]+'.'+parts[1]
        if identity in DECLARATION_IDS: expected.add(identity)
    result={}
    for package in packages:
        identity=package.get('id')
        if identity not in DECLARATION_IDS: continue
        policy=_policy(identity)
        if identity in result or (package.get('name'),package.get('version'))!=(policy['name'],policy['version']):
            raise ValueError('Invalid or duplicate actual reviewed package identity')
        entry={key:_record(_bytes(package,key)) for key in ('opam','install','changes')}
        if identity=='ocaml-config.3': entry['installedSource']=_record(installed_source(package))
        result[identity]=entry
    if expected!=set(result): raise ValueError('Actual installed reviewed metadata/source evidence was omitted')
    return result


def _reject_duplicate_critical_fields(text):
    # Count actual top-level tokens, including same-line duplicates. Strings,
    # comments and nested dependency/extra-source fields cannot invent keys.
    critical={'name','version','license','authors','patches','substs'}
    seen={};nesting=[];quote=None;i=0
    if len(text)>MAX_METADATA: raise ValueError('Installed OPAM definition exceeds bound')
    while i<len(text):
        if quote:
            if quote=='triple' and text.startswith('"""',i): quote=None;i+=3;continue
            if quote=='single' and text[i]=='"': quote=None;i+=1;continue
            if text[i]=='\\': i+=2;continue
            i+=1;continue
        if text[i]=='#':
            stop=text.find('\n',i);i=len(text) if stop<0 else stop+1;continue
        if text.startswith('"""',i): quote='triple';i+=3;continue
        if text[i]=='"': quote='single';i+=1;continue
        if text[i] in '[{': nesting.append(text[i]);i+=1;continue
        if text[i] in ']}':
            if not nesting or nesting.pop()!=('[' if text[i]==']' else '{'): raise ValueError('Unbalanced installed OPAM metadata')
            i+=1;continue
        token=re.match(r'[A-Za-z][A-Za-z0-9_-]*',text[i:])
        if token:
            name=token.group();end=i+token.end()
            if not nesting and name in critical and re.match(r'\s*:',text[end:]):
                if name in seen: raise ValueError('Duplicate critical OPAM field: '+name)
                seen[name]=i
            i=end;continue
        i+=1
    if quote or nesting: raise ValueError('Unterminated installed OPAM metadata')
    return seen


def _semantics(data,identity):
    from compiler_license_ledger import field,opam_blocks,source_url
    policy=_policy(identity);text=data.decode('utf8')
    positions=_reject_duplicate_critical_fields(text)
    critical=lambda name:field(text[positions[name]:],name) if name in positions else []
    for key,expected in [('name',policy['name']),('version',policy['version'])]:
        values=critical(key)
        if values and values!=[expected]: raise ValueError('Installed OPAM name/version differs')
    result={key:critical(key) for key in ('license','authors','patches','substs')}
    if result['license']!=[policy['declaredLicense']] or result['authors']!=policy['authors']:
        raise ValueError('Installed OPAM license/authors differ from original declaration')
    if identity=='ocaml-config.3':
        names=re.findall(r'(?m)^\s*extra-source\s+("(?:[^"\\]|\\.)*")\s*\{',text)
        names=[json.loads(name) for name in names]
        if sorted(names)!=sorted(item[0] for item in CONFIG_ORIGINALS): raise ValueError('Config extra-source set differs')
        normalized=re.sub(r'(?m)^(\s*)extra-source\s+("(?:[^"\\]|\\.)*")',r'\1extra-source \2',text)
        extras=[]
        for name,url,size,digest in CONFIG_ORIGINALS:
            blocks=opam_blocks(normalized,'extra-source "'+name+'"')
            if len(blocks)!=1 or field(blocks[0],'src')!=[url]: raise ValueError('Config original source URL differs')
            checksums=sorted(field(blocks[0],'checksum'))
            if 'sha256='+digest not in checksums: raise ValueError('Config original source SHA differs')
            extras.append({'name':name,'url':url,'checksums':checksums})
        if opam_blocks(text,'url'): raise ValueError('Config unexpectedly has a main source URL')
        result['extraSources']=extras
    else:
        if re.search(r'(?m)^\s*extra-(?:source|files)\b',text): raise ValueError('Unexpected additional installed release sources')
        url,checksums=source_url(text)
        if url!=policy['archive']['url'] or sorted(checksums)!=sorted(policy['archive']['checksums']):
            raise ValueError('Installed OPAM release source/checksums differ')
        result['releaseSource']={'url':url,'checksums':sorted(checksums)}
    return result


def _original_declaration(identity):
    policy=_policy(identity)
    return {'path':'metadata/original-opam','url':_metadata_url(identity),'bytes':policy['metadataBytes'],
        'sha256':policy['metadataSha256'],'licenseExpression':policy['declaredLicense'],'authors':list(policy['authors'])}


def _sources(identity):
    policy=_policy(identity)
    if 'archive' in policy: return [{**policy['archive'],'checksums':list(policy['archive']['checksums'])}]
    return [{'path':'source/original/'+name,'url':url,'bytes':size,'sha256':digest,'checksums':['sha256='+digest]}
        for name,url,size,digest in CONFIG_ORIGINALS]


def _notice_specs(identity):
    if identity not in AMBIENT_IDS: return []
    return [{'archivePath':'source/original-archive','memberPath':path,'bytes':size,'sha256':digest,'licenseExpression':expression,'scope':scope}
        for path,size,digest,expression,scope in AMBIENT_NOTICES]


def _archive_notices(data,identity):
    expected={item['memberPath']:item for item in _notice_specs(identity)};found={}
    if sha(data)!=_policy(identity)['archive']['sha256']: raise ValueError('Original release archive SHA differs')
    with tarfile.open(fileobj=io.BytesIO(data),mode='r:*') as archive:
        for item in archive:
            if item.name in expected:
                if not item.isfile() or item.name in found: raise ValueError('Invalid original notice member')
                content=archive.extractfile(item).read();spec=expected[item.name]
                if _record(content)!={k:spec[k] for k in ('bytes','sha256')}: raise ValueError('Original source notice bytes differ')
                found[item.name]=content
    if set(found)!=set(expected): raise ValueError('Original source notices were omitted')
    return found


def _expected_native(evidence):
    result={key:{k:value[k] for k in ('bytes','sha256')} for key,value in evidence['installedMetadata'].items()}
    if evidence['installedSource'] is not None: result['installedSource']={k:evidence['installedSource'][k] for k in ('bytes','sha256')}
    return result


def collect_component(package,root,output):
    from compiler_license_ledger import download,checked_download,regular,tree_files,retain_source,notice
    identity=package.get('id');policy=_policy(identity)
    if (package.get('name'),package.get('version'))!=(policy['name'],policy['version']) or package.get('sourcePin'):
        raise ValueError('Reviewed declaration package identity/pin differs')
    original=download(_metadata_url(identity),maximum=policy['metadataBytes'])
    if _record(original)!={'bytes':policy['metadataBytes'],'sha256':policy['metadataSha256']}: raise ValueError('Original pinned OPAM declaration differs')
    actual={key:_bytes(package,key) for key in ('opam','install','changes')}
    semantic=_semantics(original,identity)
    if _semantics(actual['opam'],identity)!=semantic: raise ValueError('Original versus installed licensing/source metadata differs')
    files={'metadata/original-opam':original,'metadata/installed-opam':actual['opam'],
        'metadata/install':actual['install'],'metadata/changes':actual['changes']}
    installed={key:{'path':('metadata/installed-opam' if key=='opam' else 'metadata/'+key),**_record(data)} for key,data in actual.items()}
    for spec in _sources(identity):
        data=checked_download(spec['url'],spec['checksums'],root/'opam-download-cache')
        if _record(data)!={k:spec[k] for k in ('bytes','sha256')}: raise ValueError('Original package source bytes differ')
        files[spec['path']]=data
    captured=package.get('sourceDirectory')
    if captured:
        if '/' in captured or '\\' in captured or not captured.startswith(policy['name']+'.'): raise ValueError('Invalid actual retained source directory')
        tree=root/'opam-sources'/captured
        if tree.is_dir(): files.update({'source/captured/'+name:data for name,data in tree_files(tree).items()})
    references=[]
    for key in policy['references']:
        spec=REFERENCES[key];data=download(spec['url'],maximum=spec['bytes'])
        if _record(data)!={k:spec[k] for k in ('bytes','sha256')}: raise ValueError('Unmodified official reference bytes differ')
        files[spec['path']]=data
        references.append({**spec,'id':key,'text':data.decode('utf8')})
    installed_source_record=None
    if identity=='ocaml-config.3':
        data=installed_source(package);files['source/installed/gen_ocaml_config.ml']=data
        installed_source_record={'path':'source/installed/gen_ocaml_config.ml','imagePath':INSTALLED_PATH,**_record(data)}
    original_notice_data=_archive_notices(files['source/original-archive'],identity) if 'archive' in policy else {}
    notices=[notice(path,data) for path,data in original_notice_data.items()]
    evidence={'format':FORMAT,'packageId':identity,'originalDeclaration':_original_declaration(identity),
        'installedMetadata':installed,'criticalMetadataSemanticsSha256':sha(canonical(semantic)),
        'originalSources':_sources(identity),'originalSourceNotices':_notice_specs(identity),'referenceTerms':references,
        'installedSource':installed_source_record,'evidenceKind':'original-source-notices-and-declaration' if notices else 'original-declaration-and-separated-standard-reference',
        'copyrightClaim':'Only byte-exact original source notices; reference placeholders remain unfilled'}
    component={'name':'opam/'+policy['name'],'version':policy['version'],'packageIds':[identity],
        'licenseExpression':policy['licenseExpression'],'notices':notices,'licenseEvidence':evidence,
        'correspondingSource':retain_source(output,'opam-'+identity,files,_metadata_url(identity))}
    validate_declaration(component,files)
    return component


def validate_declaration(component,files=None,native=None):
    ids=component.get('packageIds')
    if not isinstance(ids,list) or len(ids)!=1 or not isinstance(ids[0],str): raise ValueError('Invalid exact reviewed package identity')
    identity=ids[0];policy=_policy(identity)
    if (component.get('name'),component.get('version'),component.get('packageIds'),component.get('licenseExpression'))!=('opam/'+policy['name'],policy['version'],[identity],policy['licenseExpression']):
        raise ValueError('Exact reviewed package/license identity differs')
    authority=component.get('correspondingSource')
    if not isinstance(authority,dict) or authority.get('url')!=_metadata_url(identity): raise ValueError('Pinned original declaration authority differs')
    evidence=component.get('licenseEvidence')
    fields={'format','packageId','originalDeclaration','installedMetadata','criticalMetadataSemanticsSha256','originalSources','originalSourceNotices','referenceTerms','installedSource','evidenceKind','copyrightClaim'}
    if (not isinstance(evidence,dict) or set(evidence)!=fields or evidence['format']!=FORMAT or evidence['packageId']!=identity
            or evidence['originalDeclaration']!=_original_declaration(identity) or evidence['originalSources']!=_sources(identity)
            or evidence['originalSourceNotices']!=_notice_specs(identity)
            or evidence['evidenceKind']!=('original-source-notices-and-declaration' if _notice_specs(identity) else 'original-declaration-and-separated-standard-reference')
            or evidence['copyrightClaim']!='Only byte-exact original source notices; reference placeholders remain unfilled'
            or not re.fullmatch('[a-f0-9]{64}',str(evidence['criticalMetadataSemanticsSha256']))):
        raise ValueError('Reviewed declaration/source-notice evidence differs')
    installed=evidence['installedMetadata']
    if not isinstance(installed,dict) or set(installed)!={'opam','install','changes'}: raise ValueError('Actual normalized metadata records missing')
    for key,record in installed.items():
        path='metadata/installed-opam' if key=='opam' else 'metadata/'+key
        if (not isinstance(record,dict) or set(record)!={'path','bytes','sha256'} or record['path']!=path
                or type(record['bytes']) is not int or not 0<=record['bytes']<=MAX_METADATA or key=='opam' and record['bytes']==0
                or not re.fullmatch('[a-f0-9]{64}',str(record['sha256']))): raise ValueError('Invalid normalized installed metadata binding')
    references=evidence['referenceTerms']
    if not isinstance(references,list) or len(references)!=len(policy['references']): raise ValueError('Required original/reference terms omitted')
    for key,reference in zip(policy['references'],references):
        spec=REFERENCES[key]
        if (not isinstance(reference,dict) or set(reference)!=set(spec)|{'id','text'} or reference['id']!=key
                or any(reference.get(k)!=v for k,v in spec.items()) or not isinstance(reference['text'],str)
                or _record(reference['text'].encode())!={k:spec[k] for k in ('bytes','sha256')}): raise ValueError('Standard/origin reference was altered or mislabeled')
    source=evidence['installedSource']
    if identity=='ocaml-config.3':
        if (not isinstance(source,dict) or set(source)!={'path','imagePath','bytes','sha256'}
                or source['path']!='source/installed/gen_ocaml_config.ml' or source['imagePath']!=INSTALLED_PATH
                or type(source['bytes']) is not int or not 0<source['bytes']<=MAX_INSTALLED
                or not re.fullmatch('[a-f0-9]{64}',str(source['sha256']))): raise ValueError('Actual installed generated source is missing')
    elif source is not None: raise ValueError('Unexpected installed source claim')
    notices=component.get('notices');specs=_notice_specs(identity)
    if not isinstance(notices,list) or len(notices)!=len(specs): raise ValueError('Original source notices omitted or reference claimed as original')
    by_path={item.get('path'):item for item in notices if isinstance(item,dict)}
    if set(by_path)!={item['memberPath'] for item in specs}: raise ValueError('Original source notice scope differs')
    for spec in specs:
        item=by_path[spec['memberPath']]
        if set(item)!={'path','text','sha256','sourceBytesSha256','encoding'} or item['sourceBytesSha256']!=spec['sha256'] or not isinstance(item['text'],str): raise ValueError('Original source notice evidence differs')
        try:data=item['text'].encode({'utf8':'utf8','latin1':'latin1'}[item['encoding']])
        except (KeyError,UnicodeError):raise ValueError('Invalid original source notice encoding') from None
        if _record(data)!={k:spec[k] for k in ('bytes','sha256')} or sha(item['text'].encode())!=item['sha256']:raise ValueError('Original source notice bytes differ')
    if native is not None:
        actual=native.get('opamSourceEvidence')
        native_ids={parts[0]+'.'+parts[1] for line in native.get('opamPackages','').splitlines() if (parts:=line.split()) and not line.lstrip().startswith('#') and len(parts)==2}
        if not isinstance(actual,dict) or set(actual)!=(native_ids&DECLARATION_IDS) or actual.get(identity)!=_expected_native(evidence):
            raise ValueError('Normalized metadata/source differs from fresh qualified image')
    if files is not None:
        required={spec['path']:{k:spec[k] for k in ('bytes','sha256')} for spec in _sources(identity)}
        required['metadata/original-opam']={'bytes':policy['metadataBytes'],'sha256':policy['metadataSha256']}
        required.update({record['path']:{k:record[k] for k in ('bytes','sha256')} for record in installed.values()})
        required.update({r['path']:{k:r[k] for k in ('bytes','sha256')} for r in references})
        if source is not None: required[source['path']]={k:source[k] for k in ('bytes','sha256')}
        for path,record in required.items():
            if not isinstance(files.get(path),bytes) or _record(files[path])!=record: raise ValueError('Original/normalized/reference/source bytes differ')
        if any(path not in required and not path.startswith('source/captured/') for path in files):raise ValueError('Unexpected reviewed source member')
        original_semantics=_semantics(files['metadata/original-opam'],identity)
        if _semantics(files['metadata/installed-opam'],identity)!=original_semantics or sha(canonical(original_semantics))!=evidence['criticalMetadataSemanticsSha256']:
            raise ValueError('Original versus normalized metadata semantics differ')
        if 'archive' in policy:
            actual_notices=_archive_notices(files['source/original-archive'],identity)
            for path,data in actual_notices.items():
                if data!=by_path[path]['text'].encode(by_path[path]['encoding']):raise ValueError('Retained original source notice differs')
            if identity in AMBIENT_IDS:
                origin=files[REFERENCES['OCaml-atomic-origin']['path']]
                prefix=lambda raw:raw.split(b'(** Atomic references.',1)[0]
                if sha(prefix(origin))!=ATOMIC_HEADER_SHA or any(sha(prefix(data))!=ATOMIC_HEADER_SHA for path,data in actual_notices.items() if '/atomic/' in path):
                    raise ValueError('Atomic original license directive/origin relationship differs')
    return evidence

POLICIES = {'ambient-context-eio.0.2': {'archive': {'bytes': 13050,
                                         'checksums': ['sha256=f451f4ed467ef0c15f472cda1021a89e96afdf3a32970ea047faf057a01c72d3',
                                                       'sha512=3115fd7b45ac171f7a971013dd6f32ec317fc274d800a86870a0dd43574e27b404090fbc51dae5e4c8af4961d706f84abf3843a6cf8dc57f711211cd2b547780'],
                                         'path': 'source/original-archive',
                                         'sha256': 'f451f4ed467ef0c15f472cda1021a89e96afdf3a32970ea047faf057a01c72d3',
                                         'url': 'https://github.com/ocaml-tracing/ambient-context/releases/download/v0.2/ambient-context-0.2.tbz'},
                             'authors': ['ELLIOTTCABLE', 'c-cube'],
                             'declaredLicense': 'MIT',
                             'licenseExpression': 'LicenseRef-Reviewed-Ambient-Context-0.2-Per-File',
                             'metadataBytes': 1187,
                             'metadataSha256': '3caa1721bd734ee0a826159b743ad66424fbeb32ed4535ff0136467159dc8807',
                             'name': 'ambient-context-eio',
                             'references': ['MIT', 'OCaml-LICENSE', 'OCaml-atomic-origin'],
                             'version': '0.2'},
 'ambient-context-lwt.0.2': {'archive': {'bytes': 13050,
                                         'checksums': ['sha256=f451f4ed467ef0c15f472cda1021a89e96afdf3a32970ea047faf057a01c72d3',
                                                       'sha512=3115fd7b45ac171f7a971013dd6f32ec317fc274d800a86870a0dd43574e27b404090fbc51dae5e4c8af4961d706f84abf3843a6cf8dc57f711211cd2b547780'],
                                         'path': 'source/original-archive',
                                         'sha256': 'f451f4ed467ef0c15f472cda1021a89e96afdf3a32970ea047faf057a01c72d3',
                                         'url': 'https://github.com/ocaml-tracing/ambient-context/releases/download/v0.2/ambient-context-0.2.tbz'},
                             'authors': ['ELLIOTTCABLE', 'c-cube'],
                             'declaredLicense': 'MIT',
                             'licenseExpression': 'LicenseRef-Reviewed-Ambient-Context-0.2-Per-File',
                             'metadataBytes': 1189,
                             'metadataSha256': '2d34dbe15587e9df19ca767ca01c319b51a925a39f02940a2b4fa87a9e3c0506',
                             'name': 'ambient-context-lwt',
                             'references': ['MIT', 'OCaml-LICENSE', 'OCaml-atomic-origin'],
                             'version': '0.2'},
 'ambient-context.0.2': {'archive': {'bytes': 13050,
                                     'checksums': ['sha256=f451f4ed467ef0c15f472cda1021a89e96afdf3a32970ea047faf057a01c72d3',
                                                   'sha512=3115fd7b45ac171f7a971013dd6f32ec317fc274d800a86870a0dd43574e27b404090fbc51dae5e4c8af4961d706f84abf3843a6cf8dc57f711211cd2b547780'],
                                     'path': 'source/original-archive',
                                     'sha256': 'f451f4ed467ef0c15f472cda1021a89e96afdf3a32970ea047faf057a01c72d3',
                                     'url': 'https://github.com/ocaml-tracing/ambient-context/releases/download/v0.2/ambient-context-0.2.tbz'},
                         'authors': ['ELLIOTTCABLE', 'c-cube'],
                         'declaredLicense': 'MIT',
                         'licenseExpression': 'LicenseRef-Reviewed-Ambient-Context-0.2-Per-File',
                         'metadataBytes': 1399,
                         'metadataSha256': 'c2b060b2002cfec386028710431e43c6bed4424058248d7949e07f0f00da177b',
                         'name': 'ambient-context',
                         'references': ['MIT', 'OCaml-LICENSE', 'OCaml-atomic-origin'],
                         'version': '0.2'},
 'ocaml-config.3': {'authors': ['Louis Gesbert <louis.gesbert@ocamlpro.com>',
                                'David Allsopp <david.allsopp@metastack.com>'],
                    'declaredLicense': 'ISC',
                    'licenseExpression': 'ISC',
                    'metadataBytes': 1265,
                    'metadataSha256': 'eac491c01bd4de3e78443d55bd9948e107c9ad4c80b5d0f4c63de778b601aae3',
                    'name': 'ocaml-config',
                    'references': ['ISC'],
                    'version': '3'},
 'trace.0.12': {'archive': {'bytes': 159643,
                            'checksums': ['sha256=c173d6bf9433e9eeb41bbddda116a296373d45865841dcbb78bff3be8abd9fd8',
                                          'sha512=1105c52112095fdc8d4961d7346b02e416627bde6ac79ddd137bff63ac0ff5cd23fa53192be642614efadb9cb0cbb83b7d571bb5a0d100ad0ae6d10bc61d3bba'],
                            'path': 'source/original-archive',
                            'sha256': 'c173d6bf9433e9eeb41bbddda116a296373d45865841dcbb78bff3be8abd9fd8',
                            'url': 'https://github.com/ocaml-tracing/ocaml-trace/releases/download/v0.12/trace-0.12.tbz'},
                'authors': ['Simon Cruanes'],
                'declaredLicense': 'MIT',
                'licenseExpression': 'MIT',
                'metadataBytes': 1475,
                'metadataSha256': '942b81c308bfe5bc71cb69ee16f94c626f645fd6dcd0b52afae4704af358fbfe',
                'name': 'trace',
                'references': ['MIT'],
                'version': '0.12'}}
DECLARATION_IDS = frozenset(POLICIES)

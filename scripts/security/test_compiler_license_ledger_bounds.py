"""Only complete dependency ledgers receive 8 MiB; other JSON remains 4 MiB.

All large notices and sources below are explicitly synthetic size fixtures.
They are never represented as upstream legal or production evidence.
"""
import copy
from functools import lru_cache
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import zipfile

import compiler_license_ledger as ledger
import publish_semgrep_core_tool as publisher
import semgrep_core_tool as tool
from test_compiler_license_ledger import fixture_ledger
from test_semgrep_core_tool import fixture,elf,identified

MIB=1024**2
LEDGER_MEMBER='upstream/dependency-license-notices.json'


@lru_cache(maxsize=6)
def sized_fixture(target,binary_hash):
    value,old_sources,native=fixture_ledger(binary_hash)
    original=b'Copyright Synthetic Test Authors\nPermission is granted for this synthetic fixture only.\n'
    count=max(2,(target+MIB-1)//MIB)
    texts=[b'EXPLICIT SYNTHETIC SIZE TEST NOTICE '+str(i).encode()+b'\n'+b'x'*(MIB-65536) for i in range(count-1)]
    texts.append(b'EXPLICIT SYNTHETIC LAST SIZE TEST NOTICE\n')
    for _ in range(5):
        files={'COPYING':original}
        files.update({'COPYING-large-'+str(i):data for i,data in enumerate(texts)})
        source=ledger.source_archive(files)
        reference={'filename':'synthetic-large-notice-source.tar.xz','bytes':len(source),'sha256':ledger.digest(source),
                   'url':'https://example.org/explicitly-synthetic-size-test.tar.xz'}
        for c in value['components']:c['correspondingSource']=dict(reference)
        value['components'][0]['notices']=[ledger.notice('COPYING-large-'+str(i),data) for i,data in enumerate(texts)]
        difference=target-len(ledger.encoded(value))
        if difference==0:return value,{reference['filename']:source},native
        if difference>0:texts[-1]+=b'x'*difference
        elif -difference<len(texts[-1])-40:texts[-1]=texts[-1][:difference]
        else:raise AssertionError('Synthetic size fixture cannot reach exact requested size')
    raise AssertionError('Synthetic size fixture did not converge')


def changed_tool(contents,target):
    value,sources,_=sized_fixture(target,tool.digest(elf()))
    contents[LEDGER_MEMBER]=tool.canonical(value)
    contents['upstream/corresponding-source.tar.xz']=ledger.source_archive({'dependency-sources/'+n:d for n,d in sources.items()})
    provenance=tool.unique_json(contents['upstream/provenance.json'])
    provenance['correspondingSourceSha256']=tool.digest(contents['upstream/corresponding-source.tar.xz'])
    contents['upstream/provenance.json']=tool.canonical(provenance)


def repack(contents,pin):
    inner=publisher.archive_bytes({n:(d,0o755 if n=='bin/semgrep-core' else 0o644,'regular') for n,d in contents.items()})
    output=io.BytesIO()
    with zipfile.ZipFile(output,'w') as archive:archive.writestr(tool.ARCHIVE,inner)
    data=output.getvalue();pin=copy.deepcopy(pin)
    pin['archive']={'name':tool.ARCHIVE,**identified(inner)};pin['artifact'].update(identified(data))
    pin['manifestSha256']=tool.digest(contents['tool-manifest.json'])
    return data,pin


class DedicatedLedgerJsonBoundTests(unittest.TestCase):
    def test_below_and_exact_ledger_bound_pass_complete_notice_and_source_validation(self):
        for size in (ledger.MAX_LEDGER_JSON-1,ledger.MAX_LEDGER_JSON):
            value,sources,native=sized_fixture(size,'b'*64)
            self.assertEqual(len(ledger.encoded(value)),size)
            ledger.validate_ledger(value,'b'*64,native)
            ledger.validate_sources(value,sources.__getitem__)

    def test_one_byte_over_ledger_bound_rejected_without_truncating_notices(self):
        value,_,native=sized_fixture(ledger.MAX_LEDGER_JSON+1,'b'*64)
        before=ledger.encoded(value)
        with self.assertRaisesRegex(ValueError,'consumer JSON bound'):ledger.validate_ledger(value,'b'*64,native)
        self.assertEqual(ledger.encoded(value),before)

    def test_tool_exact_ledger_member_over_old_limit_passes_full_verified_source_chain(self):
        target=tool.MAX_JSON+1024
        data,pin,contents=fixture(lambda contents:changed_tool(contents,target))
        core,manifest,actual=tool.verify_zip(data,pin,with_contents=True)
        self.assertEqual(core,elf());self.assertEqual(len(actual[LEDGER_MEMBER]),target)
        self.assertEqual(manifest['files'][LEDGER_MEMBER]['bytes'],target)

    def test_tool_exact_eight_mib_ledger_passes_and_next_byte_is_rejected(self):
        data,pin,_=fixture(lambda contents:changed_tool(contents,ledger.MAX_LEDGER_JSON))
        self.assertEqual(tool.verify_zip(data,pin)[0],elf())
        data,pin,_=fixture(lambda contents:changed_tool(contents,ledger.MAX_LEDGER_JSON+1))
        with self.assertRaisesRegex(ValueError,'retention bounds'):tool.verify_zip(data,pin)

    def test_tool_sbom_and_provenance_json_still_require_old_four_mib_bound(self):
        for name in ('upstream/toolchain-sbom.cdx.json','upstream/provenance.json'):
            def change(contents):contents[name]=b'{"synthetic":"'+b'x'*tool.MAX_JSON+b'"}'
            data,pin,_=fixture(change)
            with self.subTest(name=name),self.assertRaisesRegex(ValueError,'retention bounds'):tool.verify_zip(data,pin)

    def test_tool_manifest_json_still_requires_old_four_mib_bound(self):
        _,pin,contents=fixture();contents['tool-manifest.json']+=b' '*(tool.MAX_JSON+1-len(contents['tool-manifest.json']))
        data,pin=repack(contents,pin)
        with self.assertRaisesRegex(ValueError,'retention bounds'):tool.verify_zip(data,pin)

    def test_similarly_named_or_alternate_ledger_member_cannot_receive_allowance(self):
        target=tool.MAX_JSON+1024
        def change(contents):
            changed_tool(contents,target)
            contents['upstream/toolchain-sbom.cdx.json']=contents[LEDGER_MEMBER]
        data,pin,_=fixture(change)
        with self.assertRaisesRegex(ValueError,'retention bounds'):tool.verify_zip(data,pin)
        def extra(archive):
            name='upstream/renamed-dependency-license-notices.json';value=b'x'*(tool.MAX_JSON+1)
            item=tarfile.TarInfo(name);item.mode=0o644;item.size=len(value);archive.addfile(item,io.BytesIO(value))
        data,pin,_=fixture(extra_tar=extra)
        with self.assertRaisesRegex(ValueError,'Unexpected tool tar member'):tool.verify_zip(data,pin)

    def test_publisher_reads_ledger_at_exact_new_bound_and_retains_all_original_bytes(self):
        value,sources,native=sized_fixture(ledger.MAX_LEDGER_JSON,'b'*64)
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);directory=root/'sources';directory.mkdir()
            for name,data in sources.items():(directory/name).write_bytes(data)
            file=root/'actual-argument-ledger.json';file.write_bytes(ledger.encoded(value))
            notices,members=publisher.license_ledger(file,directory,'b'*64,native)
            self.assertEqual(notices,ledger.encoded(value));self.assertEqual(len(members),1)

    def test_publisher_rejects_oversized_ledger_file_before_json_parse(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);file=root/'ledger.json';file.write_bytes(b'x'*(ledger.MAX_LEDGER_JSON+1))
            with patch.object(publisher,'unique_json') as parse,self.assertRaisesRegex(ValueError,'oversized input'):
                publisher.license_ledger(file,root,'b'*64)
            parse.assert_not_called()

    def test_generic_opam_and_github_json_limits_remain_four_mib(self):
        self.assertEqual(ledger.MAX_JSON,4*MIB);self.assertEqual(tool.MAX_JSON,4*MIB)
        self.assertEqual(ledger.MAX_LEDGER_JSON,8*MIB)
        with self.assertRaisesRegex(ValueError,'Opam definition exceeds bound'):ledger.opam_blocks('x'*(ledger.MAX_JSON+1),'url')
        response=io.BytesIO(b'x'*(tool.MAX_JSON+1))
        class Reply:
            status=200
            headers={}
            def __enter__(self):return self
            def __exit__(self,*args):pass
            def read(self,n):return response.read(n)
        class Opener:
            def open(self,*args,**kwargs):return Reply()
        with patch.object(tool.urllib.request,'build_opener',return_value=Opener()),self.assertRaisesRegex(ValueError,'pinned size bound'):
            tool.github_request('repos/synthetic/gp/actions/runs/1','synthetic-not-a-secret',tool.MAX_JSON)


if __name__=='__main__':unittest.main()

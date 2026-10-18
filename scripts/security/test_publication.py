import json
from pathlib import Path
import tempfile
import unittest
from publish_artifacts import publish
from gates import secret_finding, remaining_findings, validate_exceptions
import datetime as dt


class PublicationTests(unittest.TestCase):
    def test_unredacted_error_and_source_snippets_never_leave_runner(self):
        with tempfile.TemporaryDirectory() as directory:
            source=Path(directory)/'raw';source.mkdir();target=Path(directory)/'public'
            sentinel='SYNTHETIC-DO-NOT-PUBLISH-VALUE'
            for name in ('secrets-dir.json','sast.json','scanner.stdout','scanner.stderr'):
                (source/name).write_text(json.dumps({'Secret':sentinel,'extra':{'lines':sentinel}}))
            (source/'gate-result.json').write_text(json.dumps({'gate':'secrets','exitCode':2,'complete':False,'passed':False,'status':'tool_or_coverage_error','error':sentinel,'commands':[sentinel]}))
            self.assertEqual(publish(source,target,'secrets'),0)
            self.assertEqual([p.name for p in target.iterdir()],['gate-summary.json'])
            text=(target/'gate-summary.json').read_text()
            self.assertNotIn(sentinel,text);self.assertFalse(json.loads(text)['passed'])

    def test_malformed_receipt_cannot_publish_success_or_raw_error(self):
        with tempfile.TemporaryDirectory() as directory:
            source=Path(directory)/'raw';source.mkdir();target=Path(directory)/'public'
            (source/'gate-result.json').write_text('{UNTRUSTED-SECRET')
            self.assertEqual(publish(source,target,'sast'),2)
            self.assertNotIn('UNTRUSTED',(target/'gate-summary.json').read_text())

    def test_sbom_strips_source_paths_properties_and_code(self):
        with tempfile.TemporaryDirectory() as directory:
            source=Path(directory)/'raw';source.mkdir();target=Path(directory)/'public'
            (source/'gate-result.json').write_text(json.dumps({'gate':'sbom','exitCode':0,'complete':True,'passed':True,'status':'passed','details':{'components':1}}))
            (source/'sbom.cdx.json').write_text(json.dumps({'bomFormat':'CycloneDX','metadata':{'path':'PRIVATE'},'components':[{'type':'library','name':'@example/scoped','version':'1.0.0','properties':[{'value':'PRIVATE'}],'description':'PRIVATE'},{'type':'file','name':'/PRIVATE/lockfile'}]}))
            (source/'release-inventory.json').write_text('{"private":"PRIVATE"}')
            self.assertEqual(publish(source,target,'sbom'),0)
            self.assertNotIn('PRIVATE',''.join(p.read_text() for p in target.iterdir()))

    def test_secret_exception_requires_exact_actual_blob_and_location(self):
        with tempfile.TemporaryDirectory() as directory:
            stage=Path(directory);path=stage/'fixture.js';path.write_bytes(b'synthetic fixture\n')
            item={'Secret':'REDACTED','RuleID':'generic-api-key','File':str(path),'StartLine':1,'EndLine':1,'Commit':''}
            finding=secret_finding(item,'dir',stage,stage)
            exceptions=[{'scanner':'secrets','fingerprint':finding['fingerprint'],'sourceSha256':finding['sourceSha256']}]
            self.assertEqual(remaining_findings('secrets',[finding],exceptions),[])
            path.write_bytes(b'new synthetic fixture\n')
            self.assertEqual(len(remaining_findings('secrets',[secret_finding(item,'dir',stage,stage)],exceptions)),1)
            path.write_bytes(b'synthetic fixture\n');item['StartLine']=2
            self.assertEqual(len(remaining_findings('secrets',[secret_finding(item,'dir',stage,stage)],exceptions)),1)
            item['Secret']='UNREDACTED-SYNTHETIC'
            with self.assertRaises(ValueError):secret_finding(item,'dir',stage,stage)

    def test_real_exception_file_is_bounded_and_no_new_fingerprint_matches(self):
        policy=json.loads((Path(__file__).with_name('exceptions.json')).read_text())
        items=validate_exceptions(policy,dt.date(2026,10,18))
        self.assertEqual(len(items),28)
        self.assertEqual({e['scanner'] for e in items},{'secrets'})
        self.assertEqual({e['expiresOn'] for e in items},{'2026-11-01'})
        for e in items:
            for change in ('fingerprint','sourceSha256'):
                finding={'fingerprint':e['fingerprint'],'sourceSha256':e['sourceSha256']}
                finding[change]='0'*64
                self.assertEqual(remaining_findings('secrets',[finding],items),[finding])
        with self.assertRaises(ValueError):validate_exceptions(policy,dt.date(2026,11,2))

    def test_workflow_uploads_no_raw_scanner_files(self):
        workflow=(Path(__file__).resolve().parents[2]/'.github/workflows/security.yml').read_text()
        uploads=workflow.split('uses: actions/upload-artifact@')[1:]
        self.assertEqual(len(uploads),4)
        for upload in uploads:
            body=upload.split('\n  security-',1)[0]
            self.assertNotIn('security-results',body)
            self.assertNotIn('*.json',body)
            self.assertIn('security-public/gate-summary.json',body)


if __name__=='__main__':unittest.main()

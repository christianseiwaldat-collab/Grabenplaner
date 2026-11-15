import json
import copy
from pathlib import Path
import tempfile
import unittest
from publish_artifacts import publish
from gates import secret_finding, remaining_findings, validate_exceptions
import datetime as dt


class PublicationTests(unittest.TestCase):
    def runtime_components(self):
        source=Path(__file__).parent/'import-verifier-assets/known-af-v2-temurin17.0.21_9-jackcess4.0.12-r1/payload/runtime-components.cdx.json'
        return json.loads(source.read_bytes())['components']

    def publish_runtime(self,directory,components):
        source=Path(directory)/'raw';source.mkdir();target=Path(directory)/'public'
        (source/'gate-result.json').write_text(json.dumps({'gate':'sbom','exitCode':0,'complete':True,'passed':True,'status':'passed','details':{'runtimeAssets':{'status':'declared_source_only'}}}))
        (source/'sbom.cdx.json').write_text(json.dumps({'bomFormat':'CycloneDX','components':components}))
        (source/'release-inventory.json').write_text('{"private":"PRIVATE-RUNTIME-SENTINEL"}')
        return publish(source,target,'sbom'),target

    def test_real_six_runtime_components_and_npm_publish_only_selected_identities(self):
        components=self.runtime_components()
        for item in components:
            item.update(properties=[{'name':'path','value':'PRIVATE-RUNTIME-SENTINEL'}],description='PRIVATE-RUNTIME-SENTINEL',source='/PRIVATE-RUNTIME-SENTINEL/source')
        components.extend([{'type':'library','name':'@example/scoped','version':'1.0.0','properties':[{'value':'PRIVATE-RUNTIME-SENTINEL'}]},
                           {'type':'file','name':'/PRIVATE-RUNTIME-SENTINEL/lockfile'}])
        with tempfile.TemporaryDirectory() as directory:
            code,target=self.publish_runtime(directory,components)
            self.assertEqual(code,0)
            public=json.loads((target/'sbom.cdx.json').read_bytes())['components']
            self.assertEqual(len(public),7)
            expected=[{k:item[k] for k in ('type','name','group','version') if k in item} for item in self.runtime_components()]
            self.assertEqual([{k:v for k,v in item.items() if k!='bom-ref'} for item in public[:6]],expected)
            self.assertEqual(public[-1]['group'],'@example')
            self.assertTrue(all(set(item)<=set(('type','name','group','version','bom-ref')) for item in public))
            self.assertNotIn('PRIVATE-RUNTIME-SENTINEL',''.join(p.read_text() for p in target.iterdir()))
            self.assertTrue(json.loads((target/'gate-summary.json').read_bytes())['passed'])

    def test_runtime_identity_hash_purl_type_and_path_drift_fail_closed(self):
        original=self.runtime_components()
        for index in range(6):
            for key,value in (('name','../../PRIVATE-RUNTIME-SENTINEL'),('group','@unreviewed'),
                              ('version','999.0'),('type','operating-system'),('bom-ref','gp-unknown'),
                              ('purl','file:///PRIVATE-RUNTIME-SENTINEL'),
                              ('hashes',[{'alg':'SHA-256','content':'0'*64}])):
                components=copy.deepcopy(original);components[index][key]=value
                with self.subTest(index=index,key=key),tempfile.TemporaryDirectory() as directory:
                    code,target=self.publish_runtime(directory,components)
                    self.assertEqual(code,2)
                    self.assertFalse(json.loads((target/'gate-summary.json').read_bytes())['passed'])
                    self.assertFalse((target/'sbom.cdx.json').exists())
                    self.assertNotIn('PRIVATE-RUNTIME-SENTINEL',(target/'gate-summary.json').read_text())

    def test_missing_duplicate_extra_runtime_kinds_and_invalid_npm_are_rejected(self):
        original=self.runtime_components()
        variants=[original[:-1],[],original+[copy.deepcopy(original[0])],
                  original+[{'type':'application','name':'unreviewed','version':'1'}],
                  original+[{'type':'platform','name':'other-runtime','version':'1'}],
                  original+[{'type':'library','name':'x','group':'org.unreviewed','version':'1','purl':'pkg:maven/org.unreviewed/x@1'}],
                  original+[{'type':'library','name':'../../PRIVATE-RUNTIME-SENTINEL','version':'1'}]]
        for index,components in enumerate(variants):
            with self.subTest(index=index),tempfile.TemporaryDirectory() as directory:
                code,target=self.publish_runtime(directory,components)
                self.assertEqual(code,2)
                self.assertFalse(json.loads((target/'gate-summary.json').read_bytes())['passed'])
                self.assertFalse((target/'sbom.cdx.json').exists())

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
        # This is the maintained real policy, not a synthetic dated fixture.
        # New reviewed entries must be valid today without freezing its size or
        # confusing later reviews with future-dated exceptions.
        items=validate_exceptions(policy,dt.datetime.now(dt.timezone.utc).date())
        self.assertTrue(items)
        self.assertEqual(len(items),len(policy['findingExceptions']))
        self.assertEqual({e['scanner'] for e in items},{'secrets'})
        for e in items:
            for change in ('fingerprint','sourceSha256'):
                finding={'fingerprint':e['fingerprint'],'sourceSha256':e['sourceSha256']}
                finding[change]='0'*64
                self.assertEqual(remaining_findings('secrets',[finding],items),[finding])
        after_last_expiry=max(dt.date.fromisoformat(e['expiresOn']) for e in items)+dt.timedelta(days=1)
        with self.assertRaises(ValueError):validate_exceptions(policy,after_last_expiry)

    def test_workflow_uploads_no_raw_scanner_files(self):
        workflow=(Path(__file__).resolve().parents[2]/'.github/workflows/security.yml').read_text()
        uploads=workflow.split('uses: actions/upload-artifact@')[1:]
        self.assertEqual(len(uploads),4)
        for upload in uploads:
            body=upload.split('\n  security-',1)[0]
            self.assertNotIn('security-results',body)
            self.assertNotIn('*.json',body)
            self.assertIn('security-public/gate-summary.json',body)

    def test_each_workflow_upload_requires_preflight_and_retains_only_bound_files(self):
        root=Path(__file__).resolve().parents[2]
        workflow=(root/'.github/workflows/security.yml').read_text()
        action=json.loads((root/'scripts/security/tools.json').read_text())['actions']['actions/upload-artifact']
        self.assertEqual(action['ref'],'v7.0.2')
        self.assertEqual(action['runtime'],'node24')
        for gate in ('sca','sast','secrets','sbom'):
            job=workflow.split('\n  security-'+gate+':\n',1)[1].split('\n  security-',1)[0]
            self.assertIn('uses: actions/upload-artifact@'+action['sha'],job)
            prepare='python scripts/security/prepare_upload.py --gate '+gate
            self.assertLess(job.index(prepare),job.index('uses: actions/upload-artifact@'))
            upload=job[job.index('      - name: Preserve sanitized security receipts'):job.index('      - name: Require artifact identity and archive digest')]
            self.assertIn("if: always() && steps.prepare-upload.outcome == 'success'",upload)
            self.assertIn('security-'+gate+'-${{ github.run_id }}-${{ github.run_attempt }}',upload)
            for required in ('retention-days: 14','archive: true','overwrite: false','include-hidden-files: false','if-no-files-found: error','security-public/upload-manifest.json'):
                self.assertIn(required,upload)
            self.assertNotIn('continue-on-error:',job)
            self.assertIn('ARTIFACT_DIGEST: ${{ steps.upload.outputs.artifact-digest }}',job)
            self.assertIn('python scripts/security/prepare_upload.py --uploaded-receipt',job)


if __name__=='__main__':unittest.main()

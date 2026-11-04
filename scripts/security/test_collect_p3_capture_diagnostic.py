import copy
import hashlib
import io
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import urllib.error
import zipfile

import collect_p3_capture_diagnostic as diagnostic


class CapturedDiagnosticTests(unittest.TestCase):
    def setUp(self):
        environment = patch.dict(os.environ, dict(os.environ), clear=True)
        environment.start()
        self.addCleanup(environment.stop)

    def api_fixture(self):
        run = {'id': diagnostic.P3_RUN, 'head_sha': diagnostic.P3_HEAD, 'workflow_id': diagnostic.P3_WORKFLOW,
            'run_attempt': 1, 'path': '.github/workflows/sast-source-build.yml', 'repository': {'id': diagnostic.REPOSITORY_ID},
            'head_repository': {'id': diagnostic.REPOSITORY_ID}, 'status': 'completed', 'conclusion': 'failure', 'event': 'workflow_dispatch'}
        artifact = {'id': diagnostic.ARTIFACT_ID, 'name': diagnostic.ARTIFACT_NAME, 'expired': False,
            'digest': 'sha256:' + diagnostic.ARTIFACT_SHA256, 'size_in_bytes': diagnostic.ARTIFACT_BYTES,
            'workflow_run': {'id': diagnostic.P3_RUN, 'head_sha': diagnostic.P3_HEAD,
                'repository_id': diagnostic.REPOSITORY_ID, 'head_repository_id': diagnostic.REPOSITORY_ID},
            'archive_download_url': diagnostic.API + '/actions/artifacts/' + str(diagnostic.ARTIFACT_ID) + '/zip'}
        names = ['Build the official upstream target and qualify whole files and controls',
            'Verify bounded upstream-only license capture even after a collection failure',
            'Retain exact upstream-only license capture without another compiler build']
        jobs = {'total_count': 1, 'jobs': [{'run_id': diagnostic.P3_RUN, 'head_sha': diagnostic.P3_HEAD,
            'steps': [{'name': name, 'conclusion': 'success'} for name in names]}]}
        return run, artifact, jobs

    def test_exact_original_failed_run_can_supply_successful_build_and_verified_capture(self):
        diagnostic.verify_api(*self.api_fixture(), diagnostic.ARTIFACT_ID, diagnostic.ARTIFACT_SHA256)

    def test_wrong_repo_head_attempt_workflow_artifact_or_step_cannot_authorize_capture(self):
        changes = [('repository', lambda r,a,j:r['repository'].update(id=1)),
            ('head', lambda r,a,j:r.update(head_sha='0'*40)), ('attempt', lambda r,a,j:r.update(run_attempt=2)),
            ('workflow', lambda r,a,j:r.update(workflow_id=1)), ('artifact', lambda r,a,j:a.update(id=1)),
            ('digest', lambda r,a,j:a.update(digest='sha256:'+'0'*64)),
            ('fork-artifact', lambda r,a,j:a['workflow_run'].update(head_repository_id=1)),
            ('expired', lambda r,a,j:a.update(expired=True)), ('step-failed', lambda r,a,j:j['jobs'][0]['steps'][0].update(conclusion='failure'))]
        for name, change in changes:
            with self.subTest(name=name):
                run, artifact, jobs = self.api_fixture(); change(run, artifact, jobs)
                with self.assertRaises(ValueError): diagnostic.verify_api(run, artifact, jobs, diagnostic.ARTIFACT_ID, diagnostic.ARTIFACT_SHA256)

    def test_token_is_allowed_only_for_the_exact_github_repository_api(self):
        with patch.object(diagnostic.urllib.request, 'build_opener') as opener:
            for url in ('https://example.invalid/source', 'https://api.github.com/repos/other/project/actions/runs/1',
                    'http://api.github.com/repos/' + diagnostic.REPOSITORY + '/actions/runs/1'):
                with self.subTest(url=url), self.assertRaises(ValueError): diagnostic.request(url, 'synthetic-token')
            opener.assert_not_called()

    def test_api_queries_are_allowed_without_forwarding_tokens_to_redirected_source(self):
        with patch.object(diagnostic.urllib.request, 'build_opener') as opener:
            diagnostic.request(diagnostic.API + '/actions/runs/1/jobs?per_page=10', 'synthetic-token')
            request = opener.return_value.open.call_args.args[0]
            self.assertEqual(request.get_header('Authorization'), 'Bearer synthetic-token')
        payload = b'original ZIP placeholder'
        redirect = urllib.error.HTTPError(diagnostic.API, 302, 'redirect', {'Location': 'https://example.invalid/artifact?signature=synthetic'}, None)
        with tempfile.TemporaryDirectory() as temporary, patch.object(diagnostic, 'request', side_effect=[redirect, io.BytesIO(payload)]) as fetch:
            diagnostic.download_capture(diagnostic.ARTIFACT_ID, 'synthetic-token', Path(temporary)/'archive.zip',
                {'bytes':len(payload),'sha256':hashlib.sha256(payload).hexdigest()})
            self.assertEqual(fetch.call_args_list[0].args[1], 'synthetic-token')
            self.assertIsNone(fetch.call_args_list[1].args[1])

    def test_source_environment_contains_no_github_or_runtime_token(self):
        with patch.dict(os.environ, {'PATH':'/usr/bin:/bin','HOME':'/tmp/synthetic-home','GH_TOKEN':'synthetic',
                'GITHUB_TOKEN':'synthetic','ACTIONS_RUNTIME_TOKEN':'synthetic'}, clear=True):
            diagnostic.clean_source_environment()
            self.assertNotIn('GH_TOKEN',os.environ)
            self.assertNotIn('GITHUB_TOKEN',os.environ)
            self.assertNotIn('ACTIONS_RUNTIME_TOKEN',os.environ)
            self.assertEqual(os.environ['PATH'],'/usr/bin:/bin')

    def zip(self, root, names=('capture.tar.xz','capture-receipt.json'), symlink=False):
        archive = root/'artifact.zip'
        with zipfile.ZipFile(archive,'w') as bundle:
            for i,name in enumerate(names):
                info=zipfile.ZipInfo(name)
                info.create_system=3
                info.external_attr=((stat.S_IFLNK if symlink and i==0 else stat.S_IFREG)|0o600)<<16
                bundle.writestr(info,b'original hull bytes')
        return archive

    def test_zip_extracts_only_two_original_regular_hull_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);archive=self.zip(root);hull=root/'hull'
            diagnostic.extract_hull(archive,hull)
            self.assertEqual({p.name for p in hull.iterdir()},{'capture.tar.xz','capture-receipt.json'})
            self.assertEqual((hull/'capture.tar.xz').read_bytes(),b'original hull bytes')

    def test_zip_unknown_duplicate_traversal_and_symlink_members_are_rejected(self):
        for names,link in [(('capture.tar.xz','extra'),False),(('capture.tar.xz','capture.tar.xz'),False),
                (('../capture.tar.xz','capture-receipt.json'),False),(('capture.tar.xz','capture-receipt.json'),True),
                (('capture.tar.xz','capture-receipt.json','third'),False)]:
            with self.subTest(names=names,link=link),tempfile.TemporaryDirectory() as temporary:
                root=Path(temporary);archive=self.zip(root,names,link)
                with self.assertRaises(ValueError):diagnostic.extract_hull(archive,root/'hull')
                self.assertFalse((root.parent/'capture.tar.xz').exists())

    def test_download_does_not_accept_a_short_or_wrong_hash_archive(self):
        for expected in ({'bytes':5,'sha256':hashlib.sha256(b'wrong').hexdigest()}, {'bytes':100,'sha256':'0'*64}):
            with (self.subTest(expected=expected),tempfile.TemporaryDirectory() as temporary,
                    patch.object(diagnostic,'request',return_value=io.BytesIO(b'short'))):
                with self.assertRaises(ValueError):diagnostic.download_capture(diagnostic.ARTIFACT_ID,'synthetic',Path(temporary)/'zip',expected)

    def test_actual_metadata_cannot_be_replaced_by_partial_or_wrong_image_binary_or_package_set(self):
        packages=[{'id':'synthetic'+str(i)+'.1'} for i in range(249)]
        value={'format':'gp-semgrep-core-actual-license-inputs/v1','captureComplete':True,'imageId':diagnostic.IMAGE_ID,
            'binarySha256':diagnostic.BINARY_SHA256,'opamPackages':packages,'opamListing':'synthetic',
            'nativeInputs':[{'owner':'musl.synthetic'}],'apkPackages':[{'id':'musl.synthetic'}]}
        ledger=SimpleNamespace(opam_ids=lambda text:sorted(row['id'] for row in packages),
            digest=lambda data:hashlib.sha256(data).hexdigest(),encoded=lambda data:json.dumps(data).encode())
        receipt={'imageId':diagnostic.IMAGE_ID,'binarySha256':diagnostic.BINARY_SHA256}
        self.assertEqual(diagnostic.validate_actual(value,receipt,diagnostic.IMAGE_ID,diagnostic.BINARY_SHA256,ledger)['nativePackageIds'],['musl.synthetic'])
        for change in ('partial','image','binary','missing-package','duplicate-package'):
            altered=copy.deepcopy(value)
            if change=='partial':altered['captureComplete']=False
            if change=='image':altered['imageId']='sha256:'+'0'*64
            if change=='binary':altered['binarySha256']='0'*64
            if change=='missing-package':altered['opamPackages'].pop()
            if change=='duplicate-package':altered['opamPackages'][0]=altered['opamPackages'][1]
            with self.subTest(change=change),self.assertRaises(ValueError):
                diagnostic.validate_actual(altered,receipt,diagnostic.IMAGE_ID,diagnostic.BINARY_SHA256,ledger)

    def test_unix_extraction_is_explicitly_blocked_on_windows(self):
        with patch.object(diagnostic.sys,'platform','win32'):
            with self.assertRaisesRegex(ValueError,'native Linux'):diagnostic.extract_source(None,None,None,None)
            with self.assertRaisesRegex(ValueError,'native Linux'):diagnostic.restore_cache_aliases(None,None,None)

    def alias_fixture(self,root,target_text=None,chain=False):
        data=b'actual captured cache source'
        md5=hashlib.md5(data).hexdigest();sha256=hashlib.sha256(data).hexdigest();sha512=hashlib.sha512(data).hexdigest()
        target='opam-download-cache/sha512/'+sha512[:2]+'/'+sha512
        regular=diagnostic.safe_parent(root,target);regular.write_bytes(data)
        alias='opam-download-cache/md5/'+md5[:2]+'/'+md5
        paths=[target]
        if chain:
            middle='opam-download-cache/sha256/'+sha256[:2]+'/'+sha256
            descriptor=diagnostic.safe_parent(root,middle+'.symlink-target')
            descriptor.write_text('../../sha512/'+sha512[:2]+'/'+sha512)
            target_text='../../sha256/'+sha256[:2]+'/'+sha256
            paths.append(middle+'.symlink-target')
        descriptor=diagnostic.safe_parent(root,alias+'.symlink-target')
        descriptor.write_text(target_text if target_text is not None else '../../sha512/'+sha512[:2]+'/'+sha512)
        paths.append(alias+'.symlink-target')
        inventory=[{'path':name,**diagnostic.sha_file(root/name,diagnostic.CHUNK)} for name in paths]
        return alias,target,inventory

    @unittest.skipUnless(sys.platform=='linux','Native POSIX source extraction fixture')
    def test_explicit_relative_cache_aliases_and_forward_chains_preserve_checksum_identity(self):
        for chain in (False,True):
            with self.subTest(chain=chain),tempfile.TemporaryDirectory() as temporary:
                root=Path(temporary);alias,target,inventory=self.alias_fixture(root,chain=chain)
                records=diagnostic.restore_cache_aliases(root,inventory,None)
                self.assertEqual((root/alias).resolve(),root/target)
                self.assertEqual(len(records),2 if chain else 1)
                self.assertTrue((root/(alias+'.symlink-target')).is_file())

    @unittest.skipUnless(sys.platform=='linux','Native POSIX cache containment fixture')
    def test_absolute_escape_backtracking_and_missing_cache_alias_targets_are_rejected(self):
        for text in ('/etc/passwd','../../../opam-download-cache/sha512/'+'0'*2+'/'+'0'*128,
                '../../sha512/'+'0'*2+'/'+'0'*128,'../../../../outside'):
            with self.subTest(text=text),tempfile.TemporaryDirectory() as temporary:
                root=Path(temporary);alias,target,inventory=self.alias_fixture(root,text)
                with self.assertRaises(ValueError):diagnostic.restore_cache_aliases(root,inventory,None)
                self.assertFalse((root/alias).is_symlink())

    @unittest.skipUnless(sys.platform=='linux','Native POSIX immutable cache checksum fixture')
    def test_cache_alias_cannot_relabel_different_original_target_bytes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);alias,target,inventory=self.alias_fixture(root)
            (root/target).write_bytes(b'changed cache bytes')
            with self.assertRaisesRegex(ValueError,'changed|checksum'):
                diagnostic.restore_cache_aliases(root,inventory,None)
            self.assertFalse((root/alias).is_symlink())

    @unittest.skipUnless(sys.platform=='linux','Native POSIX streaming extraction fixture')
    def test_streamed_original_capture_becomes_regular_source_bytes_and_only_scoped_cache_links(self):
        import compiler_capture_archive as archive_module
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);source=root/'source';source.mkdir(mode=0o700);hull=root/'hull';hull.mkdir(mode=0o700)
            (source/'capture.json').write_bytes(b'{"captureComplete":false}')
            file=diagnostic.safe_parent(source,'opam-sources/probe/empty');file.write_bytes(b'')
            outside=root/'outside';outside.write_bytes(b'outside bytes must not be opened')
            os.symlink(str(outside),source/'opam-sources/probe/outside-link')
            alias,target,unused=self.alias_fixture(source)
            # The helper's fixture supplied descriptor bytes; use a real source
            # link to exercise the original capture's target-text representation.
            descriptor=source/(alias+'.symlink-target')
            text=descriptor.read_text();descriptor.unlink();os.symlink(text,source/alias)
            receipt=archive_module.write_capture(source,hull,diagnostic.IMAGE_ID,diagnostic.BINARY_SHA256)
            archive_module.verify_capture(hull)
            extracted=root/'extracted'
            records=diagnostic.extract_source(archive_module,hull,extracted,receipt)
            self.assertEqual((extracted/alias).resolve(),extracted/target)
            self.assertEqual(len(records),1)
            self.assertTrue((extracted/'opam-sources/probe/empty').is_file())
            self.assertFalse((extracted/'opam-sources/probe/outside-link').exists())
            self.assertEqual((extracted/'opam-sources/probe/outside-link.symlink-target').read_bytes(),os.fsencode(str(outside)))

    @unittest.skipUnless(sys.platform=='linux','Native POSIX cache cycle fixture')
    def test_cache_alias_cycles_are_rejected_before_any_link_is_created(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);md5='0'*32;sha256='1'*64
            one='opam-download-cache/md5/00/'+md5
            two='opam-download-cache/sha256/11/'+sha256
            diagnostic.safe_parent(root,one+'.symlink-target').write_text('../../sha256/11/'+sha256)
            diagnostic.safe_parent(root,two+'.symlink-target').write_text('../../md5/00/'+md5)
            rows=[{'path':name+'.symlink-target',**diagnostic.sha_file(root/(name+'.symlink-target'),diagnostic.CHUNK)} for name in (one,two)]
            with self.assertRaisesRegex(ValueError,'Cyclic'):diagnostic.restore_cache_aliases(root,rows,None)
            self.assertFalse((root/one).is_symlink());self.assertFalse((root/two).is_symlink())


    def test_upload_has_explicit_upstream_scope_and_hashes_without_security_receipt(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for name, content in [('public/diagnostic-summary.json', b'{"diagnosticOnly":true}'),
                    ('private/collection-failure.json', b'{"phase":"synthetic-upstream"}'),
                    ('private/unlisted-business-data.json', b'not allowed'),
                    ('private/gate-result.json', b'not a scanner gate'),
                    ('dependency-sources/actual-source.tar.xz', b'upstream source placeholder'),
                    ('dependency-sources/unlisted.txt', b'not allowed')]:
                target = root / name; target.parent.mkdir(exist_ok=True, parents=True); target.write_bytes(content)
            result = diagnostic.prepare_diagnostic_upload(root, 'failure')
            self.assertFalse(result['publicationReady'])
            self.assertEqual(len(result['files']), 3)
            self.assertFalse((root / 'upload/private/gate-result.json').exists())
            self.assertFalse((root / 'upload/private/unlisted-business-data.json').exists())
            self.assertFalse((root / 'upload/dependency-sources/unlisted.txt').exists())
            for row in result['files']:
                self.assertEqual(diagnostic.sha_file(root / 'upload' / row['path'], diagnostic.MAX_ZIP),
                    {key: row[key] for key in ('bytes', 'sha256')})
            saved = json.loads((root / 'upload/upstream-diagnostic-manifest.json').read_text())
            self.assertEqual(saved, result)

    def test_upload_refuses_reuse_and_invalid_outcome(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            with self.assertRaisesRegex(ValueError, 'context'):
                diagnostic.prepare_diagnostic_upload(root, 'invented-pass')
            diagnostic.prepare_diagnostic_upload(root, 'failure')
            with self.assertRaises(FileExistsError):
                diagnostic.prepare_diagnostic_upload(root, 'failure')

    def test_oversize_original_diagnostic_is_reported_and_omitted_not_upload_authority(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); target = root / 'private/collection-failure.json'
            target.parent.mkdir(); target.write_bytes(b'bounded placeholder')
            oversized = {'bytes': 33 * diagnostic.CHUNK, 'sha256': 'a' * 64}
            with patch.object(diagnostic, 'sha_file', return_value=oversized):
                result = diagnostic.prepare_diagnostic_upload(root, 'failure')
            self.assertEqual(result['files'], [])
            self.assertEqual(len(result['omitted']), 1)
            self.assertFalse((root / 'upload/private/collection-failure.json').exists())

    @unittest.skipUnless(sys.platform == 'linux', 'Native POSIX diagnostic file identity fixture')
    def test_upload_refuses_a_symlink_or_hardlink_in_an_allowed_path(self):
        for kind in ('symlink', 'hardlink'):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary); outside = root / 'outside'; outside.write_bytes(b'public upstream bytes')
                target = root / 'private/collection-failure.json'; target.parent.mkdir()
                (os.symlink if kind == 'symlink' else os.link)(outside, target)
                with self.assertRaises(ValueError):
                    diagnostic.prepare_diagnostic_upload(root, 'failure')


if __name__=='__main__':unittest.main()

import copy
from datetime import datetime, timezone
import io
import json
import stat
import struct
import tarfile
import unittest
import warnings
import zipfile
import urllib.request

import semgrep_core_tool as tool


def elf():
    value = bytearray(120)
    value[:7] = b'\x7fELF\x02\x01\x01'
    struct.pack_into('<HH', value, 16, 2, 62)
    struct.pack_into('<Q', value, 32, 64)
    struct.pack_into('<HH', value, 54, 56, 1)
    struct.pack_into('<I', value, 64, 1)
    return bytes(value)


def identified(value):
    return {'sha256': tool.digest(value), 'bytes': len(value)}


def fixture(changed=None, extra_tar=None, zip_entries=None):
    contents = {name: b'synthetic upstream tool material\n' for name in tool.MEMBERS}
    contents['bin/semgrep-core'] = elf()
    contents['upstream/dependency-license-notices.json'] = tool.canonical({
        'format': 'gp-semgrep-core-dependency-license-ledger/v1', 'status': 'complete',
        'binarySha256': tool.digest(elf()), 'coverage': {'staticallyLinkedDependenciesReviewed': True,
            'noticesComplete': True, 'correspondingSourceComplete': True},
        'reviewReference': 'synthetic review only', 'components': [{'name': 'synthetic-only'}]})
    if changed:
        changed(contents)
    manifest = {'format': 'gp-semgrep-core-tool/v1', 'source': tool.UPSTREAM,
        'wrapperVersion': '1.181.0', 'qualification': tool.QUALIFICATION,
        'files': {name: identified(value) for name, value in contents.items()}}
    contents['tool-manifest.json'] = tool.canonical(manifest)
    tar_output = io.BytesIO()
    with tarfile.open(fileobj=tar_output, mode='w:xz', format=tarfile.USTAR_FORMAT) as archive:
        for name, value in sorted(contents.items()):
            item = tarfile.TarInfo(name)
            item.size = len(value)
            item.mode = 0o755 if name == 'bin/semgrep-core' else 0o644
            archive.addfile(item, io.BytesIO(value))
        if extra_tar:
            extra_tar(archive)
    tar_bytes = tar_output.getvalue()
    zip_output = io.BytesIO()
    with warnings.catch_warnings():
        warnings.simplefilter('ignore', UserWarning)
        with zipfile.ZipFile(zip_output, 'w') as archive:
            if zip_entries:
                zip_entries(archive, tar_bytes)
            else:
                archive.writestr(tool.ARCHIVE, tar_bytes)
    archive_bytes = zip_output.getvalue()
    pin = {'format': tool.FORMAT, 'repository': {'fullName': 'example/gp', 'id': 7},
        'run': {'id': 17, 'attempt': 1, 'headSha': 'a' * 40, 'workflowId': 23,
            'workflowPath': '.github/workflows/sast-source-build.yml'},
        'artifact': {'id': 29, 'name': 'semgrep-core-tool-17-1', **identified(archive_bytes)},
        'archive': {'name': tool.ARCHIVE, **identified(tar_bytes)},
        'manifestSha256': tool.digest(contents['tool-manifest.json']),
        'native': identified(contents['bin/semgrep-core']),
        'wrapper': {'version': '1.181.0', 'requirementsSha256': 'b' * 64},
        'toolsConfigurationSha256': 'c' * 64, 'source': tool.UPSTREAM}
    return archive_bytes, pin, contents


def metadata(pin):
    run = {'id': 17, 'run_attempt': 1, 'head_sha': 'a' * 40, 'workflow_id': 23,
        'path': '.github/workflows/sast-source-build.yml@qualification/test',
        'repository': {'full_name': 'example/gp', 'id': 7}, 'head_repository': {'id': 7},
        'status': 'completed', 'conclusion': 'success', 'event': 'push'}
    artifact = {'id': 29, 'name': 'semgrep-core-tool-17-1',
        'size_in_bytes': pin['artifact']['bytes'], 'expired': False,
        'digest': 'sha256:' + pin['artifact']['sha256'], 'expires_at': '2099-01-01T00:00:00Z',
        'workflow_run': {'id': 17, 'head_sha': 'a' * 40, 'repository_id': 7, 'head_repository_id': 7}}
    return run, artifact


class CoreToolTests(unittest.TestCase):
    def test_exact_external_and_internal_identity_chain(self):
        data, pin, contents = fixture()
        native, manifest = tool.verify_zip(data, pin)
        self.assertEqual(native, contents['bin/semgrep-core'])
        self.assertEqual(manifest['qualification'], tool.QUALIFICATION)
        tool.validate_metadata(pin, *metadata(pin))

    def test_altered_outer_bytes_rejected_even_with_valid_inner_manifest(self):
        data, pin, _ = fixture()
        with self.assertRaisesRegex(ValueError, 'Outer Actions ZIP identity'):
            tool.verify_zip(data + b'forged trailing content', pin)

    def test_matching_forged_manifest_cannot_replace_externally_pinned_native(self):
        data, pin, _ = fixture(lambda contents: contents.__setitem__('bin/semgrep-core', elf() + b'changed'))
        pin['native'] = identified(elf())
        with self.assertRaisesRegex(ValueError, 'Native core identity'):
            tool.verify_zip(data, pin)

    def test_changed_inner_archive_or_manifest_rejected(self):
        data, pin, _ = fixture()
        for field in ('archive', 'manifestSha256'):
            with self.subTest(field=field):
                changed = copy.deepcopy(pin)
                if field == 'archive':
                    changed[field]['sha256'] = 'd' * 64
                else:
                    changed[field] = 'd' * 64
                with self.assertRaises(ValueError):
                    tool.verify_zip(data, changed)

    def test_unexpected_tar_duplicate_traversal_link_special_and_mode(self):
        for kind in ('extra-secret', 'duplicate', 'traversal', 'symlink', 'hardlink', 'fifo', 'mode', 'oversize'):
            with self.subTest(kind=kind):
                def add(archive):
                    name = 'bin/semgrep-core' if kind == 'duplicate' else '../escape' if kind == 'traversal' else 'private-secret'
                    item = tarfile.TarInfo(name)
                    item.mode = 0o777 if kind == 'mode' else 0o644
                    item.size = tool.MAX_TOTAL + 1 if kind == 'oversize' else 0
                    if kind in ('symlink', 'hardlink', 'fifo'):
                        item.type = {'symlink': tarfile.SYMTYPE, 'hardlink': tarfile.LNKTYPE, 'fifo': tarfile.FIFOTYPE}[kind]
                        if kind != 'fifo':
                            item.linkname = '/private/key'
                    # Header-only oversized member is rejected before any body read.
                    if kind == 'oversize':
                        archive.fileobj.write(item.tobuf(format=tarfile.USTAR_FORMAT))
                    else:
                        archive.addfile(item, io.BytesIO(b''))
                data, pin, _ = fixture(extra_tar=add)
                with self.assertRaises((ValueError, tarfile.ReadError)):
                    tool.verify_zip(data, pin)

    def test_zip_duplicate_traversal_and_symlink_rejected(self):
        for kind in ('duplicate', 'traversal', 'symlink', 'extra'):
            with self.subTest(kind=kind):
                def entries(archive, data):
                    if kind == 'traversal':
                        archive.writestr('../' + tool.ARCHIVE, data)
                    elif kind == 'symlink':
                        item = zipfile.ZipInfo(tool.ARCHIVE)
                        item.create_system = 3
                        item.external_attr = (stat.S_IFLNK | 0o777) << 16
                        archive.writestr(item, data)
                    else:
                        archive.writestr(tool.ARCHIVE, data)
                        archive.writestr(tool.ARCHIVE if kind == 'duplicate' else 'private-evidence.gpe', data)
                data, pin, _ = fixture(zip_entries=entries)
                with self.assertRaises(ValueError):
                    tool.verify_zip(data, pin)

    def test_all_run_and_artifact_metadata_are_required(self):
        _, pin, _ = fixture()
        for target, field, value in (
            ('run', 'head_sha', 'd' * 40), ('run', 'run_attempt', 2),
            ('run', 'id', 18), ('run', 'workflow_id', 24), ('run', 'path', '.github/workflows/other.yml'),
            ('run', 'conclusion', 'failure'), ('run', 'status', 'in_progress'), ('run', 'event', 'pull_request'),
            ('run', 'head_repository', {'id': 8}), ('artifact', 'id', 30),
            ('artifact', 'expired', True), ('artifact', 'expires_at', '2000-01-01T00:00:00Z'),
            ('artifact', 'digest', 'sha256:' + 'd' * 64), ('artifact', 'workflow_run', {'id': 18})):
            with self.subTest(target=target, field=field):
                run, artifact = metadata(pin)
                (run if target == 'run' else artifact)[field] = value
                with self.assertRaises(ValueError):
                    tool.validate_metadata(pin, run, artifact)

    def test_unpinned_or_missing_configuration_fails_closed(self):
        _, pin, _ = fixture()
        for transform in (
            lambda p: p.pop('manifestSha256'),
            lambda p: p['wrapper'].__setitem__('version', 'latest'),
            lambda p: p.__setitem__('source', {**p['source'], 'sourceModified': False}),
            lambda p: p['archive'].__setitem__('name', '../arbitrary'),
            lambda p: p['repository'].__setitem__('fullName', 'example/../secret')):
            changed = copy.deepcopy(pin)
            transform(changed)
            with self.assertRaises(ValueError):
                tool.validate_pin(changed)

    def test_matching_hashes_cannot_qualify_an_incomplete_license_ledger(self):
        for field, value in (('status', 'incomplete'), ('binarySha256', 'd' * 64),
                ('coverage', {'staticallyLinkedDependenciesReviewed': True}), ('components', [])):
            with self.subTest(field=field):
                def change(contents):
                    ledger = json.loads(contents['upstream/dependency-license-notices.json'])
                    ledger[field] = value
                    contents['upstream/dependency-license-notices.json'] = tool.canonical(ledger)
                data, pin, _ = fixture(change)
                with self.assertRaisesRegex(ValueError, 'ledger is incomplete'):
                    tool.verify_zip(data, pin)

    def test_static_linux_elf_contract(self):
        for mutate in (
            lambda b: b.__setitem__(slice(0, 4), b'fake'),
            lambda b: struct.pack_into('<H', b, 18, 183),
            lambda b: struct.pack_into('<I', b, 64, 3),
            lambda b: struct.pack_into('<H', b, 56, 300)):
            value = bytearray(elf())
            mutate(value)
            with self.assertRaises(ValueError):
                tool.check_elf(bytes(value))

    def test_duplicate_json_keys_are_rejected(self):
        with self.assertRaisesRegex(ValueError, 'Duplicate JSON'):
            tool.unique_json(b'{"sha256":"first","sha256":"second"}')

    def test_every_token_free_storage_redirect_must_remain_https_without_userinfo(self):
        request = urllib.request.Request('https://storage.example/core?signature=synthetic')
        redirect = tool.HttpsStorageRedirect()
        for value in ('http://storage.example/core', 'file:///private/key',
                'https://user:password@storage.example/core', 'https://storage.example/core#fragment'):
            with self.subTest(value=value), self.assertRaises(ValueError):
                redirect.redirect_request(request, None, 302, 'Found', {}, value)
        following = redirect.redirect_request(request, None, 302, 'Found', {}, 'https://other-storage.example/core?signature=synthetic')
        self.assertFalse(any(key.lower() == 'authorization' for key in following.headers))


if __name__ == '__main__':
    unittest.main()

"""Filesystem-shape contracts only; no privileged writes or sandbox execution."""
import importlib.util
from pathlib import Path
import stat
import sys
from types import SimpleNamespace
import unittest

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('gp_ci_sandbox_installer', Path(__file__).with_name('install-sandbox.py'))
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class Directory:
    def __init__(self, name='/var/lib', uid=0, mode=stat.S_IFDIR | 0o755, canonical=True, exists=True):
        self.name, self.uid, self.mode = name, uid, mode
        self.canonical, self.present, self.created = canonical, exists, []

    def __str__(self):
        return self.name

    def exists(self):
        return self.present

    def mkdir(self, mode):
        self.created.append(mode)
        self.present = True

    def lstat(self):
        if not self.present:
            raise FileNotFoundError(self.name)
        return SimpleNamespace(st_uid=self.uid, st_gid=0, st_mode=self.mode)

    def resolve(self):
        return self if self.canonical else Directory('/untrusted/alias')


class SandboxDirectoryContract(unittest.TestCase):
    def test_exact_destination_excludes_runner_toolcache(self):
        self.assertEqual(installer.DESTINATION, '/var/lib/gp-passkeys-ci-sandbox')

    def test_protected_root_directory_records_actual_identity(self):
        directory = Directory()
        self.assertEqual(installer.protected_directory(directory), {
            'path': '/var/lib', 'uid': 0, 'gid': 0, 'mode': 0o755,
            'isDirectory': True, 'canonical': '/var/lib',
        })
        self.assertEqual(directory.created, [])

    def test_new_owned_destination_is_created_without_changing_existing_ancestors(self):
        directory = Directory('/var/lib/gp-passkeys-ci-sandbox', exists=False)
        installer.protected_directory(directory, create=True)
        self.assertEqual(directory.created, [0o755])

    def test_missing_baseline_ancestor_is_not_created(self):
        directory = Directory('/var/lib', exists=False)
        with self.assertRaises(FileNotFoundError):
            installer.protected_directory(directory)
        self.assertEqual(directory.created, [])

    def test_foreign_owner_is_rejected_with_exact_path_uid_and_mode(self):
        directory = Directory('/opt', uid=1001)
        with self.assertRaisesRegex(ValueError, r'"path": "/opt".*"uid": 1001'):
            installer.protected_directory(directory)
        self.assertEqual(directory.created, [])

    def test_group_writable_directory_is_rejected(self):
        with self.assertRaises(ValueError):
            installer.protected_directory(Directory(mode=stat.S_IFDIR | 0o775))

    def test_world_writable_directory_is_rejected(self):
        with self.assertRaises(ValueError):
            installer.protected_directory(Directory(mode=stat.S_IFDIR | 0o777))

    def test_symbolic_directory_shape_is_rejected(self):
        with self.assertRaises(ValueError):
            installer.protected_directory(Directory(mode=stat.S_IFLNK | 0o755))

    def test_indirect_ancestor_is_rejected_without_rewriting_it(self):
        directory = Directory(canonical=False)
        with self.assertRaises(ValueError):
            installer.protected_directory(directory, create=True)
        self.assertEqual(directory.created, [])


if __name__ == '__main__':
    unittest.main()

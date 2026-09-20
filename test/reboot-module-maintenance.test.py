import importlib.util
import os
from pathlib import Path
import tempfile
import unittest

source = Path(__file__).resolve().parents[1]/'server-tools/linux/postgresql/maintain-reboot-control.py'
spec = importlib.util.spec_from_file_location('maintenance', source)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class TransitionTest(unittest.TestCase):
    def test_failed_validation_restores_every_original_and_mode(self):
        with tempfile.TemporaryDirectory() as tmp:
            a, b = Path(tmp)/'a', Path(tmp)/'b'
            a.write_bytes(b'original-a'); b.write_bytes(b'original-b')
            a.chmod(0o600); b.chmod(0o640)
            def reject():
                self.assertEqual(a.read_bytes(), b'new-a')
                raise RuntimeError('test validation failure')
            with self.assertRaisesRegex(RuntimeError, 'test validation'):
                module.transaction([(a,b'new-a'),(b,b'new-b')], reject)
            self.assertEqual(a.read_bytes(), b'original-a')
            self.assertEqual(b.read_bytes(), b'original-b')
            self.assertEqual(a.stat().st_mode & 0o777, 0o600)
            self.assertEqual(b.stat().st_mode & 0o777, 0o640)
            self.assertEqual(len(list(Path(tmp).iterdir())), 2)

    def test_success_is_verified_before_return(self):
        with tempfile.TemporaryDirectory() as tmp:
            a = Path(tmp)/'a'; a.write_bytes(b'old'); a.chmod(0o600)
            module.transaction([(a,b'new')], lambda: self.assertEqual(a.read_bytes(),b'new'))
            self.assertEqual(a.read_bytes(),b'new')

    def test_symlinks_and_writable_files_are_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            a = Path(tmp)/'a'; a.write_bytes(b'old'); a.chmod(0o666)
            with self.assertRaises(RuntimeError): module.safe_file(a)
            a.chmod(0o600)
            b = Path(tmp)/'b'; b.symlink_to(a)
            with self.assertRaises(RuntimeError): module.safe_file(b)

if __name__ == '__main__':
    if os.geteuid() != 0: raise RuntimeError('Run this isolated filesystem test as root on Ubuntu')
    unittest.main()

"""Isolated lifecycle checks: never start against the real catalog."""
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import unittest
import dev


class PreviewLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            self.port = sock.getsockname()[1]
        self.base = [sys.executable, str(dev.ROOT / 'dev.py')]
        self.options = ['--port', str(self.port), '--db', str(self.root / 'catalog.sqlite3'),
                        '--runtime-dir', str(self.root / 'run'), '--token-file', str(self.root / 'token')]

    def run_action(self, action, *extra):
        return subprocess.run(self.base + [action] + self.options + list(extra), capture_output=True, text=True, timeout=20)

    def tearDown(self):
        self.run_action('stop')
        self.tmp.cleanup()

    def test_detached_idempotent_restart_and_private_token(self):
        first = self.run_action('start')
        self.assertEqual(first.returncode, 0, first.stderr)
        health = dev.health(self.port)
        self.assertIsNotNone(health)
        again = self.run_action('start')
        self.assertEqual(again.returncode, 0, again.stderr)
        self.assertEqual(dev.health(self.port)['pid'], health['pid'])
        token = (self.root / 'token').read_text().strip()
        self.assertNotIn(token, first.stdout + first.stderr)
        log = self.root / 'run' / f'{self.port}.log'
        self.assertNotIn(token, log.read_text())
        self.assertEqual((self.root / 'token').stat().st_mode & 0o777, 0o600)
        self.assertEqual(log.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.run_action('status').returncode, 0)
        self.assertEqual(self.run_action('restart').returncode, 0)
        self.assertNotEqual(dev.health(self.port)['instance'], health['instance'])
        self.assertEqual((self.root / 'token').read_text().strip(), token)
        self.assertEqual(self.run_action('stop').returncode, 0)
        self.assertFalse(dev.occupied(self.port))
        self.assertEqual(self.run_action('status').returncode, 1)

    def test_other_listener_not_replaced_or_stopped(self):
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', self.port))
            sock.listen(10)
            self.assertEqual(self.run_action('start').returncode, 1)
            self.assertEqual(self.run_action('stop').returncode, 1)
            self.assertTrue(dev.occupied(self.port))

    def test_database_mismatch_rejected(self):
        self.assertEqual(self.run_action('start').returncode, 0)
        other = self.run_action('start', '--db', str(self.root / 'other.sqlite3'))
        self.assertEqual(other.returncode, 1)
        self.assertFalse((self.root / 'other.sqlite3').exists())

    def test_clear_startup_failure(self):
        result = self.run_action('start', '--db', str(self.root / 'missing' / 'db.sqlite3'))
        self.assertEqual(result.returncode, 1)
        self.assertIn('启动失败', result.stderr)
        self.assertIn('日志', result.stderr)
        self.assertFalse(dev.occupied(self.port))

    def test_token_symlink_rejected(self):
        target = self.root / 'elsewhere'
        target.write_text('keep')
        (self.root / 'token').symlink_to(target)
        self.assertEqual(self.run_action('start').returncode, 1)
        self.assertEqual(target.read_text(), 'keep')
        self.assertFalse(dev.occupied(self.port))


if __name__ == '__main__':
    unittest.main()

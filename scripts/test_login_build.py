from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

BUILD = Path(__file__).with_name('build-site.py').resolve()
GATE = "  function mountTurnstile() { window.turnstile.render('#turnstile', {callback: verifyOnServer}); }\n  function termsOk() { return false; }\n"

class LoginBuildTests(unittest.TestCase):
    def fixture(self):
        holder = tempfile.TemporaryDirectory()
        self.addCleanup(holder.cleanup)
        root = Path(holder.name)
        for directory in ['app', 'assets', 'scripts']:
            (root / directory).mkdir()
        (root / 'app/gate.js').write_text(GATE)
        (root / 'app/index.html').write_text('<main>Sign in</main>')
        (root / 'assets/mark.svg').write_text('<svg/>')
        (root / 'assets/mech.jpg').write_bytes(b'fixture')
        (root / 'errors.js').write_text('root.ValhallaErrors = {};')
        return root

    def run_build(self, root):
        subprocess.run([sys.executable, str(BUILD)], cwd=root, check=True, capture_output=True)

    def test_authentication_is_not_rewritten(self):
        root = self.fixture()
        self.run_build(root)
        self.assertEqual((root / 'site-build/app/gate.js').read_bytes(), (root / 'app/gate.js').read_bytes())
        self.assertNotIn('mountTurnstile() { markHuman(); }', (root / 'site-build/app/gate.js').read_text())

    def test_existing_challenge_and_server_callback_are_preserved(self):
        root = self.fixture()
        self.run_build(root)
        self.assertIn('window.turnstile.render', (root / 'site-build/app/gate.js').read_text())
        self.assertIn('callback: verifyOnServer', (root / 'site-build/app/gate.js').read_text())

    def test_secret_files_and_build_scripts_are_not_published(self):
        root = self.fixture()
        (root / '.env').write_text('SECRET=fixture')
        (root / '.env.production').write_text('SECRET=fixture')
        (root / 'scripts/private.py').write_text('fixture')
        self.run_build(root)
        for name in ['.env', '.env.production', 'scripts']:
            self.assertFalse((root / 'site-build' / name).exists())

    def test_rebuild_is_repeatable_and_preserves_login_html(self):
        root = self.fixture()
        self.run_build(root)
        self.run_build(root)
        self.assertEqual((root / 'site-build/app/index.html').read_bytes(), (root / 'app/index.html').read_bytes())
        self.assertEqual((root / 'site-build/app/gate.js').read_text(), GATE)

if __name__ == '__main__':
    unittest.main()

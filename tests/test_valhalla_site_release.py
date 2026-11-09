import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.write_valhalla_release import site_digest, write_release


class SiteReleaseTests(unittest.TestCase):
    def test_marker_correlates_build_with_sha_request_and_content_digest(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "index.html").write_text("<h1>Valhalla</h1>", encoding="utf-8")
            assets = root / "assets"
            assets.mkdir()
            (assets / "app.js").write_text("window.ready = true;", encoding="utf-8")
            expected_digest = site_digest(root)

            marker = write_release(root, "a" * 40, "build-123_abc")

            self.assertEqual(marker, {
                "sha": "a" * 40,
                "request_id": "build-123_abc",
                "package_sha256": expected_digest,
            })
            self.assertEqual(json.loads((root / "release.json").read_text()), marker)
            self.assertLess((root / "release.json").stat().st_size, 65536)

    def test_digest_is_stable_and_changes_with_file_names_or_contents(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            first = root / "first"
            first.mkdir()
            (first / "a.txt").write_text("same", encoding="utf-8")
            first_digest = site_digest(first)
            self.assertEqual(site_digest(first), first_digest)
            (first / "a.txt").rename(first / "b.txt")
            self.assertNotEqual(site_digest(first), first_digest)

    def test_invalid_inputs_existing_marker_and_symlink_fail_closed(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "index.html").write_text("fixture", encoding="utf-8")
            for sha, request_id in (("A" * 40, "ok"), ("a" * 40, "quote\""),
                                    ("short", "ok"), ("a" * 40, "../bad")):
                with self.subTest(sha=sha, request_id=request_id):
                    with self.assertRaises(ValueError):
                        write_release(root, sha, request_id)
            marker = root / "release.json"
            marker.write_text("existing", encoding="utf-8")
            with self.assertRaises(ValueError):
                write_release(root, "a" * 40, "ok")
            self.assertEqual(marker.read_text(), "existing")
            marker.unlink()
            link = root / "linked.js"
            link.symlink_to(root / "index.html")
            with self.assertRaises(ValueError):
                site_digest(root)


if __name__ == "__main__":
    unittest.main()

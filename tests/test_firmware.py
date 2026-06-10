"""Tests for the OTA firmware-release logic: version comparison, release
selection, sha256, and path-traversal safety."""
import os
import sys
import hashlib
import tempfile
import unittest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO_ROOT)

_TMP_DB = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_TMP_DB.close()
os.environ["DB_PATH"] = _TMP_DB.name

from server import app as app_module  # noqa: E402


class VersionParse(unittest.TestCase):
    def test_parse_basic(self):
        self.assertEqual(app_module._parse_version("1.2.3"), (1, 2, 3))
        self.assertEqual(app_module._parse_version("1.0.0"), (1, 0, 0))
        self.assertEqual(app_module._parse_version("2"), (2,))

    def test_parse_garbage_is_none(self):
        self.assertIsNone(app_module._parse_version(""))
        self.assertIsNone(app_module._parse_version(None))
        self.assertIsNone(app_module._parse_version("abc"))
        self.assertIsNone(app_module._parse_version("1.x.0"))  # 'x' component → None

    def test_parse_prerelease_truncates_to_numeric(self):
        # '0-rc1' has leading digit '0' then stops → (1,0,0)
        self.assertEqual(app_module._parse_version("1.0.0-rc1"), (1, 0, 0))


class VersionNewer(unittest.TestCase):
    def test_basic_ordering(self):
        self.assertTrue(app_module._version_newer("1.1.0", "1.0.0"))
        self.assertFalse(app_module._version_newer("1.0.0", "1.0.0"))
        self.assertFalse(app_module._version_newer("1.0.0", "1.1.0"))

    def test_padding(self):
        self.assertTrue(app_module._version_newer("1.1", "1.0.9"))
        self.assertFalse(app_module._version_newer("1.0", "1.0.0"))  # equal after pad

    def test_unknown_current_means_any_is_newer(self):
        self.assertTrue(app_module._version_newer("1.0.0", None))
        self.assertTrue(app_module._version_newer("1.0.0", "garbage"))

    def test_garbage_candidate_never_newer(self):
        self.assertFalse(app_module._version_newer(None, "1.0.0"))
        self.assertFalse(app_module._version_newer("abc", "1.0.0"))


class SelectLatestRelease(unittest.TestCase):
    def _rows(self, *specs):
        # specs: (version, min_version)
        return [
            {
                "version": v,
                "min_version": m,
                "sha256": "x",
                "size_bytes": 1,
                "filename": f"{v}/app_update.bin",
                "notes": None,
            }
            for (v, m) in specs
        ]

    def test_picks_highest_newer(self):
        rows = self._rows(("1.0.0", None), ("1.2.0", None), ("1.1.0", None))
        best = app_module._select_latest_release(rows, "1.0.0")
        self.assertEqual(best["version"], "1.2.0")

    def test_none_when_current_is_highest(self):
        rows = self._rows(("1.0.0", None), ("1.1.0", None))
        self.assertIsNone(app_module._select_latest_release(rows, "1.1.0"))

    def test_current_unknown_offers_highest(self):
        rows = self._rows(("1.0.0", None), ("1.1.0", None))
        best = app_module._select_latest_release(rows, None)
        self.assertEqual(best["version"], "1.1.0")

    def test_min_version_gate_blocks_old_device(self):
        # 2.0.0 requires the device be at least 1.5.0; device on 1.0.0 → not offered
        rows = self._rows(("2.0.0", "1.5.0"))
        self.assertIsNone(app_module._select_latest_release(rows, "1.0.0"))

    def test_min_version_gate_allows_eligible_device(self):
        rows = self._rows(("2.0.0", "1.5.0"))
        best = app_module._select_latest_release(rows, "1.6.0")
        self.assertEqual(best["version"], "2.0.0")

    def test_empty_release_list(self):
        self.assertIsNone(app_module._select_latest_release([], "1.0.0"))


class Sha256File(unittest.TestCase):
    def test_matches_hashlib(self):
        payload = b"hello firmware" * 1000
        with tempfile.NamedTemporaryFile(delete=False) as f:
            f.write(payload)
            name = f.name
        try:
            digest, size = app_module._sha256_file(name)
            self.assertEqual(digest, hashlib.sha256(payload).hexdigest())
            self.assertEqual(size, len(payload))
        finally:
            os.unlink(name)


class FirmwarePathSafety(unittest.TestCase):
    def test_rejects_traversal(self):
        self.assertIsNone(app_module._firmware_path("../../etc/passwd"))
        self.assertIsNone(app_module._firmware_path("../outside.bin"))

    def test_allows_normal_path(self):
        # File need not exist; _firmware_path only checks containment.
        p = app_module._firmware_path("1.0.0/app_update.bin")
        self.assertIsNotNone(p)


if __name__ == "__main__":
    unittest.main()

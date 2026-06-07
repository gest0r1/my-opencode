"""Tests for reboot.read_marker().

read_marker() reads MARKER_PATH and returns:
  - None if the file is absent
  - None if the file contains garbage (not parseable JSON)
  - None if the file contains valid JSON that isn't an object (e.g. array)
  - The parsed dict if it's a JSON object (including the empty dict {})

The "empty object" case is subtle: {} is a valid dict, so read_marker returns
{} (truthy check on length, not on content).
"""

import pytest

# Sentinel for parametrize: "do not write a marker file at all"
_NO_FILE = object()


@pytest.mark.parametrize(
    "setup, expected",
    [
        pytest.param(_NO_FILE, None, id="file_absent"),
        pytest.param(
            '{"request_id": "x", "session_id": "y", "requested_at": "z"}',
            {"request_id": "x", "session_id": "y", "requested_at": "z"},
            id="valid_dict",
        ),
        pytest.param("not json", None, id="garbage_text"),
        pytest.param("[1, 2, 3]", None, id="json_array"),
        pytest.param("{}", {}, id="empty_object"),
    ],
)
def test_read_marker(reboot_module, tmp_paths, setup, expected):
    """read_marker returns the parsed dict, None for absent/invalid, or {} for empty object."""
    if setup is not _NO_FILE:
        (tmp_paths / "reboot-marker.json").write_text(setup, encoding="utf-8")

    assert reboot_module.read_marker() == expected

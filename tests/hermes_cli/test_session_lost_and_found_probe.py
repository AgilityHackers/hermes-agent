"""Isolation regressions for the sqlite3 .recover capability probe."""

from __future__ import annotations

from pathlib import Path

from hermes_cli.session_lost_and_found import _cli_supports_recover


def test_incompatible_sqlite_shim_cannot_pollute_caller_cwd(
    tmp_path: Path,
    monkeypatch,
) -> None:
    """A shim that treats ``-readonly`` as a DB path stays in scratch cwd."""
    shim = tmp_path / "sqlite3-shim"
    shim.write_text(
        "#!/usr/bin/python3\n"
        "import sqlite3, sys\n"
        "sqlite3.connect(sys.argv[1]).close()\n"
        "raise SystemExit(1)\n",
        encoding="utf-8",
    )
    shim.chmod(0o755)
    caller_cwd = tmp_path / "checkout"
    caller_cwd.mkdir()
    monkeypatch.chdir(caller_cwd)

    assert _cli_supports_recover(str(shim)) is False
    assert not (caller_cwd / "-readonly").exists()
    assert list(caller_cwd.iterdir()) == []

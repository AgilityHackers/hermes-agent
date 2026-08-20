"""Behavioral tests for scripts/run_tests.sh interpreter admission."""

from __future__ import annotations

import os
import shutil
from pathlib import Path
import subprocess
import sys


def _sandbox_runner(tmp_path: Path) -> tuple[Path, Path]:
    """Copy the shell runner away from any real checkout-local virtualenv."""
    source_root = Path(__file__).resolve().parent.parent
    repo_root = tmp_path / "repo"
    scripts = repo_root / "scripts"
    scripts.mkdir(parents=True)
    runner = scripts / "run_tests.sh"
    shutil.copy2(source_root / "scripts" / "run_tests.sh", runner)
    (scripts / "run_tests_parallel.py").write_text("# selected by fixture shim\n")
    return repo_root, runner


def test_release_venv_without_async_plugin_fails_closed(tmp_path: Path) -> None:
    """An incidental pytest install must not admit a release-only venv."""
    repo_root, runner = _sandbox_runner(tmp_path)

    fake_home = tmp_path / "home"
    fake_bin = fake_home / ".hermes" / "hermes-agent" / "venv" / "bin"
    fake_bin.mkdir(parents=True)
    (fake_bin / "activate").write_text("# test fixture\n", encoding="utf-8")

    fake_python = fake_bin / "python"
    fake_python.write_text(
        "#!/bin/sh\n"
        "case \"${2-}\" in\n"
        "  *pytest_asyncio*) exit 1 ;;\n"
        "esac\n"
        f"exec {sys.executable!r} \"$@\"\n",
        encoding="utf-8",
    )
    fake_python.chmod(0o755)

    fake_tools = tmp_path / "tools"
    fake_tools.mkdir()
    (fake_tools / "dirname").symlink_to("/usr/bin/dirname")

    env = os.environ.copy()
    env["HOME"] = str(fake_home)
    env["HERMES_PYTHON"] = str(fake_python)
    env["PATH"] = str(fake_tools)
    proc = subprocess.run(
        ["/bin/bash", str(runner), "--help"],
        cwd=repo_root,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        timeout=30,
    )

    assert proc.returncode == 1, proc.stdout
    assert "skipping venv without Hermes dev test runtime" in proc.stdout
    assert "neither HERMES_PYTHON nor PATH python has pytest + pytest-asyncio + prompt-toolkit" in proc.stdout
    assert "launching test runner" not in proc.stdout


def test_usable_path_python_is_selected_without_dev_venv(tmp_path: Path) -> None:
    """A validated system interpreter is a legitimate final fallback."""
    repo_root, runner = _sandbox_runner(tmp_path)
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    selected = tmp_path / "selected"

    fake_python = fake_bin / "python3"
    fake_python.write_text(
        "#!/bin/sh\n"
        f"touch {str(selected)!r}\n"
        "case \"${1-}\" in\n"
        "  -c) exit 0 ;;\n"
        "  -m) exit 0 ;;\n"
        "  */run_tests_parallel.py) exit 0 ;;\n"
        "esac\n"
        "exit 1\n",
        encoding="utf-8",
    )
    fake_python.chmod(0o755)

    env = os.environ.copy()
    env["HOME"] = os.environ["HOME"]
    env["HERMES_PYTHON"] = str(tmp_path / "missing-python")
    env["PATH"] = f"{fake_bin}:/usr/bin:/bin"
    proc = subprocess.run(
        [
            "/bin/bash",
            str(runner),
            "tests/test_run_tests_parallel_stdio.py",
            "-q",
        ],
        cwd=repo_root,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        timeout=30,
    )

    assert proc.returncode == 0, proc.stdout
    assert selected.exists()
    assert "using PATH interpreter with Hermes test runtime" in proc.stdout
    assert "launching test runner" in proc.stdout

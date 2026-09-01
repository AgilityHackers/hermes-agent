"""Owned lifecycle and inode admission for local shell snapshots.

Snapshot files may contain environment-carried secrets.  Cleanup therefore uses
an exact per-session owner marker and never deletes arbitrary name matches.
"""

from __future__ import annotations

from dataclasses import dataclass
import json
import math
import os
from pathlib import Path
import re
import socket
import stat
import time
import uuid
from typing import Callable

RUN = "RUN"
DEFER = "DEFER_NEW_SNAPSHOT"
FAIL_CLOSED = "FAIL_CLOSED"

_SESSION_RE = re.compile(r"^[0-9a-f]{12}$")
_MARKER_RE = re.compile(r"^hermes-session-([0-9a-f]{12})\.owner\.json$")


@dataclass(frozen=True)
class SnapshotLifecycleSettings:
    ttl_seconds: float = 86_400.0
    min_free_inode_ratio: float = 0.15
    critical_free_inode_ratio: float = 0.10


@dataclass(frozen=True)
class InodeAdmission:
    outcome: str
    reason: str
    free_inode_ratio: float | None


@dataclass(frozen=True)
class OwnedArtifacts:
    session_id: str
    snapshot_path: str
    cwd_path: str
    marker_path: str
    pid: int
    uid: int | None
    hostname: str
    created_at: float


def settings_from_environment() -> SnapshotLifecycleSettings:
    """Load internal values bridged from ``terminal:`` config settings."""
    def _float(name: str, default: float) -> float:
        raw = os.environ.get(name)
        if raw is None or not raw.strip():
            return default
        try:
            return float(raw)
        except ValueError:
            return float("nan")

    return SnapshotLifecycleSettings(
        ttl_seconds=_float("TERMINAL_SNAPSHOT_TTL_SECONDS", 86_400.0),
        min_free_inode_ratio=_float("TERMINAL_SNAPSHOT_MIN_FREE_INODE_RATIO", 0.15),
        critical_free_inode_ratio=_float(
            "TERMINAL_SNAPSHOT_CRITICAL_FREE_INODE_RATIO", 0.10
        ),
    )


def decide_inode_admission(
    free_inode_ratio: float | None,
    settings: SnapshotLifecycleSettings,
) -> InodeAdmission:
    """Pure decision core for snapshot creation."""
    critical = settings.critical_free_inode_ratio
    minimum = settings.min_free_inode_ratio
    if (
        not all(math.isfinite(value) for value in (critical, minimum, settings.ttl_seconds))
        or not (0 <= critical < minimum <= 1)
        or settings.ttl_seconds < 0
    ):
        return InodeAdmission(FAIL_CLOSED, "INVALID_THRESHOLDS", free_inode_ratio)
    if (
        free_inode_ratio is None
        or not math.isfinite(free_inode_ratio)
        or not (0 <= free_inode_ratio <= 1)
    ):
        return InodeAdmission(FAIL_CLOSED, "INODE_MEASUREMENT_UNAVAILABLE", free_inode_ratio)
    if free_inode_ratio < critical:
        return InodeAdmission(FAIL_CLOSED, "INODES_CRITICAL", free_inode_ratio)
    if free_inode_ratio <= minimum:
        return InodeAdmission(DEFER, "INODE_PRESSURE", free_inode_ratio)
    return InodeAdmission(RUN, "INODES_AVAILABLE", free_inode_ratio)


def measure_free_inode_ratio(path: str | Path) -> float | None:
    """Measure POSIX inode headroom; inode admission is not applicable on Windows."""
    if os.name == "nt":
        return 1.0
    try:
        values = os.statvfs(os.fspath(path))
    except (AttributeError, OSError):
        return None
    if values.f_files <= 0:
        return None
    return values.f_favail / values.f_files


def _paths(root: Path, session_id: str) -> tuple[Path, Path, Path]:
    if not _SESSION_RE.fullmatch(session_id):
        raise ValueError("snapshot session id must be exactly 12 lowercase hex characters")
    return (
        root / f"hermes-snap-{session_id}.sh",
        root / f"hermes-cwd-{session_id}.txt",
        root / f"hermes-session-{session_id}.owner.json",
    )


def _write_private_json(path: Path, payload: dict) -> None:
    temporary = path.with_name(f".{path.name}.tmp.{uuid.uuid4().hex}")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, sort_keys=True, separators=(",", ":"))
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        try:
            os.chmod(path, 0o600)
        except (OSError, NotImplementedError):
            pass
    finally:
        try:
            temporary.unlink()
        except OSError:
            pass


def prepare_owned_artifacts(
    temp_root: str | Path,
    session_id: str,
    *,
    now: float | None = None,
    pid: int | None = None,
    uid: int | None = None,
    hostname: str | None = None,
) -> OwnedArtifacts:
    root = Path(temp_root)
    if root.is_symlink() or not root.is_dir():
        raise RuntimeError(f"snapshot temp root is not a real directory: {root}")
    root = root.resolve()
    snapshot, cwd, marker = _paths(root, session_id)
    created_at = time.time() if now is None else float(now)
    process_id = os.getpid() if pid is None else int(pid)
    if uid is None and hasattr(os, "getuid"):
        uid = os.getuid()
    host = socket.gethostname() if hostname is None else str(hostname)
    payload = {
        "schema_version": 1,
        "session_id": session_id,
        "pid": process_id,
        "uid": uid,
        "hostname": host,
        "created_at": created_at,
    }
    _write_private_json(marker, payload)
    return OwnedArtifacts(
        session_id=session_id,
        snapshot_path=str(snapshot),
        cwd_path=str(cwd),
        marker_path=str(marker),
        pid=process_id,
        uid=uid,
        hostname=host,
        created_at=created_at,
    )


def _load_valid_marker(
    marker: Path,
    *,
    expected_session_id: str,
    uid: int | None,
    hostname: str,
) -> dict | None:
    try:
        info = marker.lstat()
        if not stat.S_ISREG(info.st_mode) or marker.is_symlink():
            return None
        payload = json.loads(marker.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return None
    if payload.get("schema_version") != 1:
        return None
    if payload.get("session_id") != expected_session_id:
        return None
    if payload.get("hostname") != hostname:
        return None
    if payload.get("uid") != uid:
        return None
    if not isinstance(payload.get("pid"), int):
        return None
    if not isinstance(payload.get("created_at"), (int, float)):
        return None
    return payload


def _unlink_regular(path: Path, removed: list[str]) -> None:
    try:
        info = path.lstat()
        if stat.S_ISREG(info.st_mode) and not path.is_symlink():
            path.unlink()
            removed.append(str(path))
    except OSError:
        pass


def cleanup_owned_artifacts(owned: OwnedArtifacts) -> list[str]:
    """Delete only artifacts authenticated by the exact session owner marker."""
    marker = Path(owned.marker_path)
    payload = _load_valid_marker(
        marker,
        expected_session_id=owned.session_id,
        uid=owned.uid,
        hostname=owned.hostname,
    )
    if payload is None:
        return []

    removed: list[str] = []
    snapshot = Path(owned.snapshot_path)
    cwd = Path(owned.cwd_path)
    _unlink_regular(snapshot, removed)
    _unlink_regular(cwd, removed)
    for temporary in snapshot.parent.glob(f"{snapshot.name}.tmp.*"):
        _unlink_regular(temporary, removed)
    _unlink_regular(marker, removed)
    return removed


def _pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def reap_stale_owned_artifacts(
    temp_root: str | Path,
    settings: SnapshotLifecycleSettings,
    *,
    now: float | None = None,
    uid: int | None = None,
    hostname: str | None = None,
    pid_alive: Callable[[int], bool] = _pid_alive,
) -> list[str]:
    """Reap TTL-expired, dead, self-owned sessions; refuse every ambiguous entry."""
    root = Path(temp_root)
    if root.is_symlink() or not root.is_dir() or settings.ttl_seconds < 0:
        return []
    root = root.resolve()
    current = time.time() if now is None else float(now)
    if uid is None and hasattr(os, "getuid"):
        uid = os.getuid()
    host = socket.gethostname() if hostname is None else str(hostname)
    reaped: list[str] = []

    for marker in root.glob("hermes-session-*.owner.json"):
        match = _MARKER_RE.fullmatch(marker.name)
        if not match:
            continue
        session_id = match.group(1)
        payload = _load_valid_marker(
            marker,
            expected_session_id=session_id,
            uid=uid,
            hostname=host,
        )
        if payload is None:
            continue
        if current - float(payload["created_at"]) < settings.ttl_seconds:
            continue
        if pid_alive(int(payload["pid"])):
            continue
        snapshot, cwd, _ = _paths(root, session_id)
        owned = OwnedArtifacts(
            session_id=session_id,
            snapshot_path=str(snapshot),
            cwd_path=str(cwd),
            marker_path=str(marker),
            pid=int(payload["pid"]),
            uid=uid,
            hostname=host,
            created_at=float(payload["created_at"]),
        )
        cleanup_owned_artifacts(owned)
        if not marker.exists():
            reaped.append(session_id)
    return reaped

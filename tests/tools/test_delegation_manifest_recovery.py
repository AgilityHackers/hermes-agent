"""Durable ledger, not a forgotten live transcript, owns delegation status."""
import json
import time

from tools import async_delegation as ad
from tools.delegation_live_log import create_live_transcripts, live_transcript_root


def _dispatch(delegation_id, goals):
    tasks = [{"goal": goal} for goal in goals]
    live_id, writers, paths = create_live_transcripts(tasks, delegation_id=delegation_id)
    assert live_id == delegation_id and len(writers) == len(goals)
    record = {
        "delegation_id": delegation_id,
        "session_key": "session-owner", "parent_session_id": "session-owner",
        "goal": goals[0], "goals": goals, "is_batch": len(goals) > 1,
        "task_indexes": list(range(len(goals))),
        "task_transcripts": {str(i): path for i, path in enumerate(paths)},
        "status": "running", "dispatched_at": time.time() - 100,
    }
    ad._persist_dispatch(record)
    return live_transcript_root() / delegation_id / "manifest.json"


def _manifest(path):
    return json.loads(path.read_text(encoding="utf-8"))


def test_dead_owner_recovery_retires_only_its_running_manifest(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    path = _dispatch("deleg_aabbcc01", ["review only"])
    log = path.parent / "task-0.log"
    before = log.read_bytes()
    monkeypatch.setattr(ad, "_owner_liveness", lambda: lambda *_: False)

    assert ad.recover_abandoned_delegations() == 1
    assert _manifest(path)["tasks"][0]["status"] == "unknown"
    assert log.read_bytes() == before
    assert ad.recover_abandoned_delegations() == 0
    once = path.read_bytes()
    assert ad.recover_abandoned_delegations() == 0
    assert path.read_bytes() == once  # duplicate sweep cannot repeat an effect
    with ad._connect() as conn:
        assert conn.execute("select state,delivery_state from async_delegations where delegation_id=?",
                            ("deleg_aabbcc01",)).fetchone() == ("unknown", "pending")


def test_dead_batch_owner_preserves_finished_child_and_marks_only_unfinished_unknown(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    path = _dispatch("deleg_aabbcc02", ["done", "unfinished"])
    ad.record_unit_child("deleg_aabbcc02", {"task_index": 0, "status": "completed", "summary": "verified"})
    monkeypatch.setattr(ad, "_owner_liveness", lambda: lambda *_: False)

    assert ad.recover_abandoned_delegations() == 1
    assert [task["status"] for task in _manifest(path)["tasks"]] == ["completed", "unknown"]
    with ad._connect() as conn:
        payload = json.loads(conn.execute("select result_json from async_delegations where delegation_id=?",
                                          ("deleg_aabbcc02",)).fetchone()[0])
    assert [r["status"] for r in payload["results"]] == ["completed", "unknown"]


def test_restart_reconciles_old_terminal_row_without_replaying_work(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    path = _dispatch("deleg_aabbcc03", ["read-only old review"])
    ad._persist_completion({"delegation_id": "deleg_aabbcc03", "status": "unknown"},
                           {"status": "unknown", "error": "owner died"})
    assert _manifest(path)["tasks"][0]["status"] == "running"

    from queue import Queue
    queue = Queue()
    assert ad.restore_undelivered_completions(queue) == 1
    assert _manifest(path)["tasks"][0]["status"] == "unknown"
    with ad._connect() as conn:
        assert conn.execute("select state from async_delegations where delegation_id=?",
                            ("deleg_aabbcc03",)).fetchone()[0] == "unknown"


def test_live_owner_is_never_reclassified_by_reconciler(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    path = _dispatch("deleg_aabbcc04", ["long-running useful work"])
    monkeypatch.setattr(ad, "_owner_liveness", lambda: lambda *_: True)

    assert ad.recover_abandoned_delegations() == 0
    assert _manifest(path)["tasks"][0]["status"] == "running"
    with ad._connect() as conn:
        assert conn.execute("select state from async_delegations where delegation_id=?",
                            ("deleg_aabbcc04",)).fetchone()[0] == "running"

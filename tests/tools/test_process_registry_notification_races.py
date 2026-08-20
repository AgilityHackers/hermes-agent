"""Regression tests for completion-notification ordering and canonical identity."""

import sys
import time

from tools.process_registry import ProcessRegistry, ProcessSession


def test_prefix_poll_deduplicates_canonical_completion_event():
    registry = ProcessRegistry()
    session = ProcessSession(
        id="proc_abcdef123456",
        command="true",
        started_at=time.time(),
        notify_on_complete=True,
    )
    registry._running[session.id] = session
    registry._record_terminal_observation(session, 0)
    registry._move_to_finished(session)

    result = registry.poll("abcdef")

    assert result["session_id"] == session.id
    assert registry.drain_notifications() == []


def test_fast_exit_notify_on_complete_is_configured_before_reader_starts(monkeypatch):
    monkeypatch.setattr(
        "tools.process_registry._is_supervised_gateway_process",
        lambda: False,
    )
    registry = ProcessRegistry()

    session = registry.spawn_local(
        f'{sys.executable} -c "pass"',
        cwd="/tmp",
        notify_on_complete=True,
    )

    assert session._completion_event.wait(timeout=5)
    notifications = registry.drain_notifications(skip_poll_observed=False)
    assert [event[0]["session_id"] for event in notifications] == [session.id]

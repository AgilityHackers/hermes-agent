"""The onboarding connector wishlist, as the agent sees it.

``mcp.connectors`` records apps the user said they use during desktop
onboarding. Nothing was configured and no credential was collected — that is
the point, since sign-in is deferred to the moment a task needs the app. The
gap only pays off if the agent knows about it, so these tests pin the three
properties that make the hint useful without being harmful:

- it names connectors the user wants but hasn't connected
- it drops one the moment it IS configured, so the agent never offers a
  connector the user already has
- it only reaches the desktop, the one surface with ``setup_mcp``

Run against the real prompt builder: the hint lives in the byte-stable cached
prefix, and a mock would hide the cache-safety property being verified.
"""

from types import SimpleNamespace
from unittest.mock import patch

import pytest

from agent.system_prompt import _pending_connectors_hint, build_system_prompt_parts


@pytest.fixture
def config(monkeypatch):
    """Patch the readonly config loader the hint reads."""

    def apply(payload):
        monkeypatch.setattr(
            "hermes_cli.config.load_config_readonly", lambda *a, **k: payload
        )

    return apply


def _make_agent(platform):
    return SimpleNamespace(
        load_soul_identity=False,
        skip_context_files=False,
        valid_tool_names=[],
        _task_completion_guidance=False,
        _tool_use_enforcement=False,
        _environment_probe=False,
        _kanban_worker_guidance="",
        _memory_store=None,
        _memory_manager=None,
        _platform_hint_overrides={},
        model="",
        provider="",
        pass_session_id=False,
        session_id="",
        platform=platform,
    )


def _stable_prompt(agent):
    with (
        patch("run_agent.load_soul_md", return_value=""),
        patch("run_agent.build_nous_subscription_prompt", return_value=""),
        patch("run_agent.build_environment_hints", return_value=""),
        patch("run_agent.build_context_files_prompt", return_value=""),
    ):
        return build_system_prompt_parts(agent)["stable"]


class TestPendingConnectorsHint:
    def test_names_the_connectors_the_user_wants(self, config):
        config({"mcp": {"connectors": ["linear", "notion"]}})

        hint = _pending_connectors_hint()

        assert "linear" in hint
        assert "notion" in hint
        assert "setup_mcp" in hint

    def test_configured_connectors_drop_off(self, config):
        """Offering a connector the user already has is the failure mode this
        subtraction exists to prevent."""
        config(
            {
                "mcp": {"connectors": ["linear", "notion"]},
                "mcp_servers": {"notion": {"url": "https://mcp.notion.com/mcp"}},
            }
        )

        hint = _pending_connectors_hint()

        assert "linear" in hint
        assert "notion" not in hint

    def test_nothing_pending_produces_no_hint(self, config):
        config(
            {
                "mcp": {"connectors": ["notion"]},
                "mcp_servers": {"notion": {"url": "https://mcp.notion.com/mcp"}},
            }
        )

        assert _pending_connectors_hint() == ""

    @pytest.mark.parametrize(
        "payload",
        [
            {},
            {"mcp": {}},
            {"mcp": {"connectors": []}},
            # Hand-edited config with the wrong shape must not raise into
            # prompt assembly — a bad key cannot be allowed to break chat.
            {"mcp": {"connectors": "linear"}},
            {"mcp": "not-a-dict"},
        ],
    )
    def test_missing_or_malformed_wishlist_is_silent(self, config, payload):
        config(payload)

        assert _pending_connectors_hint() == ""

    def test_malformed_mcp_servers_does_not_suppress_the_hint(self, config):
        """A broken `mcp_servers` means we can't subtract anything — offering
        a connector the user may already have beats going silent."""
        config({"mcp": {"connectors": ["linear"]}, "mcp_servers": "not-a-dict"})

        assert "linear" in _pending_connectors_hint()

    def test_unreadable_config_is_silent(self, monkeypatch):
        monkeypatch.setattr(
            "hermes_cli.config.load_config_readonly",
            lambda *a, **k: (_ for _ in ()).throw(OSError("permission denied")),
        )

        assert _pending_connectors_hint() == ""

    def test_duplicates_and_blanks_are_normalized(self, config):
        config({"mcp": {"connectors": ["linear", " linear ", "", "notion"]}})

        hint = _pending_connectors_hint()

        assert hint.count("linear") == 1


class TestHintReachesOnlyTheDesktopPrefix:
    def test_desktop_prompt_carries_the_hint_in_the_stable_prefix(self, config):
        """Stable prefix, not a per-turn injection: the list is intent, so it
        cannot shift mid-conversation and break the prompt cache."""
        config({"mcp": {"connectors": ["linear"]}})

        assert "not connected yet: linear" in _stable_prompt(_make_agent("desktop"))

    @pytest.mark.parametrize("platform", ["cli", "tui", "telegram", "discord"])
    def test_other_surfaces_never_see_it(self, config, platform):
        """setup_mcp is desktop-only, so naming un-connected connectors
        anywhere else would advertise an action the agent cannot take."""
        config({"mcp": {"connectors": ["linear"]}})

        assert "not connected yet" not in _stable_prompt(_make_agent(platform))

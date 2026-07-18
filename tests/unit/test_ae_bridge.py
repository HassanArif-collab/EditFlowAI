"""AE agent bridge: the eval round-trip is the contract the whole agent
dev loop depends on — a hang or silent drop here makes agents blind."""
import asyncio

import pytest

from backend.routes import ae_bridge as ab


@pytest.fixture(autouse=True)
def _restore_send(monkeypatch):
    yield
    # each test monkeypatches _send_to_panel; fixture keeps them isolated


@pytest.mark.asyncio
async def test_eval_roundtrip_resolves_when_panel_posts_result(monkeypatch):
    sent = []

    async def fake_send(msg):
        sent.append(msg)
        return True

    monkeypatch.setattr(ab, "_send_to_panel", fake_send)
    task = asyncio.create_task(ab.run_job("ef_ping", [], timeout=5))
    await asyncio.sleep(0.01)
    assert sent and sent[0]["type"] == "agent_eval" and sent[0]["fn"] == "ef_ping"
    job_id = sent[0]["job_id"]
    assert ab.complete_job(job_id, {"ok": True, "result": "pong"})
    out = await task
    assert out["result"] == "pong"


@pytest.mark.asyncio
async def test_eval_timeout_raises_instead_of_hanging(monkeypatch):
    async def fake_send(msg):
        return True

    monkeypatch.setattr(ab, "_send_to_panel", fake_send)
    with pytest.raises(ab.JobTimeout):
        await ab.run_job("ef_ping", [], timeout=0.05)
    assert not ab._jobs  # job cleaned up


@pytest.mark.asyncio
async def test_eval_without_panel_fails_fast(monkeypatch):
    async def fake_send(msg):
        return False

    monkeypatch.setattr(ab, "_send_to_panel", fake_send)
    with pytest.raises(ab.PanelUnavailable):
        await ab.run_job("ef_ping", [], timeout=5)


def test_complete_unknown_job_is_harmless():
    assert ab.complete_job("nope", {"ok": True}) is False

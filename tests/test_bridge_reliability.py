import asyncio
from collections import OrderedDict

import pytest
from fastapi import HTTPException

from backend.routes import premiere as rpc


@pytest.fixture
def bridge(monkeypatch):
    monkeypatch.setattr(rpc.manager, "active_connections", {})
    for name in ("_pending_rpc", "_rpc_targets"):
        monkeypatch.setattr(rpc, name, {})
    for name in ("_completed_rpc", "_rpc_started"):
        monkeypatch.setattr(rpc, name, OrderedDict())
    monkeypatch.setattr(rpc, "_queued_rpc", [])
    return rpc


def test_offline_mutations_cannot_run_later(bridge):
    result = asyncio.run(bridge.execute_premiere_rpc(bridge.PremiereRPCRequest(command="processEDL", queue_if_offline=True)))
    assert result["success"] is False
    assert bridge._queued_rpc == []


def test_multiple_panels_require_a_target(bridge):
    bridge.manager.active_connections.update({"cep-a": object(), "cep-b": object()})
    result = asyncio.run(bridge.execute_premiere_rpc(bridge.PremiereRPCRequest(command="processEDL")))
    assert result["success"] is False
    assert "target_client_id" in result["error"]


def test_failure_propagates_and_duplicate_request_never_edits_twice(bridge, monkeypatch):
    bridge.manager.active_connections["cep-a"] = object()
    sent = []
    async def send_to(client, message):
        sent.append((client, message))
        await bridge.receive_premiere_rpc_result(bridge.PremiereRPCResult(request_id=message["request_id"],
            client_id=client, result={"success": False, "failedCount": 1, "error": "Import failed"}))
    monkeypatch.setattr(bridge.manager, "send_to", send_to)
    async def exercise():
        request = bridge.PremiereRPCRequest(command="processEDL", request_id="one-edit")
        first = await bridge.execute_premiere_rpc(request)
        second = await bridge.execute_premiere_rpc(request)
        assert not first["success"] and not second["success"]
        assert second["deduplicated"]
        assert len(sent) == 1 and sent[0][0] == "cep-a"
        with pytest.raises(HTTPException) as exc:
            await bridge.execute_premiere_rpc(bridge.PremiereRPCRequest(command="importFiles", request_id="one-edit"))
        assert exc.value.status_code == 409
    asyncio.run(exercise())


def test_wrong_panel_cannot_complete_a_request(bridge):
    bridge._rpc_targets["edit-1"] = "cep-a"
    with pytest.raises(HTTPException):
        asyncio.run(bridge.receive_premiere_rpc_result(bridge.PremiereRPCResult(request_id="edit-1", client_id="cep-b", result={"success":True})))

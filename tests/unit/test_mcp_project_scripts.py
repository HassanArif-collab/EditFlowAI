"""External agents use the same project-scoped compile contract as the panel."""
from backend import mcp_server as mcp


def test_project_discovery_passes_explicit_context(monkeypatch):
    calls = []
    monkeypatch.setattr(mcp, "ensure_backend_online", lambda: {"online": True})
    monkeypatch.setattr(mcp, "_http_request", lambda *a, **k: calls.append((a, k)) or {"success": True})
    mcp.execute_tool("editflow_list_project_scripts", {"project_folder": "D:/Brand/2026-10-30 Campaign"})
    assert "folder_path=D%3A%2FBrand%2F2026-10-30+Campaign" in calls[0][0][1]


def test_script_references_use_only_read_endpoints(monkeypatch):
    calls=[]
    monkeypatch.setattr(mcp,'ensure_backend_online',lambda: {'online':True})
    monkeypatch.setattr(mcp,'_http_request',lambda *a,**kw: calls.append(a) or {'success':True})
    mcp.execute_tool('editflow_script_catalog',{'brand':'Brand A','query':'fresh hook'})
    mcp.execute_tool('editflow_read_script_reference',{'brand':'Brand A','path':'D:/Brand/Script 54.md'})
    assert all(call[0]=='GET' for call in calls)
    assert '/script-catalog?' in calls[0][1] and 'query=fresh+hook' in calls[0][1]
    assert '/script-reference?' in calls[1][1]


def test_preview_uses_actual_compile_fields_and_never_applies(monkeypatch):
    calls = []
    monkeypatch.setattr(mcp, "ensure_backend_online", lambda: {"online": True})

    def request(method, path, **kwargs):
        calls.append((method, path, kwargs))
        return {"success": True, "plan": {"cuts": [{}]}, "edl_ops": [{"action": "add"}]}

    monkeypatch.setattr(mcp, "_http_request", request)
    result = mcp.execute_tool("editflow_assemble_story_cut", {
        "script_path": "D:/Project/Scripts/Script.md", "project_folder": "D:/Project", "preview_only": True,
    })
    assert result["status"] == "compiled"
    assert len(calls) == 1
    assert calls[0][2]["body"]["script_path"].endswith("Script.md")
    assert calls[0][2]["body"]["project_folder"] == "D:/Project"
    assert "script_text" not in calls[0][2]["body"]


def test_failed_premiere_operation_is_not_reported_as_success(monkeypatch):
    monkeypatch.setattr(mcp, "ensure_backend_online", lambda: {"online": True})
    monkeypatch.setattr(mcp, "_http_request", lambda *a, **k: {
        "success": True, "plan": {"cuts": [{}]}, "edl_ops": [{"action": "add"}],
    })
    monkeypatch.setattr(mcp, "_call_premiere_rpc", lambda *a, **k: {
        "success": True, "result": {"success": False, "failedCount": 1, "error": "Missing media"},
    })
    monkeypatch.setattr(mcp, "_project_binding", lambda *a: {"success": True, "premiere_project_path": "D:/Project/Finals/video.prproj"})
    result = mcp.execute_tool("editflow_assemble_story_cut", {"script_text": "A script", "project_folder": "D:/Project"})
    assert result["success"] is False
    assert result["error"] == "Missing media"

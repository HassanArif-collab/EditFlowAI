import io
import json
import wave
from pathlib import Path

import pytest

from backend import mcp_server as mcp


@pytest.fixture
def project(tmp_path, monkeypatch):
    monkeypatch.setattr(mcp,"ensure_backend_online",lambda:{"online":True})
    context = {"success":True,"project_folder":str(tmp_path),"brand":"Client B","voice":{},
               "paths":{"voice":str(tmp_path/"Voice/Generated"),"brand_media":str(tmp_path)},
               "premiere_project_path":str(tmp_path/"Finals/edit.prproj")}
    monkeypatch.setattr(mcp,"_http_request",lambda *a,**kw:context)
    return context


def test_another_brand_does_not_inherit_raf_voice(project):
    result=mcp.execute_tool("editflow_generate_voiceover",{"text":"Narration", "project_folder":project["project_folder"]})
    assert not result["success"] and "Choose a Cartesia voice" in result["error"]


def test_voice_generation_uses_project_output_and_only_selected_profile(project, monkeypatch):
    monkeypatch.setattr(mcp,"get_cartesia_api_key",lambda:"test-only-key")
    data=io.BytesIO()
    with wave.open(data,"wb") as wav:
        wav.setnchannels(1);wav.setsampwidth(2);wav.setframerate(44100);wav.writeframes(b"\0\0"*4410)
    requests=[]
    class Response(io.BytesIO):
        pass
    def open_url(request,timeout):
        requests.append(json.loads(request.data))
        return Response(data.getvalue())
    monkeypatch.setattr(mcp.urllib.request,"urlopen",open_url)
    voice="12345678-1234-1234-1234-123456789abc"
    result=mcp.execute_tool("editflow_generate_voiceover",{"text":"Narration", "project_folder":project["project_folder"],"speaker":voice})
    assert result["success"]
    assert Path(result["file_path"]).is_relative_to(Path(project["paths"]["voice"]))
    assert requests[0]["voice"]["id"]==voice
    assert "pronunciation_dict_id" not in requests[0]


def test_custom_build_validates_all_sources_before_mutating(project,monkeypatch):
    monkeypatch.setattr(mcp,"_project_binding",lambda folder:project)
    monkeypatch.setattr(mcp,"_call_premiere_rpc",lambda *a,**kw:pytest.fail("Missing media must not start an edit"))
    result=mcp.execute_tool("premiere_build_custom_sequence",{"project_folder":project["project_folder"],"video_clips":[{"media_path":str(Path(project["project_folder"])/"missing.mp4"),"start_time":0}]})
    assert not result["success"]


def test_custom_build_uses_one_bound_batch_and_propagates_failures(project,monkeypatch):
    monkeypatch.setattr(mcp,"_project_binding",lambda folder:project)
    media=Path(project["project_folder"])/"source.mp4";media.write_bytes(b"test")
    monkeypatch.setattr(mcp,"_http_request",lambda *a,**kw:{"success":True,"source":{"duration":10},"framing":{"fit_scale":50,"zoom":1,"fit_mode":"fill"}})
    calls=[]
    def rpc(command,payload,**kw):
        calls.append((command,payload,kw))
        return {"success":False,"result":{"success":False,"failedCount":1,"error":"Import failed"}}
    monkeypatch.setattr(mcp,"_call_premiere_rpc",rpc)
    result=mcp.execute_tool("premiere_build_custom_sequence",{"project_folder":project["project_folder"],"video_clips":[{"media_path":str(media),"start_time":0,"duration":3}]})
    assert not result["success"] and result["error"]=="Import failed"
    assert len(calls)==1 and calls[0][0]=="processEDL"
    assert calls[0][1]["expected_project_path"]==project["premiere_project_path"]
    assert not calls[0][2]["queue_if_offline"]

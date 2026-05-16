from pathlib import Path

import pytest

from backend.models.v2_schemas import (
    AssetRegisterRequest,
    EditPlanCreateRequest,
    ReferenceResolveRequest,
    ReferenceRootRequest,
    ScriptIngestRequest,
    VisualMapIngestRequest,
)
from backend.services.reference_resolver_service import ReferenceResolverService
from backend.services.premiere_context_service import PremiereContextService
from backend.services.v2_registry_service import V2RegistryService


def test_script_ingestion_splits_lines():
    service = V2RegistryService()
    result = service.ingest_script(
        ScriptIngestRequest(
            title="Demo Script",
            content="First idea about automation. Second idea about results.",
        )
    )

    assert result["line_count"] >= 2
    assert result["lines"][0]["text"].startswith("First idea")


def test_asset_register_and_search(tmp_path: Path):
    media = tmp_path / "assetsearchtoken-demo.mp4"
    media.write_bytes(b"not real video but enough for registry")

    service = V2RegistryService()
    asset = service.register_asset(AssetRegisterRequest(path=str(media), tags=["raw"]))
    search = service.search_assets("assetsearchtoken", limit=5)

    assert asset["id"].startswith("asset_")
    assert asset["name"] == "assetsearchtoken-demo.mp4"
    assert any(hit["entity_id"] == asset["id"] for hit in search["results"])


def test_registry_rejects_test_paths_outside_test_mode(monkeypatch):
    monkeypatch.delenv("EDITFLOW_TEST_MODE", raising=False)

    service = V2RegistryService()
    with pytest.raises(ValueError, match="Refusing to store test/temp"):
        service.register_asset(
            AssetRegisterRequest(
                path=r"C:\Users\Hassan Arif\AppData\Local\Temp\pytest-of-Hassan Arif\bad.mp4"
            )
        )


def test_visual_map_parses_structured_rows(tmp_path: Path):
    folder = tmp_path / "broll"
    folder.mkdir()
    (folder / "automation.png").write_bytes(b"fake")

    service = V2RegistryService()
    result = service.ingest_visual_map(
        VisualMapIngestRequest(
            title="Visual Map",
            content=f"script_line_or_keyword | visual_folder | visual_type | placement_note | priority\n"
                    f"AI saves time | {folder} | screenshots | cover this line | high",
        )
    )

    assert result["entry_count"] == 1
    assert result["entries"][0]["matched_asset_ids"]


def test_edit_plan_dry_run_flags_missing_without_candidates():
    service = V2RegistryService()
    script = service.ingest_script(ScriptIngestRequest(title="Script", content="Talk about pricing."))
    plan = service.create_edit_plan(
        EditPlanCreateRequest(
            sources=["@asset:missing"],
            script_id=script["id"],
        )
    )
    dry_run = service.dry_run_plan(plan["id"])

    assert dry_run["success"] is True
    assert dry_run["missing_lines"]
    assert dry_run["would_change"] == 0


def test_capabilities_are_explicit_about_planned_execution():
    service = V2RegistryService()
    capabilities = {item["name"]: item["status"] for item in service.capabilities()}

    assert capabilities["edit_plan_dry_run"] == "available"
    assert capabilities["premiere_template_edl_generation"] == "available"
    assert capabilities["premiere_bridge_execution"] == "available_in_cep"
    assert capabilities["premiere_verify"] == "available_with_sequence_snapshot"
    assert capabilities["generated_jsx_fallback"] == "planned"


def test_execute_plan_generates_edl_file_even_when_coverage_is_empty():
    service = V2RegistryService()
    script = service.ingest_script(ScriptIngestRequest(title="Script", content="Talk about pricing."))
    plan = service.create_edit_plan(
        EditPlanCreateRequest(
            sources=["@asset:missing"],
            script_id=script["id"],
        )
    )
    result = service.execute_plan(plan["id"])

    assert result["success"] is True
    assert result["status"] == "submitted"
    assert Path(result["edl_path"]).exists()
    assert result["clip_count"] == 0


def test_verify_plan_respects_premiere_failure():
    service = V2RegistryService()
    script = service.ingest_script(ScriptIngestRequest(title="Script", content="Talk about pricing."))
    plan = service.create_edit_plan(
        EditPlanCreateRequest(
            sources=["@asset:missing"],
            script_id=script["id"],
        )
    )
    service.execute_plan(plan["id"])
    result = service.verify_plan(
        plan["id"],
        premiere_result={"success": False, "error": "Premiere failed"},
        sequence_state={"clips": []},
    )

    assert result["verified"] is False
    assert "Premiere failed" in result["warnings"]


def test_job_update_records_background_progress():
    service = V2RegistryService()
    job = service.create_job("asset_analysis", "asset_demo", "queued", "Queued")
    updated = service.update_job(
        job["id"],
        status="running",
        progress=0.5,
        message="Halfway",
        result={"step": "transcribing"},
    )

    assert updated["status"] == "running"
    assert updated["progress"] == 0.5
    assert updated["message"] == "Halfway"
    assert updated["result"]["step"] == "transcribing"


def test_phase1_resolver_ignores_stale_local_raw_root_when_bin_not_scanned(tmp_path: Path):
    raw = tmp_path / "raw"
    folder = raw / "6"
    folder.mkdir(parents=True)
    (folder / "take-one.mp4").write_bytes(b"fake video")
    (folder / "take-two.mp4").write_bytes(b"fake video")

    resolver = ReferenceResolverService()
    resolver.set_root(ReferenceRootRequest(alias="raw", path=str(raw)))
    resolved = resolver.resolve(
        ReferenceResolveRequest(
            text="find videos in raw in folder 6",
            kind="bin_or_folder",
            root_alias="raw",
            folder_name="6",
            register_assets=False,
        )
    )

    assert resolved["success"] is False
    assert "bin:raw/6" in [item.lower() for item in resolved["missing"]]
    assert "Phase 1" in resolved["message"]
    assert str(raw) not in resolved.get("root_path", "")


def test_reference_resolver_prefers_premiere_bin_for_raw_folder_request(tmp_path: Path):
    media = tmp_path / "take-one.mp4"
    media.write_bytes(b"fake video")

    premiere = PremiereContextService()
    premiere.save_project_context(
        {
            "bins": [
                {"name": "Raw", "binPath": "Raw", "itemId": "bin_raw"},
                {"name": "6", "binPath": "Raw/6", "itemId": "bin_raw_6"},
            ],
            "items": [
                {
                    "name": "take-one.mp4",
                    "itemId": "item_take_one",
                    "mediaPath": str(media),
                    "mediaType": "VIDEO",
                    "binPath": "Raw/6",
                }
            ],
        }
    )

    resolver = ReferenceResolverService()
    resolved = resolver.resolve(
        ReferenceResolveRequest(
            text="take the videos of folder 6 in the raw folder and make a new sequence",
            root_alias="raw",
            folder_name="6",
        )
    )

    assert resolved["success"] is True
    assert resolved["kind"] == "bin"
    assert resolved["bin_path"] == "Raw/6"
    assert resolved["media_count"] == 1
    assert len(resolved["asset_ids"]) == 1


def test_phase1_resolver_verifies_raw_bin_with_two_mp4_items(tmp_path: Path):
    media_a = tmp_path / "one.mp4"
    media_b = tmp_path / "two.mp4"
    media_a.write_bytes(b"fake video")
    media_b.write_bytes(b"fake video")

    premiere = PremiereContextService()
    premiere.save_project_context(
        {
            "bins": [{"name": "6", "binPath": "Raw/6", "itemId": "bin_raw_6"}],
            "items": [
                {
                    "name": "one.mp4",
                    "itemId": "item_one",
                    "mediaPath": str(media_a),
                    "mediaType": "VIDEO",
                    "binPath": "Raw/6",
                },
                {
                    "name": "two.mp4",
                    "itemId": "item_two",
                    "mediaPath": str(media_b),
                    "mediaType": "VIDEO",
                    "binPath": "Raw/6",
                },
            ],
        }
    )

    resolver = ReferenceResolverService()
    resolved = resolver.resolve(
        ReferenceResolveRequest(
            text="find videos in raw folder 6",
            kind="bin",
            root_alias="raw",
            folder_name="6",
            register_assets=False,
        )
    )

    assert resolved["success"] is True
    assert resolved["kind"] == "bin"
    assert resolved["bin_path"] == "Raw/6"
    assert resolved["media_count"] == 2
    assert [item["name"] for item in resolved["items"]] == ["one.mp4", "two.mp4"]
    assert resolved["asset_ids"] == []


def test_reference_resolver_supports_explicit_premiere_bin_reference(tmp_path: Path):
    media = tmp_path / "take-two.mp4"
    media.write_bytes(b"fake video")

    premiere = PremiereContextService()
    premiere.save_project_context(
        {
            "bins": [{"name": "6", "binPath": "Raw/6", "itemId": "bin_raw_6"}],
            "items": [
                {
                    "name": "take-two.mp4",
                    "itemId": "item_take_two",
                    "mediaPath": str(media),
                    "mediaType": "VIDEO",
                    "binPath": "Raw/6",
                }
            ],
        }
    )

    resolver = ReferenceResolverService()
    resolved = resolver.resolve(ReferenceResolveRequest(text="use @bin:Raw/6"))

    assert resolved["success"] is True
    assert resolved["kind"] == "bin"
    assert resolved["bin_path"] == "Raw/6"
    assert resolved["media_count"] == 1


def test_premiere_context_clear_prevents_stale_bin_resolution(tmp_path: Path):
    media = tmp_path / "old.mp4"
    media.write_bytes(b"fake video")

    premiere = PremiereContextService()
    premiere.save_project_context(
        {
            "bins": [{"name": "6", "binPath": "Raw/6", "itemId": "bin_raw_6"}],
            "items": [
                {
                    "name": "old.mp4",
                    "itemId": "old_item",
                    "mediaPath": str(media),
                    "mediaType": "VIDEO",
                    "binPath": "Raw/6",
                }
            ],
        }
    )
    premiere.clear_project_context()

    resolver = ReferenceResolverService()
    resolved = resolver.resolve(ReferenceResolveRequest(text="use @bin:Raw/6", kind="bin"))

    assert resolved["success"] is False
    assert "bin:Raw/6" in resolved["missing"]


def test_premiere_bin_summaries_include_media_counts(tmp_path: Path):
    media_a = tmp_path / "a.mp4"
    media_b = tmp_path / "b.mp4"
    media_a.write_bytes(b"fake video")
    media_b.write_bytes(b"fake video")

    premiere = PremiereContextService()
    premiere.save_project_context(
        {
            "bins": [{"name": "6", "binPath": "Raw/6", "itemId": "bin_raw_6"}],
            "items": [
                {"name": "a.mp4", "mediaPath": str(media_a), "mediaType": "VIDEO", "binPath": "Raw/6"},
                {"name": "b.mp4", "mediaPath": str(media_b), "mediaType": "VIDEO", "binPath": "Raw/6"},
            ],
        }
    )

    summaries = premiere.list_bin_summaries()

    assert summaries[0]["bin_path"] == "Raw/6"
    assert summaries[0]["item_count"] == 2
    assert summaries[0]["media_count"] == 2


def test_combine_folder_assets_dry_run_creates_timeline_items(tmp_path: Path):
    media_a = tmp_path / "a.mp4"
    media_b = tmp_path / "b.mp4"
    media_a.write_bytes(b"fake")
    media_b.write_bytes(b"fake")

    service = V2RegistryService()
    asset_a = service.register_asset(AssetRegisterRequest(path=str(media_a)))
    asset_b = service.register_asset(AssetRegisterRequest(path=str(media_b)))
    plan = service.create_edit_plan(
        EditPlanCreateRequest(
            operation="combine_folder_videos_new_sequence",
            sources=[f"@asset:{asset_a['id']}", f"@asset:{asset_b['id']}"],
            constraints={"default_clip_duration": 5},
        )
    )
    dry_run = service.dry_run_plan(plan["id"])

    assert dry_run["success"] is True
    assert len(dry_run["timeline_items"]) == 2
    assert dry_run["would_change"] == 2
    assert dry_run["estimated_duration"] == 10


def test_combine_folder_assets_execute_generates_non_empty_edl(tmp_path: Path):
    media_a = tmp_path / "a.mp4"
    media_b = tmp_path / "b.mp4"
    media_a.write_bytes(b"fake")
    media_b.write_bytes(b"fake")

    service = V2RegistryService()
    asset_a = service.register_asset(AssetRegisterRequest(path=str(media_a)))
    asset_b = service.register_asset(AssetRegisterRequest(path=str(media_b)))
    plan = service.create_edit_plan(
        EditPlanCreateRequest(
            operation="combine_folder_videos_new_sequence",
            sources=[f"@asset:{asset_a['id']}", f"@asset:{asset_b['id']}"],
            constraints={"default_clip_duration": 5},
        )
    )
    result = service.execute_plan(plan["id"])

    assert result["success"] is True
    assert result["clip_count"] >= 2
    assert result["virtual_edit_spec"]["clips"][0]["source_path"] == asset_a["path"]

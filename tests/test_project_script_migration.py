"""Migration keeps content and legacy paths, and refuses uncertain destinations."""
import importlib.util
from pathlib import Path

import pytest

spec = importlib.util.spec_from_file_location("project_script_migration", Path(__file__).parents[1] / "scripts/migrate_project_scripts.py")
migration = importlib.util.module_from_spec(spec)
spec.loader.exec_module(migration)


def entry(brand, source, target, kind="directory"):
    return {"brand_root": str(brand), "source": str(source), "target": str(target), "type": kind}


def test_moved_folder_keeps_working_legacy_path_and_can_run_twice(tmp_path):
    brand = tmp_path / "Brand"
    source = brand / "Legacy/Scripts"
    source.mkdir(parents=True)
    (source / "Script.md").write_text("An exact source quote.", encoding="utf-8")
    target = brand / "2026-10-30 Campaign/Scripts"
    mapping = [entry(brand, source, target)]
    assert migration.migrate(mapping)[0]["status"] == "planned"
    assert not target.exists()
    result = migration.migrate(mapping, apply=True)
    assert result[0]["verified_files"] == 1
    assert (source / "Script.md").read_text() == (target / "Script.md").read_text()
    (target / "Script.md").write_text("Revised in the project.")
    assert (source / "Script.md").read_text() == "Revised in the project."
    assert migration.migrate(mapping, apply=True)[0]["status"] == "already_organized"


def test_full_map_is_validated_before_any_directory_is_moved(tmp_path):
    brand = tmp_path / "Brand"
    source = brand / "Legacy/Scripts"
    source.mkdir(parents=True)
    mapping = [entry(brand, source, brand / "Project/Scripts"),
               entry(brand, source, tmp_path / "Other Brand/Scripts")]
    with pytest.raises(ValueError):
        migration.migrate(mapping, apply=True)
    assert source.is_dir()
    assert not (brand / "Project/Scripts").exists()


def test_failure_to_create_legacy_link_rolls_back_directory_move(tmp_path, monkeypatch):
    brand = tmp_path / "Brand"
    source = brand / "Legacy/Scripts"
    source.mkdir(parents=True)
    (source / "Script.md").write_text("Original")
    target = brand / "Project/Scripts"

    def fail(*args):
        raise OSError("Cannot create compatibility link")

    monkeypatch.setattr(migration, "_legacy_directory_link", fail)
    with pytest.raises(OSError):
        migration.migrate([entry(brand, source, target)], apply=True)
    assert (source / "Script.md").read_text() == "Original"
    assert not target.exists()


def test_copying_shared_script_preserves_original_and_refuses_overwrite(tmp_path):
    brand = tmp_path / "Brand"
    source = brand / "Shared/Script.md"
    source.parent.mkdir(parents=True)
    source.write_text("Exact quoted dialogue")
    target = brand / "Project/Scripts/Script.md"
    mapping = [entry(brand, source, target, "copy_file")]
    assert migration.migrate(mapping, apply=True)[0]["legacy_original_preserved"]
    assert target.read_text() == source.read_text()
    target.write_text("A project-specific revision")
    with pytest.raises(ValueError):
        migration.migrate(mapping, apply=True)
    assert target.read_text() == "A project-specific revision"

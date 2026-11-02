import pytest
from backend.services.script_sources import register_alias,current_script,revision,ScriptConflictError


def setup(tmp_path):
    canonical=tmp_path/'project/script.md';canonical.parent.mkdir()
    alias=tmp_path/'old/script.md';alias.parent.mkdir()
    canonical.write_text('original',encoding='utf-8');alias.write_text('original',encoding='utf-8')
    registry=tmp_path/'registry.json'
    register_alias(canonical,alias,revision('original'),registry)
    return canonical,alias,registry


def test_legacy_edit_updates_project_copy(tmp_path):
    canonical,alias,registry=setup(tmp_path)
    alias.write_text('edited legacy',encoding='utf-8')
    assert current_script(canonical,registry)==canonical
    assert canonical.read_text()=='edited legacy'


def test_project_edit_and_atomic_alias_save_stay_current(tmp_path):
    canonical,alias,registry=setup(tmp_path)
    canonical.write_text('project edit',encoding='utf-8')
    current_script(alias,registry)
    assert alias.read_text()=='project edit'
    replacement=tmp_path/'new.md';replacement.write_text('atomic editor save',encoding='utf-8');replacement.replace(alias)
    current_script(canonical,registry)
    assert canonical.read_text()=='atomic editor save'


def test_divergent_edits_are_preserved(tmp_path):
    canonical,alias,registry=setup(tmp_path)
    canonical.write_text('first edit',encoding='utf-8');alias.write_text('second edit',encoding='utf-8')
    with pytest.raises(ScriptConflictError):current_script(canonical,registry)
    assert canonical.read_text()=='first edit' and alias.read_text()=='second edit'


def test_migration_registration_covers_all_identical_copies_without_guessing(tmp_path):
    import json
    from backend.services.script_sources import register_migration_copies
    canonical,alias,registry=setup(tmp_path)
    registry.unlink()
    report=tmp_path/'report.json'
    report.write_text(json.dumps({'migrations':[{'type':'copy_file','status':'copied',
        'target':str(canonical),'source':str(alias)}]}))
    assert register_migration_copies(report,registry)[0]['status']=='registered'
    alias.write_text('new script51 revision')
    current_script(canonical,registry)
    assert canonical.read_text()=='new script51 revision'
    registry.unlink()
    canonical.write_text('different project edit')
    assert register_migration_copies(report,registry)[0]['status']=='conflict'
    assert canonical.read_text()=='different project edit'
    assert alias.read_text()=='new script51 revision'

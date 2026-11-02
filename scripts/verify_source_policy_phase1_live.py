"""Verify read-only source previews and existing Script 52 without timeline edits."""
import json
from pathlib import Path
import urllib.parse
import urllib.request
import urllib.error

ROOT = Path(__file__).resolve().parent.parent
PROJECT = 'D:/MARKETING/Jamia Masjid Chicago/2026-10-30 Video for 501(c)(3)'


def api(path, body=None):
    request = urllib.request.Request('http://127.0.0.1:8765/api/' + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers={'Content-Type': 'application/json'})
    try:
        return json.load(urllib.request.urlopen(request, timeout=60))
    except urllib.error.HTTPError as exc:
        raise RuntimeError(exc.read().decode('utf-8')) from exc


def main():
    output = {}
    for brand, folder, report_name in [
        ('Jamia Masjid Chicago', PROJECT, 'source-policy-phase1-jamia.json'),
        ('Rahima Aziz Foundation', 'D:/MARKETING/Rahima Aziz Foundation/2026-10-21 Video Of Parking Lot', 'source-policy-phase1-raf.json')]:
        expected = json.loads((ROOT / 'data/output' / report_name).read_text(encoding='utf-8'))
        preview = api('library-sources/migration-preview', {'brand': brand, 'project_folder': folder})
        assert preview['mode'] == 'preview' and not preview['applied']
        assert preview['input_revision'] == expected['input_revision'], 'Review inputs changed since the saved preview.'
        state = api('library-sources/policy?' + urllib.parse.urlencode({'brand': brand, 'project_folder': folder}))
        assert state['active'] is False and state['sources'] == []
        output[brand] = preview['summary']
    scripts = api('script-assembly/scripts?' + urllib.parse.urlencode({'folder_path': PROJECT}))
    assert {row['name'].split('_')[1] for row in scripts['scripts']} == {'51', '52', '53', '54'}
    script = next(row for row in scripts['scripts'] if row['name'].startswith('Script_52_'))
    # Reuse the current brand's legacy media cache after the backend reload;
    # this does not enroll sources or run transcription/vision analysis.
    api('media-resolver/index', {'root_dir': str(Path(PROJECT).parent), 'force': False})
    try:
        compiled = api('script-assembly/compile', {'script_path': script['full_path'], 'project_folder': PROJECT, 'auto_broll': False})
        assert compiled['plan']['validation']['valid']
        output['existing_script52'] = {'valid': True, 'cuts': len(compiled['plan']['cuts']),
            'duration': compiled['plan']['summary']['total_duration']}
    except RuntimeError as exc:
        # Record this separately, never claim that an unrelated blocked script passed.
        if 'Both the project script and its legacy copy changed differently' not in str(exc):
            raise
        output['existing_script52'] = {'valid': False, 'status': 'blocked_by_existing_copy_conflict',
            'detail': str(exc), 'files_preserved': True}
    (ROOT / 'data/output/source-policy-phase1-live.json').write_text(json.dumps(output, indent=2), encoding='utf-8')
    print(json.dumps(output))


if __name__ == '__main__':
    main()

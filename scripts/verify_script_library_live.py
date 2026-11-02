"""Verify catalog, current script text and panel browsing without editing a timeline."""
import asyncio
import json
from pathlib import Path
import urllib.parse
import urllib.request

import websockets

ROOT = Path(__file__).resolve().parent.parent
BASE = 'http://127.0.0.1:8765'


def get(endpoint, **params):
    url = BASE + '/api/script-assembly/' + endpoint + '?' + urllib.parse.urlencode(params)
    return json.load(urllib.request.urlopen(url, timeout=30))


async def main():
    catalogs = {brand: get('script-catalog', brand=brand)
                for brand in ('Jamia Masjid Chicago', 'Rahima Aziz Foundation')}
    jamia = catalogs['Jamia Masjid Chicago']
    assert jamia['total'] > 2
    assert all(row['brand'] == brand for brand, value in catalogs.items() for row in value['scripts'])
    sample = next((row for row in jamia['scripts'] if row['name'].startswith('Script_54')), jamia['scripts'][-1])
    reference = get('script-reference', brand=jamia['brand'], path=sample['full_path'])
    assert reference['content'] == Path(sample['full_path']).read_text(encoding='utf-8')
    migrated = json.loads((ROOT / 'data/output/project-script-migration-report.json').read_text())['migrations']
    current = []
    for row in migrated:
        if row['type'] != 'copy_file':
            continue
        text = get('script-content', path=row['target'])
        assert text['content'] == Path(row['source']).read_text(encoding='utf-8')
        assert text['content'] == Path(row['target']).read_text(encoding='utf-8')
        current.append({'name': Path(row['target']).name, 'revision': text['revision']})
    tabs = json.load(urllib.request.urlopen('http://127.0.0.1:8088/json', timeout=5))
    tab = next(t for t in tabs if 'cep-loader' in t.get('url', ''))
    async with websockets.connect(tab['webSocketDebuggerUrl']) as ws:
        counter = 0

        async def call(method, params):
            nonlocal counter
            counter += 1
            await ws.send(json.dumps({'id': counter, 'method': method, 'params': params}))
            while True:
                response = json.loads(await ws.recv())
                if response.get('id') == counter:
                    return response.get('result', {})

        async def evaluate(expression):
            result = await call('Runtime.evaluate', {'expression': expression, 'awaitPromise': True, 'returnByValue': True})
            if result.get('exceptionDetails'):
                raise RuntimeError(str(result['exceptionDetails']))
            return result.get('result', {}).get('value')

        await call('Page.reload', {'ignoreCache': True})
        for _ in range(30):
            if await evaluate('!!window.__editflowShowView'):
                break
            await asyncio.sleep(.2)
        await evaluate("window.__editflowShowView('storyCut')")
        for _ in range(150):
            if await evaluate('!!window.__storyCutState && window.__storyCutState.projectInitialized && !!window.__storyCutState.plan && !window.__storyCutState.busy'):
                break
            await asyncio.sleep(.2)
        url = await evaluate('performance.getEntriesByType("resource").find(r=>r.name.includes("story-cut-view.js")).name')
        assert '20261102-script-projects-2' in url
        state = await evaluate('(async()=>{const m=await import(' + json.dumps(url) + ');'
            'await m.refreshSelectedScript(true);await m.openScriptLibrary();await m.readScriptReference(' + json.dumps(sample['full_path']) + ');'
            'const s=window.__storyCutState;const reference=s.scriptReference?.full_path;document.querySelector("#sc-close-script-library").click();'
            'if(s.showEmptyProjects)document.querySelector("#sc-toggle-empty-projects").click();'
            'const visible=m.visibleScriptProjects().map(p=>p.name);document.querySelector("#sc-toggle-empty-projects").click();'
            'const expanded=m.visibleScriptProjects().length;document.querySelector("#sc-toggle-empty-projects").click();'
            'return {mode:s.mode,selected:s.selectedScriptPath,revision:s.plan?.script_revision,'
            'validation:s.plan?.validation,duration:s.plan?.summary?.total_duration,'
            'scripts:s.scripts.map(c=>c.name),visibleProjects:visible,allProjectCount:expanded,'
            'voices:s.plan?.cuts.filter(c=>c.kind==="generated_narration").map(c=>({path:c.source_file,track:c.audio_track})),'
            'catalogCount:s.scriptLibrary?.total,reference:reference,'
            'button:!!document.querySelector("#sc-btn-script-library"),'
            'jobs:performance.getEntriesByType("resource").filter(r=>/transcribe|extract-audio/.test(r.name)).map(r=>r.name)};})()')
        assert state['button'] and state['catalogCount'] == jamia['total']
        assert state['reference'] == sample['full_path']
        assert not state['jobs']
        assert {name.split('_')[1] for name in state['scripts']} == {'51', '52', '53', '54'}
        assert state['validation']['valid'] and not state['validation']['warnings']
        assert len(state['voices']) == 2 and all(voice['track'] == 1 for voice in state['voices'])
        assert state['allProjectCount'] > len(state['visibleProjects'])
        assert all(project['script_count'] > 0 for project in get('projects', brand=jamia['brand'])['projects'] if project['name'] in state['visibleProjects'])
    result = {'catalogs': {brand: {'total': value['total'],
              'unassigned': sum(row['project_folder'] is None for row in value['scripts'])}
              for brand, value in catalogs.items()}, 'current_scripts': current, 'panel': state}
    (ROOT / 'data/output/script-library-live.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
    print(json.dumps(result))


if __name__ == '__main__':
    asyncio.run(main())

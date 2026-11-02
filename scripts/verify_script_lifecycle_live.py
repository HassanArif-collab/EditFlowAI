"""Verify the actual edited script and UI mode without starting transcription."""
import asyncio,json,sys,urllib.request,websockets
from pathlib import Path
ROOT=Path(__file__).resolve().parent.parent
sys.path.insert(0,str(ROOT))
from repair_script52_links import PROJECT,SCRIPT

def post(path,body):
    return json.load(urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:8765'+path,data=json.dumps(body).encode(),headers={'Content-Type':'application/json'}),timeout=60))

async def main():
    for i in range(20):
        try:urllib.request.urlopen('http://127.0.0.1:8765/api/ping',timeout=1);break
        except Exception:await asyncio.sleep(.5)
    result=post('/api/script-assembly/compile',{'script_path':str(SCRIPT),'project_folder':str(PROJECT),'auto_broll':True})
    plan=result['plan']
    assert len(plan['cuts'])==5 and '26s' in plan['title']
    assert 'Anees' in plan['cuts'][0]['speaker']
    print(json.dumps({'title':plan['title'],'cuts':len(plan['cuts']),'errors':plan['validation']['errors'],'warnings':plan['validation']['warnings']}))
    tabs=json.load(urllib.request.urlopen('http://127.0.0.1:8088/json'))
    tab=next(t for t in tabs if 'cep-loader' in t.get('url',''))
    async with websockets.connect(tab['webSocketDebuggerUrl']) as ws:
        index=0
        async def evaluate(expr):
            nonlocal index
            index+=1
            await ws.send(json.dumps({'id':index,'method':'Runtime.evaluate','params':{'expression':expr,'awaitPromise':True,'returnByValue':True}}))
            while True:
                data=json.loads(await ws.recv())
                if data.get('id')==index:return data.get('result',{}).get('result',{}).get('value')
        index+=1;await ws.send(json.dumps({'id':index,'method':'Page.reload','params':{'ignoreCache':True}}))
        await asyncio.sleep(3)
        await evaluate("window.__editflowShowView('storyCut')")
        await asyncio.sleep(2)
        url=await evaluate('performance.getEntriesByType("resource").find(r=>r.name.includes("story-cut-view.js")).name')
        expr='(async()=>{const m=await import('+json.dumps(url)+');await m.switchMode("rough_cut");window.__storyCutState.activeBrand="Jamia Masjid Chicago";await m.selectStoryCutProject('+json.dumps(str(PROJECT))+');const s=window.__storyCutState;s.selectedScriptPath='+json.dumps(str(SCRIPT))+';s.customMode=false;await m.compileScript();return JSON.stringify({mode:s.mode,kind:s.planKind,cuts:s.plan.cuts.length,first:s.plan.cuts[0].speaker,errors:s.plan.validation.errors});})()'
        state=json.loads(await evaluate(expr))
        assert state['mode']=='rough_cut' and state['kind']=='script' and state['cuts']==5
        print('Panel:',json.dumps(state))
    (ROOT/'data/output/script-lifecycle-live.json').write_text(json.dumps({'plan':plan,'panel':state},indent=2),encoding='utf-8')

if __name__=='__main__':asyncio.run(main())

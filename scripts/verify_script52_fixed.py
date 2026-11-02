import asyncio,json,sys,time,urllib.request,websockets
from pathlib import Path
ROOT=Path(__file__).resolve().parent.parent
sys.path.insert(0,str(ROOT))
from repair_script52_links import PROJECT,SCRIPT

def post(path,data):
    return json.load(urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:8765'+path,data=json.dumps(data).encode(),headers={'Content-Type':'application/json'}),timeout=60))

async def main():
    for attempt in range(20):
        try:
            urllib.request.urlopen('http://127.0.0.1:8765/api/ping',timeout=1);break
        except Exception:await asyncio.sleep(.5)
    result=post('/api/script-assembly/compile',{'project_folder':str(PROJECT),'script_path':str(SCRIPT),'auto_broll':True})
    plan=result['plan']
    check=post('/api/script-assembly/validate-plan',{'plan':plan})
    assert result['ready_to_assemble'] and check['valid'],json.dumps(plan['validation'])
    print(json.dumps({'ready':result['ready_to_assemble'],'cuts':len(plan['cuts']),'duration':plan['summary']['total_duration'],'errors':plan['validation']['errors'],'warnings':plan['validation']['warnings']}))
    tab=next(t for t in json.load(urllib.request.urlopen('http://127.0.0.1:8088/json')) if 'cep-loader' in t.get('url',''))
    async with websockets.connect(tab['webSocketDebuggerUrl']) as ws:
        counter=0
        async def evaluate(expression):
            nonlocal counter
            counter+=1
            await ws.send(json.dumps({'id':counter,'method':'Runtime.evaluate','params':{'expression':expression,'awaitPromise':True,'returnByValue':True}}))
            while True:
                message=json.loads(await ws.recv())
                if message.get('id')==counter:return message.get('result',{}).get('result',{}).get('value')
        await evaluate("window.__editflowShowView('storyCut')")
        await asyncio.sleep(2)
        await evaluate('(async()=>{const resource=performance.getEntriesByType("resource").find(r=>r.name.includes("story-cut-view.js"));const m=await import(resource.name);window.__storyCutState.activeBrand="Jamia Masjid Chicago";await m.selectStoryCutProject('+json.dumps(str(PROJECT))+');return true;})()')
        await evaluate('(()=>{const e=document.querySelector("#sc-script-select");e.value='+json.dumps(str(SCRIPT))+';e.dispatchEvent(new Event("change"));return true;})()')
        for attempt in range(25):
            await asyncio.sleep(.5)
            state=await evaluate('JSON.stringify({busy:window.__storyCutState.busy,validation:window.__storyCutState.plan?.validation})')
            if state:
                state=json.loads(state)
                if not state['busy'] and state.get('validation'):
                    print('Panel:',json.dumps(state));break

if __name__=='__main__':asyncio.run(main())

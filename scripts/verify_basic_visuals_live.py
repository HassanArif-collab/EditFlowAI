"""Check the basic source controls and read Premiere bins without linking anything."""
import asyncio
import json
import urllib.request
import websockets


async def main():
    tabs=json.load(urllib.request.urlopen('http://127.0.0.1:8088/json'))
    tab=next(t for t in tabs if 'cep-loader' in t.get('url',''))
    async with websockets.connect(tab['webSocketDebuggerUrl']) as ws:
        counter=0
        async def call(method,params):
            nonlocal counter
            counter+=1
            await ws.send(json.dumps({'id':counter,'method':method,'params':params}))
            while True:
                result=json.loads(await ws.recv())
                if result.get('id')==counter:return result.get('result',{})
        async def evaluate(code):
            result=await call('Runtime.evaluate',{'expression':code,'awaitPromise':True,'returnByValue':True})
            if result.get('exceptionDetails'):raise RuntimeError(str(result['exceptionDetails']))
            return result.get('result',{}).get('value')
        await call('Page.reload',{'ignoreCache':True})
        for _ in range(100):
            if await evaluate('!!window.__editflowShowView'):break
            await asyncio.sleep(.2)
        await evaluate("window.__editflowShowView('storyCut')")
        for _ in range(100):
            if await evaluate('!!window.__storyCutState?.projectInitialized && !window.__storyCutState.busy'):break
            await asyncio.sleep(.2)
        await evaluate("window.__storyCutState.showMoreDrawer=true;window.__editflowShowView('storyCut')")
        assert await evaluate('!!document.querySelector("#sc-basic-add-folder")')
        await evaluate('document.querySelector("#sc-basic-scan").click()')
        for _ in range(100):
            if await evaluate('!window.__storyCutState.busy'):break
            await asyncio.sleep(.2)
        state=await evaluate('({bins:window.__storyCutState.sourceScan?.bins?.length,project:window.__storyCutState.sourceScan?.path,status:window.__storyCutState.status,controls:!!document.querySelector("#sc-basic-add-bin")})')
        assert state.get('bins') and state['controls'],state
        print(json.dumps(state))


if __name__=='__main__':asyncio.run(main())

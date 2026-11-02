"""Inspect Story Cut runtime state through Premiere's existing local debugger."""
import asyncio
import json
import urllib.request
import websockets


async def main():
    tabs = json.load(urllib.request.urlopen('http://127.0.0.1:8088/json', timeout=5))
    tab = next(t for t in tabs if 'cep-loader' in t.get('url', ''))
    expression = """JSON.stringify({
      modules:performance.getEntriesByType('resource').filter(r=>/main.js|story-cut-view.js/.test(r.name)).map(r=>r.name),
      state:window.__storyCutState ? ((s)=>({mode:s.mode,project:s.projectFolder,selected:s.selectedScriptPath,
      custom:s.customMode,customHeading:s.customContent?.split('\\n')[0],planTitle:s.plan?.title,
      revision:s.plan?.script_revision,planPath:s.plan?.script_path,watch:!!s.scriptWatchTimer,busy:s.busy,
      status:s.status,first:s.plan?.cuts?.[0]?.quote}))(window.__storyCutState):null})"""
    async with websockets.connect(tab['webSocketDebuggerUrl']) as ws:
        await ws.send(json.dumps({'id': 1, 'method': 'Runtime.evaluate', 'params': {'expression': expression, 'returnByValue': True}}))
        while True:
            result = json.loads(await ws.recv())
            if result.get('id') == 1:
                print(result.get('result', {}).get('result', {}).get('value', result))
                break


if __name__ == '__main__':
    asyncio.run(main())

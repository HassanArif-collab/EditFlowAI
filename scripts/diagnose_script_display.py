"""Read all local CEP surfaces and compare rendered dialogue with current plan state."""
import asyncio
import base64
import json
from pathlib import Path
import urllib.request
import websockets

ROOT = Path(__file__).resolve().parent.parent


async def main():
    tabs = json.load(urllib.request.urlopen('http://127.0.0.1:8088/json', timeout=5))
    output = []
    for index, tab in enumerate(tabs):
        result = {'title': tab.get('title'), 'url': tab.get('url')}
        if not tab.get('webSocketDebuggerUrl'):
            output.append(result)
            continue
        async with websockets.connect(tab['webSocketDebuggerUrl'], max_size=16*1024*1024) as ws:
            await ws.send(json.dumps({'id': 1, 'method': 'Runtime.evaluate', 'params': {
                'returnByValue': True, 'expression': """JSON.stringify({
                state:window.__storyCutState ? ((s)=>({mode:s.mode,selected:s.selectedScriptPath,
                custom:s.customMode,plan:s.plan?.title,revision:s.plan?.script_revision,
                cuts:s.plan?.cuts?.map(c=>({speaker:c.speaker,quote:c.quote,in:c.source_in,out:c.source_out})),
                reference:s.scriptReference?.full_path,referenceHeading:s.scriptReference?.content?.split('\\n')[0]}))(window.__storyCutState):null,
                renderedQuotes:[...document.querySelectorAll('.sc-col-quote')].map(e=>e.innerText),
                scriptSelect:document.querySelector('#sc-script-select')?.value,
                referencesVisible:!!document.querySelector('#sc-reference-select'),
                body:document.body.innerText.slice(0,1500)})"""}}))
            while True:
                response = json.loads(await ws.recv())
                if response.get('id') == 1:
                    result['display'] = json.loads(response['result']['result']['value'])
                    break
            if 'cep-loader' in tab.get('url', ''):
                await ws.send(json.dumps({'id': 2, 'method': 'Page.captureScreenshot', 'params': {'format': 'png'}}))
                while True:
                    response = json.loads(await ws.recv())
                    if response.get('id') == 2:
                        if response.get('result', {}).get('data'):
                            path = ROOT / f'data/output/script-display-{index}.png'
                            path.write_bytes(base64.b64decode(response['result']['data']))
                            result['screenshot'] = str(path)
                        break
        output.append(result)
    (ROOT / 'data/output/script-display-diagnosis.json').write_text(json.dumps(output, indent=2), encoding='utf-8')
    print(json.dumps(output))


if __name__ == '__main__':
    asyncio.run(main())

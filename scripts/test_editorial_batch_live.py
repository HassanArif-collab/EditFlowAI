"""One real MCP batch on an isolated QA sequence; restore the user's sequence."""
import json
import sys
import urllib.request
import time
import asyncio
import websockets
from pathlib import Path
ROOT=Path(__file__).resolve().parent.parent
sys.path.insert(0,str(ROOT))

async def inspect_native(draft_id, original_id):
    tabs=json.load(urllib.request.urlopen('http://127.0.0.1:8088/json'))
    tab=next(t for t in tabs if 'cep-loader' in t.get('url',''))
    code='''(function(){try{app.project.openSequence(DRAFT);var s=app.project.activeSequence;
var c=s.videoTracks[0].clips[0],links=c.getLinkedItems(),a=[];
for(var i=0;i<links.numItems;i++){if(links[i].mediaType==="Audio"){a.push(links[i].parentTrackIndex);}}
var card=s.videoTracks[1].clips[0],position=null;
for(var j=0;j<card.components.numItems;j++){if(card.components[j].displayName==="Motion"){position=card.components[j].properties[0].getValue();}}
return JSON.stringify({linked_audio_tracks:a,camera_in:c.inPoint.seconds,camera_out:c.outPoint.seconds,card_position:position});
}finally{app.project.openSequence(ORIGINAL);}})()'''.replace('DRAFT',json.dumps(draft_id)).replace('ORIGINAL',json.dumps(original_id))
    async with websockets.connect(tab['webSocketDebuggerUrl']) as ws:
        await ws.send(json.dumps({'id':1,'method':'Runtime.evaluate','params':{'expression':'new Promise(resolve=>new CSInterface().evalScript('+json.dumps(code)+',resolve))','awaitPromise':True,'returnByValue':True}}))
        while True:
            message=json.loads(await ws.recv())
            if message.get('id')==1:
                return json.loads(message['result']['result']['value'])

def rpc(command,payload):
    request=urllib.request.Request('http://127.0.0.1:8765/api/premiere/rpc',data=json.dumps({'command':command,'payload':payload,'queue_if_offline':False,'timeout':60}).encode(),headers={'Content-Type':'application/json'})
    return json.load(urllib.request.urlopen(request,timeout=70))

def main():
    before=rpc('getSequenceState',{})['result']
    project=rpc('getProjectDirectory',{})['result']
    source=next(c['mediaPath'] for t in before['videoTracks'] for c in t['clips'] if c.get('mediaPath'))
    voice=Path('D:/MARKETING/Rahima Aziz Foundation/2026-10-21 Video Of Parking Lot/Voice/14/VO_01_Hook_TaxDeductible.wav')
    card=Path('D:/MARKETING/Rahima Aziz Foundation/2026-10-21 Video Of Parking Lot/Visuals/14/Motion_Graphics/01_Tax_Deductible_Shield_Badge.mov')
    if not voice.is_file() or not card.is_file():raise RuntimeError('Expected existing QA assets are missing')
    ops=[{'action':'create_sequence','name':'_EditFlow QA - linked audio and safe cards','width':1080,'height':1920,'fps':30,'preset_from_clip_path':source},
         {'action':'add','path':source,'time':0,'in_point':3,'out_point':5,'video_track_index':0,'audio_track_index':0,'scale':108},
         {'action':'add','path':str(voice),'time':0,'in_point':0,'out_point':1,'video_track_index':-1,'audio_track_index':1},
         {'action':'add','path':str(card),'time':0,'in_point':0,'out_point':2,'video_track_index':1,'audio_track_index':-1}]
    report={}
    try:
        start=time.perf_counter()
        report['execution']=rpc('processEDL',{'ops':ops,'expected_project_path':project['projectPath']})
        report['seconds']=round(time.perf_counter()-start,2)
        report['state']=rpc('getSequenceState',{})['result']
    finally:
        rpc('openSequence',{'id':before['id']})
    after=rpc('getSequenceState',{})['result']
    report['original_unchanged']=before==after
    report['native']=asyncio.run(inspect_native(report['state']['id'],before['id']))
    assert report['native']['linked_audio_tracks']==[0], 'Camera audio is not linked on A1'
    assert abs(report['native']['camera_in']-3)<0.04 and abs(report['native']['camera_out']-5)<0.04
    (ROOT/'data/output/editorial-batch-live.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
    state=report['state']
    print(json.dumps({'success':report['execution']['success'],'error':report['execution'].get('error') or report['execution'].get('result',{}).get('error'),
        'seconds':report['seconds'],'video_clip_counts':[len(t['clips']) for t in state['videoTracks']],
        'audio_clip_counts':[len(t['clips']) for t in state['audioTracks']],'original_unchanged':report['original_unchanged'],'native':report['native']}))

if __name__=='__main__':main()

"""Repair verified Script 52 links and generate the two explicitly approved VO clips."""
import hashlib,json,sys,concurrent.futures
from pathlib import Path
ROOT=Path(__file__).resolve().parent.parent
sys.path.insert(0,str(ROOT))
from backend.services.script_assembly_service import ScriptAssemblyService
from backend.services.media_framing import source_facts
from backend.mcp_server import execute_tool,DEFAULT_CARTESIA_SPEAKER_ID,DEFAULT_CARTESIA_DICT_ID

PROJECT=Path('D:/MARKETING/Jamia Masjid Chicago/2026-10-30 Video for 501(c)(3)')
SCRIPT=PROJECT/'Scripts/Script_52_MIX_27_The_Double_Impact_501c3_30s.md'

def main():
    content=SCRIPT.read_text(encoding='utf-8')
    beats=ScriptAssemblyService().parse_markdown_script(content)
    output=PROJECT/'Voice/Generated'
    tasks=[]
    for index in (1,2):
        beat=beats[index]
        quote=beat.quote.strip(' .…—')
        path=output/f'Script52_VO_{index:02d}.wav'
        metadata=path.with_suffix('.json')
        signature=hashlib.sha256((quote+DEFAULT_CARTESIA_SPEAKER_ID).encode()).hexdigest()
        tasks.append((index,quote,path,metadata,signature))
    def generate(task):
        index,quote,path,metadata,signature=task
        if path.is_file() and metadata.is_file() and json.loads(metadata.read_text()).get('signature')==signature:
            return index,str(path)
        result=execute_tool('editflow_generate_voiceover',{'text':quote,'project_folder':str(PROJECT),'speaker':DEFAULT_CARTESIA_SPEAKER_ID,
            'dict_id':DEFAULT_CARTESIA_DICT_ID,'speed':1.2,'volume':1.5,'emotion':'content','output_path':str(path)})
        if not result.get('success'):raise RuntimeError(result.get('error') or str(result))
        metadata.write_text(json.dumps({'signature':signature,'text':quote,'voice':DEFAULT_CARTESIA_SPEAKER_ID},indent=2))
        return index,result['file_path']
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
        voices=dict(executor.map(generate,tasks))
    # This transcript explicitly verifies the requested quote at 17.52–19.76.
    evidence=Path('D:/MARKETING/Jamia Masjid Chicago/AI Workflow/Script Gen/Phase4_Concrete_Earth_Retention/Interviews_Talking_Heads/2026-9-23 myairbridge Talking Content/Finals_Transcriptions/2026-07-02/Abdullah - 4. Abdullah With Captions 9x16 v4.json')
    data=json.loads(evidence.read_text(encoding='utf-8'))
    assert any(abs(s['start']-17.52)<.03 and 'Every dollar you give goes straight into the ground' in s['text'] for s in data['segments'])
    cuts=[]
    for index,beat in enumerate(beats):
        source=voices.get(index) or (data['source_file'] if index==0 else beat.source_ref)
        if not Path(source).is_file():raise RuntimeError(f'Unresolved source: {source}')
        end=source_facts(source)['duration'] if index in voices else beat.source_out
        cuts.append({'kind':'generated_narration' if index in voices else 'recorded_dialogue','source_file':source,
            'source_in':0 if index in voices else beat.source_in,'source_out':end,'quote':beat.quote,'speaker':beat.speaker.strip('*')})
    package={'schema_version':1,'project_folder':str(PROJECT),'brand':'Jamia Masjid Chicago','title':'The Double Impact — linked sources',
        'script_revision':hashlib.sha256(content.encode()).hexdigest(),'variants':[{'id':'primary','label':'Full spoken ranges','cuts':cuts}]}
    sidecar=SCRIPT.with_suffix('.editflow.json')
    if sidecar.exists():raise RuntimeError('An execution package already exists; it was not overwritten.')
    sidecar.write_text(json.dumps(package,indent=2,ensure_ascii=False),encoding='utf-8')
    print(json.dumps({'sidecar':str(sidecar),'voice_clips':voices,'duration':sum(c['source_out']-c['source_in'] for c in cuts)}))

if __name__=='__main__':main()

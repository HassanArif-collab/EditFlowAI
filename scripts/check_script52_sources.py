"""Inspect the failing script's existing media and narration without paid generation."""
import asyncio,json,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parent.parent
sys.path.insert(0,str(ROOT))

async def main():
    from backend.services.media_resolver import media_resolver
    from backend.services.media_framing import source_facts
    media_resolver.index_directory('D:/MARKETING/Jamia Masjid Chicago',force=False)
    for item in media_resolver._media_by_path.values():
        if 'abdullah' in item.name.lower() and '4' in item.name and item.file_type=='video':
            print(json.dumps({'name':item.name,'path':item.path,'exists':Path(item.path).is_file()}))
    source=Path('D:/MARKETING/Jamia Masjid Chicago/2026-10-30 Video for 501(c)(3)/VoiceOver/V1.wav')
    print('Voice:',json.dumps(source_facts(str(source))))
    from backend.services.whisper_service import whisper_service
    transcript=await whisper_service.transcribe_fingerprinted(str(source),word_timestamps=True)
    data=transcript.model_dump(mode='json')
    (ROOT/'data/output/script52-existing-voice-transcript.json').write_text(json.dumps(data,indent=2),encoding='utf-8')
    print('Existing voice text:',data.get('text'))

if __name__=='__main__':asyncio.run(main())

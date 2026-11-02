"""Link the two user-supplied existing recordings; never generate or trim audio."""
import argparse
from datetime import datetime
import hashlib
import json
from pathlib import Path
import re
import shutil
import sys
import urllib.request
import wave

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from backend.services.script_sources import current_script, script_locations, _write
from backend.services.script_assembly_service import ScriptAssemblyService

PROJECT = Path('D:/MARKETING/Jamia Masjid Chicago/2026-10-30 Video for 501(c)(3)')
SCRIPT = PROJECT / 'Scripts/Script_52_MIX_27_The_Double_Impact_501c3_30s.md'


def clock(seconds):
    minutes, seconds = divmod(seconds, 60)
    return f'{int(minutes)}:{seconds:06.3f}'


def compile_text(text):
    body = {'script_content': text, 'project_folder': str(PROJECT),
            'brand': 'Jamia Masjid Chicago', 'auto_broll': False}
    request = urllib.request.Request('http://127.0.0.1:8765/api/script-assembly/compile',
        data=json.dumps(body).encode(), headers={'Content-Type': 'application/json'})
    return json.load(urllib.request.urlopen(request, timeout=60))


def main(apply=False):
    canonical = current_script(SCRIPT)
    original = canonical.read_text(encoding='utf-8')
    voices = []
    for number in (1, 2):
        path = PROJECT / f'Voice/Generated/Script52_VO_{number:02d}.wav'
        metadata = json.loads(path.with_suffix('.json').read_text(encoding='utf-8'))
        assert metadata['signature'] == hashlib.sha256((metadata['text'] + metadata['voice']).encode()).hexdigest()
        with wave.open(str(path)) as wav:
            duration = wav.getnframes() / wav.getframerate()
            assert wav.getnframes() > 0
        voices.append({'path': path, 'text': metadata['text'], 'duration': duration})
    beats = ScriptAssemblyService().parse_markdown_script(original)
    if len(beats) != 5 or 'Script_52_Voiceover.wav' not in beats[1].source_ref:
        raise RuntimeError('Script structure has changed or links are already applied. Inspect before replacing anything.')
    duration = sum(b.source_out - b.source_in for i, b in enumerate(beats) if i != 1) + sum(v['duration'] for v in voices)
    delta = sum(v['duration'] for v in voices) - (beats[1].source_out - beats[1].source_in)
    text = original.replace('(26s)', f'({duration:.2f}s)').replace('**Length:** 26 seconds', f'**Length:** {duration:.2f} seconds')
    text = text.replace('(26s vertical 9:16 & 1:1)', f'({duration:.2f}s vertical 9:16 & 1:1)')
    text = re.sub(r'a punchy 4-second AI Voiceover.*?free 2x employer match,',
                  'the two supplied AI voiceover recordings explain employer matching and tax deductibility,', text)
    text = text.replace('The 4s 501(c)(3) Tax Write-Off & 2x Company Match Bridge', 'The Supplied 501(c)(3) Tax Write-Off & 2x Company Match Recordings')
    text = text.replace('`Voiceovers\\Script_52_Voiceover.wav` (AI Voiceover, Cartesia `sonic-3.6`)',
        ' + '.join(f'`{v["path"]}` (existing AI Voiceover)' for v in voices))
    old_quote = beats[1].quote
    recorded_quote = ' '.join(v['text'] for v in voices)
    if old_quote not in text:
        raise RuntimeError('Current narration text was not found.')
    text = text.replace(old_quote, '—' + recorded_quote + '—')
    start = beats[1].timeline_in
    end = start + sum(v['duration'] for v in voices)
    narration = f'''**{clock(start)}–{clock(end)} | ACT 2: EMPLOYER MATCH & TAX DEDUCTION — AI VOICEOVER (HAFIZ ABDULLAH)**
- **Visual & AI/AE Direction:** Use the existing concrete/construction B-roll and lower-third tax/match cards throughout both supplied recordings. Retain each recording's native speed.
- **Visual Cue (for Track V2 B-Roll):** cement mixer chute pouring concrete foundation
'''
    cursor = start
    for number, voice in enumerate(voices, 1):
        narration += f'''- **Audio — AI Voiceover {number} (`{voice['path']}` `{clock(0)}–{clock(voice['duration'])}`):**
  > "{voice['text']}"
- **Source:** `{voice['path']}` / AI Voiceover (Hafiz Abdullah) / `{clock(0)}–{clock(voice['duration'])}`
- **Timeline:** {clock(cursor)}–{clock(cursor + voice['duration'])}
'''
        cursor += voice['duration']
    narration += '- **Caption:** Match the words in each linked recording.\n\n'
    text, count = re.subn(r'\*\*0:05\.5–0:09\.7 \| ACT 2:.*?(?=---\s*\n\s*\*\*0:09\.7)', lambda _: narration, text, flags=re.S)
    assert count == 1
    for beat in beats[2:]:
        # Replace act timeline headers without touching source timecodes.
        pattern = r'\*\*[^\n|]+\| ACT ' + str(beat.index) + r':'
        value = f'**{clock(beat.timeline_in + delta)}–{clock(beat.timeline_out + delta)} | ACT {beat.index}:'
        text, count = re.subn(pattern, lambda _: value, text)
        assert count == 1
    text = text.replace('at 0:21.5', f'at {clock(21.5 + delta)}')
    cuts = []
    for index, beat in enumerate(beats):
        if index == 1:
            for voice in voices:
                cuts.append({'kind': 'generated_narration', 'source_file': str(voice['path']),
                    'source_in': 0, 'source_out': voice['duration'], 'speaker': 'AI Voiceover (Hafiz Abdullah)',
                    'quote': voice['text'], 'visual_cue': beat.visual_cue})
        else:
            cuts.append({'kind': 'recorded_dialogue', 'source_file': beat.source_ref,
                'source_in': beat.source_in, 'source_out': beat.source_out,
                'speaker': beat.speaker.strip('*'), 'quote': beat.quote, 'visual_cue': beat.visual_cue})
    table = f'### CUT LIST (total {duration:.2f}s):\n\n'
    table += '| # | Person | Source file | Cut IN → OUT | Yields | Timeline | Quote / Dialogue | Role / Notes |\n'
    table += '|---|---|---|---|---|---|---|---|\n'
    cursor = 0
    for number, cut in enumerate(cuts, 1):
        length = cut['source_out'] - cut['source_in']
        table += f'| {number} | **{cut["speaker"]}** | `{cut["source_file"]}` | `{clock(cut["source_in"])} → {clock(cut["source_out"])}` | {length:.3f}s | {clock(cursor)}–{clock(cursor+length)} | "{cut["quote"]}" | {cut["kind"]} |\n'
        cursor += length
    text, count = re.subn(r'### CUT LIST[^\n]*\n.*?(?=\n---|\Z)', lambda _: table, text, count=1, flags=re.S)
    assert count == 1
    text = text.split('### Existing generated voice recordings')[0].rstrip()
    text += '\n\n### Linked narration recordings\n\nThe supplied recordings are used in full on Track A2; the narration text and cut timing above match these existing files.\n\n'
    for voice in voices:
        text += f'- [{voice["path"].name}](../Voice/Generated/{voice["path"].name}) — {voice["duration"]:.3f}s\n'
    result = compile_text(text)
    if not result.get('success') or not result['plan']['validation']['valid']:
        raise RuntimeError(json.dumps(result.get('plan', {}).get('validation', result)))
    plan = result['plan']
    assert len(plan['cuts']) == 6
    # Resolve camera paths with the existing compiler; use exact WAV durations
    # rather than frame-rounded preview durations in the execution package.
    for cut, resolved in zip(cuts, plan['cuts']):
        assert Path(resolved['source_file']).is_file()
        cut['source_file'] = resolved['source_file']
        if cut['kind'] == 'generated_narration':
            assert resolved['audio_track'] == 1 and resolved['video_track'] == -1
    package = {'schema_version': 1, 'project_folder': str(PROJECT), 'brand': 'Jamia Masjid Chicago',
        'title': f'The Double Impact — supplied narration ({duration:.2f}s)',
        'script_revision': hashlib.sha256(text.encode()).hexdigest(),
        'variants': [{'id': 'primary', 'label': 'Supplied recordings — full duration', 'cuts': cuts}]}
    from backend.services.agent_script_package import AgentScriptPackage
    AgentScriptPackage.model_validate(package)
    output = ROOT / 'data/output/script52-supplied-voiceovers'
    output.mkdir(parents=True, exist_ok=True)
    (output / 'preview.md').write_text(text, encoding='utf-8')
    (output / 'preview.editflow.json').write_text(json.dumps(package, indent=2), encoding='utf-8')
    summary = {'applied': apply, 'duration': duration, 'cuts': len(cuts),
        'voices': [{'path': str(v['path']), 'duration': v['duration'], 'text': v['text']} for v in voices],
        'validation': plan['validation']}
    if apply:
        if canonical.read_text(encoding='utf-8') != original:
            raise RuntimeError('Script changed during preparation; no changes applied.')
        backup = output / ('backup-' + datetime.now().strftime('%Y%m%d-%H%M%S-%f'))
        backup.mkdir()
        for index, path in enumerate(script_locations(canonical)):
            if path.is_file():
                shutil.copy2(path, backup / f'{index}-{path.name}')
        sidecar = canonical.with_suffix('.editflow.json')
        if sidecar.exists():
            shutil.copy2(sidecar, backup / sidecar.name)
        _write(canonical, text)
        current_script(canonical)
        _write(sidecar, json.dumps(package, indent=2, ensure_ascii=False))
        summary['backup'] = str(backup)
    (output / 'result.json').write_text(json.dumps(summary, indent=2), encoding='utf-8')
    print(json.dumps(summary))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true')
    main(parser.parse_args().apply)

"""Read-only check of real Script 14 overlays through the batch editorial policy."""
import json
import sys
import time
from pathlib import Path

ROOT=Path(__file__).resolve().parent.parent
sys.path.insert(0,str(ROOT))
from backend.services.edl_policy import prepare_batch
from backend.services.media_framing import source_facts
from backend.config import get_settings
from backend.utils.subprocess_utils import run_silent
from PIL import Image


def main():
    folder=Path('D:/MARKETING/Rahima Aziz Foundation/2026-10-21 Video Of Parking Lot/Visuals/14/Motion_Graphics')
    rows=[]
    started=time.perf_counter()
    for path in sorted(folder.glob('*.mov')):
        facts=source_facts(str(path))
        op=prepare_batch({'ops':[{'action':'add','mediaPath':str(path),'video_track_index':1,'audio_track_index':-1}]})['ops'][0]
        rows.append({'file':path.name,'has_alpha':facts['has_alpha'],'safe_zone':op.get('safe_zone'),'scale':op.get('fit_scale'),'position':op.get('position')})
        if not rows[:-1]:
            sample=run_silent([get_settings().FFMPEG_PATH,'-v','error','-ss','0.8','-i',str(path),'-frames:v','1','-vf','alphaextract,scale=270:480:in_range=full:out_range=full,format=gray','-f','rawvideo','pipe:1'],capture_output=True,timeout=20)
            im=Image.frombytes('L',(270,480),sample.stdout)
            print(json.dumps({'alpha_extrema':im.getextrema(),'common_alpha':sorted(enumerate(im.histogram()),key=lambda x:x[1],reverse=True)[:5],'bounds':im.point(lambda a:255 if a>8 else 0).getbbox()}))
    report={'graphics':rows,'seconds':round(time.perf_counter()-started,2)}
    (ROOT/'data/output/script14-editorial-check.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
    print(json.dumps(report))


if __name__=='__main__':main()

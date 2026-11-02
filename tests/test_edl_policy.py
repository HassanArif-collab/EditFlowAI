import pytest
from backend.services import edl_policy as policy


def test_graphic_animated_bounds_fit_lower_safe_zone():
    bounds=[120,100,960,600]
    t=policy.graphic_transform(bounds,1080,1920,1080,1920)
    scale=t['fit_scale']/100
    y=t['position'][1]*1920
    top=y+(bounds[1]-960)*scale
    bottom=y+(bounds[3]-960)*scale
    assert top >= 1350-1e-6 and bottom <= 1720+1e-6


def test_legacy_camera_punch_keeps_audio_linked_and_uses_fitted_scale(tmp_path,monkeypatch):
    source=tmp_path/'camera.mp4';source.write_bytes(b'test')
    monkeypatch.setattr(policy,'source_facts',lambda p:{'width':2160,'height':3840,'has_alpha':False})
    monkeypatch.setattr(policy,'framing_for_file',lambda p,w,h,m,z:{'fit_scale':50,'zoom':z,'fit_mode':m})
    original={'ops':[{'action':'add','path':str(source),'time':2.5,'in_point':3,'out_point':5,'scale':108,'video_track_index':0,'audio_track_index':-1,'audio_lead_frames':15}]}
    op=policy.prepare_batch(original)['ops'][0]
    assert op['audio_track_index']==0 and op['preserve_linked_audio'] and op['audio_lead_frames']==0
    assert op['fit_scale']==50 and op['zoom']==pytest.approx(1.08)
    assert (op['startTime'],op['inPoint'],op['outPoint']) == (2.5,3,5)
    assert original['ops'][0]['audio_track_index']==-1


def test_transparent_overlay_gets_safe_transform_and_no_audio(tmp_path,monkeypatch):
    source=tmp_path/'card.mov';source.write_bytes(b'test')
    monkeypatch.setattr(policy,'source_facts',lambda p:{'width':1080,'height':1920,'has_alpha':True,'duration':3})
    monkeypatch.setattr(policy,'_alpha_bounds',lambda *a:[0,100,1080,600])
    op=policy.prepare_batch({'ops':[{'action':'add','path':str(source),'video_track_index':1}]})['ops'][0]
    assert op['safe_zone']==[1350,1720] and op['audio_track_index']==-1

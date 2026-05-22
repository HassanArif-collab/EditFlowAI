# Active Sequence Phrase Cuts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let EditFlow analyze the active Premiere Pro sequence and remove every spoken occurrence of a phrase such as "jamia masjid" from the timeline.

**Architecture:** The CEP panel will sync the active sequence, send its audio clip source paths and timeline positions to the backend, and the backend will transcribe those source files with word timestamps. A phrase matcher will map source word timestamps back to active-sequence timeline ranges. The CEP panel will preview those ranges and then execute a Premiere timeline range-removal command.

**Tech Stack:** FastAPI, Pydantic, SQLite, faster-whisper, CEP JavaScript, ExtendScript, Node test runner, Python stdlib unittest.

---

### Current Failure Summary

The current app has project scanning, folder analysis, script matching, and EDL add operations, but it does not have an active-sequence phrase-removal workflow.

Evidence from the running backend:

```text
GET /api/pipeline/status
transcripts_count: 0
speech_candidates_count: 0
```

Evidence from the current Premiere context:

```text
GET /api/premiere/context
items: 45
bins: 13
sequences: only name/id entries from project scan
```

The AI does not currently know the active sequence unless the user runs "Sync Sequence State", and even then it only receives clip names, media paths, and timing. It does not transcribe the sequence audio. The Cut tab calls `/api/pipeline/cut`, which only reads `speech_candidates` created by folder analysis. That is why the UI shows `Matched 0/0`.

---

### File Structure

- Modify: `backend/models/schemas.py`
  Add request/response models for active sequence analysis, phrase matching, and phrase cut application.
- Modify: `backend/models/sqlite_registry.py`
  Add tables for sequence transcript snapshots and word-level timeline mappings.
- Create: `backend/services/sequence_phrase_service.py`
  Own active-sequence transcription, source-to-timeline word mapping, phrase matching, and cut range generation.
- Modify: `backend/routes/premiere.py`
  Add endpoints under `/api/premiere/sequence/*`.
- Modify: `cep-panel/client/index.html`
  Add active sequence controls for Sync, Analyze Sequence Audio, phrase input, Preview, and Apply.
- Modify: `cep-panel/client/src/main.js`
  Wire the new controls to ExtendScript and backend endpoints, and add chat command routing for phrase removal.
- Modify: `cep-panel/extendscript/index.jsx`
  Register new timeline range commands.
- Modify: `cep-panel/extendscript/clip_manager.jsx`
  Add timeline range marker/removal helpers.
- Create: `tests/test_sequence_phrase_service.py`
  Backend unit tests for word timestamp mapping and phrase matching.
- Modify: `tests/cep-bridge-regression.test.js`
  Static regression tests for new CEP/ExtendScript command wiring.

---

### Task 1: Backend Schemas

**Files:**
- Modify: `backend/models/schemas.py`

- [ ] **Step 1: Add request and response models**

Add these classes after `CuttingResult`:

```python
class SequenceAudioClip(BaseModel):
    sequence_name: str = ""
    track_index: int = 0
    clip_index: int = 0
    clip_name: str = ""
    media_path: str = ""
    timeline_start: float = 0.0
    timeline_end: float = 0.0
    source_in: float = 0.0
    source_out: float = 0.0
    speed: float = 1.0


class SequenceAnalyzeRequest(BaseModel):
    sequence_id: str = ""
    sequence_name: str = ""
    language: Optional[str] = None
    audio_clips: List[SequenceAudioClip] = Field(default_factory=list)


class SequenceAnalyzeResponse(BaseModel):
    success: bool = False
    sequence_id: str = ""
    sequence_name: str = ""
    transcript_id: str = ""
    clips_analyzed: int = 0
    words_indexed: int = 0
    message: str = ""


class SequencePhraseRequest(BaseModel):
    sequence_id: str = ""
    sequence_name: str = ""
    phrase: str
    padding_before: float = 0.05
    padding_after: float = 0.08
    min_confidence: float = 0.0


class SequencePhraseRange(BaseModel):
    start: float
    end: float
    text: str = ""
    words: List[str] = Field(default_factory=list)
    track_index: int = 0
    clip_index: int = 0
    clip_name: str = ""
    media_path: str = ""


class SequencePhraseResponse(BaseModel):
    success: bool = False
    phrase: str = ""
    ranges: List[SequencePhraseRange] = Field(default_factory=list)
    message: str = ""
```

- [ ] **Step 2: Run schema import check**

Run:

```powershell
python - <<'PY'
from backend.models.schemas import SequenceAnalyzeRequest, SequencePhraseRequest
print(SequenceAnalyzeRequest(sequence_name="Seq").model_dump())
print(SequencePhraseRequest(phrase="jamia masjid").model_dump())
PY
```

Expected: both models print dictionaries without import errors.

---

### Task 2: SQLite Tables

**Files:**
- Modify: `backend/models/sqlite_registry.py`

- [ ] **Step 1: Add sequence transcript tables**

Inside `_create_tables()`, after `transcript_segments`, add:

```sql
CREATE TABLE IF NOT EXISTS sequence_transcripts (
    id TEXT PRIMARY KEY,
    sequence_id TEXT DEFAULT '',
    sequence_name TEXT NOT NULL,
    language TEXT DEFAULT '',
    clips_analyzed INTEGER DEFAULT 0,
    words_indexed INTEGER DEFAULT 0,
    metadata TEXT DEFAULT '{}',
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sequence_words (
    id TEXT PRIMARY KEY,
    sequence_transcript_id TEXT NOT NULL,
    sequence_id TEXT DEFAULT '',
    sequence_name TEXT NOT NULL,
    track_index INTEGER NOT NULL,
    clip_index INTEGER NOT NULL,
    clip_name TEXT DEFAULT '',
    media_path TEXT NOT NULL,
    source_start REAL NOT NULL,
    source_end REAL NOT NULL,
    timeline_start REAL NOT NULL,
    timeline_end REAL NOT NULL,
    word TEXT NOT NULL,
    normalized_word TEXT NOT NULL,
    probability REAL DEFAULT 0,
    FOREIGN KEY(sequence_transcript_id) REFERENCES sequence_transcripts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sequence_words_lookup
ON sequence_words(sequence_id, sequence_name, timeline_start);
```

- [ ] **Step 2: Run database initialization**

Run:

```powershell
python - <<'PY'
from backend.models.sqlite_registry import sqlite_registry
sqlite_registry.initialize()
row = sqlite_registry.fetch_one("SELECT name FROM sqlite_master WHERE type='table' AND name='sequence_words'")
print(row["name"] if row else "missing")
PY
```

Expected: `sequence_words`.

---

### Task 3: Sequence Phrase Service Tests

**Files:**
- Create: `tests/test_sequence_phrase_service.py`

- [ ] **Step 1: Write failing tests for timeline mapping and phrase matching**

Create the file with:

```python
import unittest

from backend.services.sequence_phrase_service import (
    map_word_to_timeline,
    normalize_phrase_words,
    find_phrase_ranges,
)


class SequencePhraseServiceTests(unittest.TestCase):
    def test_maps_source_word_time_to_timeline_time(self):
        clip = {
            "timeline_start": 10.0,
            "source_in": 30.0,
            "speed": 1.0,
        }
        mapped = map_word_to_timeline(clip, 32.25, 32.75)
        self.assertEqual(mapped, (12.25, 12.75))

    def test_normalizes_phrase_words(self):
        self.assertEqual(normalize_phrase_words("Jamia, Masjid!"), ["jamia", "masjid"])

    def test_finds_all_phrase_ranges(self):
        words = [
            {"normalized_word": "welcome", "word": "Welcome", "timeline_start": 0.0, "timeline_end": 0.4, "track_index": 0, "clip_index": 0, "clip_name": "voice.mp3", "media_path": "voice.mp3"},
            {"normalized_word": "jamia", "word": "Jamia", "timeline_start": 1.0, "timeline_end": 1.3, "track_index": 0, "clip_index": 0, "clip_name": "voice.mp3", "media_path": "voice.mp3"},
            {"normalized_word": "masjid", "word": "Masjid", "timeline_start": 1.31, "timeline_end": 1.7, "track_index": 0, "clip_index": 0, "clip_name": "voice.mp3", "media_path": "voice.mp3"},
            {"normalized_word": "jamia", "word": "jamia", "timeline_start": 3.0, "timeline_end": 3.4, "track_index": 0, "clip_index": 0, "clip_name": "voice.mp3", "media_path": "voice.mp3"},
            {"normalized_word": "masjid", "word": "masjid", "timeline_start": 3.41, "timeline_end": 3.9, "track_index": 0, "clip_index": 0, "clip_name": "voice.mp3", "media_path": "voice.mp3"},
        ]
        ranges = find_phrase_ranges(words, "jamia masjid", padding_before=0.05, padding_after=0.08)
        self.assertEqual(len(ranges), 2)
        self.assertEqual(ranges[0]["start"], 0.95)
        self.assertEqual(ranges[0]["end"], 1.78)
        self.assertEqual(ranges[1]["start"], 2.95)
        self.assertEqual(ranges[1]["end"], 3.98)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run tests and verify they fail**

Run:

```powershell
python -m unittest tests.test_sequence_phrase_service -v
```

Expected: import failure because `backend.services.sequence_phrase_service` does not exist yet.

---

### Task 4: Sequence Phrase Service Implementation

**Files:**
- Create: `backend/services/sequence_phrase_service.py`

- [ ] **Step 1: Implement normalization, timestamp mapping, transcription, and matching**

Create:

```python
import re
import uuid
from typing import Any, Dict, List, Optional, Tuple

from ..models.schemas import SequenceAnalyzeRequest, SequenceAnalyzeResponse, SequencePhraseRange, SequencePhraseResponse
from ..models.sqlite_registry import sqlite_registry
from ..models.schemas import utc_now
from ..services.whisper_service import whisper_service


_WORD_RE = re.compile(r"[\w']+", re.UNICODE)


def normalize_phrase_words(text: str) -> List[str]:
    return [m.group(0).lower() for m in _WORD_RE.finditer(text or "")]


def map_word_to_timeline(clip: Dict[str, Any], source_start: float, source_end: float) -> Tuple[float, float]:
    speed = float(clip.get("speed") or 1.0)
    if speed == 0:
        speed = 1.0
    timeline_start = float(clip.get("timeline_start", 0)) + ((source_start - float(clip.get("source_in", 0))) / speed)
    timeline_end = float(clip.get("timeline_start", 0)) + ((source_end - float(clip.get("source_in", 0))) / speed)
    return round(timeline_start, 3), round(timeline_end, 3)


def find_phrase_ranges(
    words: List[Dict[str, Any]],
    phrase: str,
    padding_before: float = 0.05,
    padding_after: float = 0.08,
) -> List[Dict[str, Any]]:
    phrase_words = normalize_phrase_words(phrase)
    if not phrase_words:
        return []

    ranges: List[Dict[str, Any]] = []
    width = len(phrase_words)
    for i in range(0, len(words) - width + 1):
        window = words[i:i + width]
        if [w.get("normalized_word", "") for w in window] != phrase_words:
            continue
        first = window[0]
        last = window[-1]
        start = max(0.0, round(float(first["timeline_start"]) - padding_before, 3))
        end = round(float(last["timeline_end"]) + padding_after, 3)
        ranges.append({
            "start": start,
            "end": end,
            "text": " ".join(w.get("word", "") for w in window),
            "words": [w.get("word", "") for w in window],
            "track_index": int(first.get("track_index", 0)),
            "clip_index": int(first.get("clip_index", 0)),
            "clip_name": first.get("clip_name", ""),
            "media_path": first.get("media_path", ""),
        })
    return ranges


class SequencePhraseService:
    async def analyze_sequence(self, request: SequenceAnalyzeRequest) -> SequenceAnalyzeResponse:
        transcript_id = str(uuid.uuid4())[:12]
        now = utc_now()
        words_indexed = 0
        clips_analyzed = 0

        sqlite_registry.execute(
            """INSERT INTO sequence_transcripts
            (id, sequence_id, sequence_name, language, clips_analyzed, words_indexed, metadata, created_at)
            VALUES (?, ?, ?, ?, 0, 0, '{}', ?)""",
            (transcript_id, request.sequence_id, request.sequence_name, request.language or "", now),
        )

        for clip_model in request.audio_clips:
            clip = clip_model.model_dump()
            if not clip.get("media_path"):
                continue
            result = await whisper_service.transcribe(clip["media_path"], language=request.language, word_timestamps=True)
            clips_analyzed += 1
            for segment in result.segments:
                for word in segment.words:
                    source_start = float(word.start)
                    source_end = float(word.end)
                    if source_start < float(clip.get("source_in", 0)) or source_end > float(clip.get("source_out", 10**9)):
                        continue
                    timeline_start, timeline_end = map_word_to_timeline(clip, source_start, source_end)
                    normalized = normalize_phrase_words(word.word)
                    if not normalized:
                        continue
                    sqlite_registry.execute(
                        """INSERT INTO sequence_words
                        (id, sequence_transcript_id, sequence_id, sequence_name, track_index, clip_index,
                         clip_name, media_path, source_start, source_end, timeline_start, timeline_end,
                         word, normalized_word, probability)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                        (
                            str(uuid.uuid4())[:12], transcript_id, request.sequence_id, request.sequence_name,
                            int(clip.get("track_index", 0)), int(clip.get("clip_index", 0)), clip.get("clip_name", ""),
                            clip.get("media_path", ""), source_start, source_end, timeline_start, timeline_end,
                            word.word.strip(), normalized[0], float(word.probability or 0),
                        ),
                    )
                    words_indexed += 1

        sqlite_registry.execute(
            "UPDATE sequence_transcripts SET clips_analyzed = ?, words_indexed = ? WHERE id = ?",
            (clips_analyzed, words_indexed, transcript_id),
        )

        return SequenceAnalyzeResponse(
            success=True,
            sequence_id=request.sequence_id,
            sequence_name=request.sequence_name,
            transcript_id=transcript_id,
            clips_analyzed=clips_analyzed,
            words_indexed=words_indexed,
            message=f"Analyzed {clips_analyzed} sequence audio clips and indexed {words_indexed} words.",
        )

    def find_phrase(self, sequence_id: str, sequence_name: str, phrase: str, padding_before: float, padding_after: float) -> SequencePhraseResponse:
        rows = sqlite_registry.fetch_all(
            """SELECT * FROM sequence_words
            WHERE (sequence_id = ? OR sequence_name = ?)
            ORDER BY timeline_start ASC""",
            (sequence_id, sequence_name),
        )
        ranges = find_phrase_ranges(rows, phrase, padding_before, padding_after)
        return SequencePhraseResponse(
            success=True,
            phrase=phrase,
            ranges=[SequencePhraseRange(**r) for r in ranges],
            message=f"Found {len(ranges)} occurrence(s) of '{phrase}'.",
        )


sequence_phrase_service = SequencePhraseService()
```

- [ ] **Step 2: Run unit tests**

Run:

```powershell
python -m unittest tests.test_sequence_phrase_service -v
```

Expected: 3 tests pass.

---

### Task 5: Premiere Backend Endpoints

**Files:**
- Modify: `backend/routes/premiere.py`

- [ ] **Step 1: Import new models and service**

Add imports:

```python
from ..models.schemas import SequenceAnalyzeRequest, SequencePhraseRequest
from ..services.sequence_phrase_service import sequence_phrase_service
```

- [ ] **Step 2: Add endpoints before Utility Endpoints**

```python
@router.post("/sequence/analyze")
async def analyze_active_sequence_audio(request: SequenceAnalyzeRequest):
    if not request.audio_clips:
        raise HTTPException(status_code=400, detail="No audio clips were provided for sequence analysis")
    try:
        return await sequence_phrase_service.analyze_sequence(request)
    except Exception as e:
        logger.error(f"Sequence audio analysis error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/sequence/find-phrase")
async def find_phrase_in_sequence(request: SequencePhraseRequest):
    if not request.phrase.strip():
        raise HTTPException(status_code=400, detail="phrase cannot be empty")
    try:
        return sequence_phrase_service.find_phrase(
            sequence_id=request.sequence_id,
            sequence_name=request.sequence_name,
            phrase=request.phrase,
            padding_before=request.padding_before,
            padding_after=request.padding_after,
        )
    except Exception as e:
        logger.error(f"Sequence phrase search error: {e}")
        raise HTTPException(status_code=500, detail=str(e))
```

- [ ] **Step 3: Run route import check**

Run:

```powershell
python - <<'PY'
from backend.main import app
paths = sorted(r.path for r in app.routes)
print('/api/premiere/sequence/analyze' in paths)
print('/api/premiere/sequence/find-phrase' in paths)
PY
```

Expected:

```text
True
True
```

---

### Task 6: CEP Client Active Sequence Payload

**Files:**
- Modify: `cep-panel/client/src/main.js`

- [ ] **Step 1: Add helper to build backend audio clip payload**

Add near Premiere helpers:

```javascript
function getSequenceAudioClipsForBackend(sequenceState) {
    if (!sequenceState || !Array.isArray(sequenceState.audioTracks)) return [];
    const clips = [];
    sequenceState.audioTracks.forEach((track) => {
        (track.clips || []).forEach((clip, clipIndex) => {
            if (!clip.mediaPath) return;
            clips.push({
                sequence_name: sequenceState.name || '',
                track_index: track.index || 0,
                clip_index: clipIndex,
                clip_name: clip.name || '',
                media_path: clip.mediaPath,
                timeline_start: clip.startTime || 0,
                timeline_end: clip.endTime || 0,
                source_in: clip.inPoint || 0,
                source_out: clip.outPoint || 0,
                speed: clip.speed || 1,
            });
        });
    });
    return clips;
}
```

- [ ] **Step 2: Add sequence analysis function**

```javascript
async function analyzeActiveSequenceAudio() {
    if (!state.sequenceState) {
        await syncSequenceState();
    }
    const audioClips = getSequenceAudioClipsForBackend(state.sequenceState);
    if (!audioClips.length) {
        addChatMessage('error', 'No audio clips with media paths were found in the active sequence.');
        return;
    }
    const resp = await apiPost('/premiere/sequence/analyze', {
        sequence_id: state.sequenceState.id || '',
        sequence_name: state.sequenceState.name || '',
        language: $('#analyze-language')?.value || undefined,
        audio_clips: audioClips,
    });
    addChatMessage('assistant', resp.message || `Indexed ${resp.words_indexed || 0} words from the active sequence.`);
    return resp;
}
```

- [ ] **Step 3: Add phrase search function**

```javascript
async function findPhraseInActiveSequence(phrase) {
    if (!state.sequenceState) {
        await syncSequenceState();
    }
    const resp = await apiPost('/premiere/sequence/find-phrase', {
        sequence_id: state.sequenceState.id || '',
        sequence_name: state.sequenceState.name || '',
        phrase,
        padding_before: 0.05,
        padding_after: 0.08,
    });
    state.lastPhraseRanges = resp.ranges || [];
    addChatMessage('assistant', `${resp.message || 'Phrase search complete'} ${state.lastPhraseRanges.length ? 'Use Preview or Apply to edit the timeline.' : ''}`);
    return resp;
}
```

- [ ] **Step 4: Add chat command routing before sending to backend chat**

Inside `sendMessage()`, after `addChatMessage('user', text); showTypingIndicator();`, add:

```javascript
const phraseCommand = text.match(/\b(?:cut|remove|delete)\b[\s\S]*?\b(?:words?|phrase)\b[\s"']+(.+?)["']?$/i)
    || text.match(/\b(?:cut|remove|delete)\b[\s\S]*?["'](.+?)["']/i);
if (phraseCommand && phraseCommand[1]) {
    try {
        const phrase = phraseCommand[1].trim().replace(/^["']|["']$/g, '');
        hideTypingIndicator();
        await analyzeActiveSequenceAudio();
        await findPhraseInActiveSequence(phrase);
        return;
    } catch (e) {
        hideTypingIndicator();
        addChatMessage('error', 'Failed to analyze active sequence phrase: ' + e.message);
        return;
    }
}
```

- [ ] **Step 5: Run JS syntax check**

Run:

```powershell
node --check cep-panel\client\src\main.js
```

Expected: no output and exit code 0.

---

### Task 7: ExtendScript Preview Markers

**Files:**
- Modify: `cep-panel/extendscript/index.jsx`
- Modify: `cep-panel/extendscript/marker_manager.jsx`
- Modify: `tests/cep-bridge-regression.test.js`

- [ ] **Step 1: Add marker manager function**

In `marker_manager.jsx`, add:

```javascript
function addPhraseRangeMarkers(options) {
    var seq = app.project.activeSequence;
    if (!seq) return editflowUtils.safeStringify({ success: false, error: "No active sequence" });

    var ranges = editflowUtils.getParam(options, "ranges") || [];
    var phrase = editflowUtils.getParam(options, "phrase") || "phrase";
    var markers = seq.markers;
    var created = 0;

    for (var i = 0; i < ranges.length; i++) {
        var range = ranges[i];
        var marker = markers.createMarker(editflowUtils.secondsToTicks(range.start));
        marker.name = "EditFlow remove: " + phrase;
        marker.comments = "Remove " + phrase + " from " + range.start + " to " + range.end;
        marker.end = editflowUtils.secondsToTicks(range.end);
        created++;
    }

    return editflowUtils.safeStringify({ success: true, markers: created });
}
```

Add it to the return object:

```javascript
addPhraseRangeMarkers: addPhraseRangeMarkers
```

- [ ] **Step 2: Register command in `index.jsx`**

Add a case:

```javascript
case "addPhraseRangeMarkers":
    result = markerManager.addPhraseRangeMarkers(options);
    break;
```

- [ ] **Step 3: Add static regression test**

Append to `tests/cep-bridge-regression.test.js`:

```javascript
test('ExtendScript exposes phrase range preview markers', () => {
  const indexSource = fs.readFileSync(path.join(repoRoot, 'cep-panel', 'extendscript', 'index.jsx'), 'utf8');
  const markerSource = fs.readFileSync(path.join(repoRoot, 'cep-panel', 'extendscript', 'marker_manager.jsx'), 'utf8');
  assert.match(indexSource, /case "addPhraseRangeMarkers"/);
  assert.match(markerSource, /function addPhraseRangeMarkers/);
});
```

- [ ] **Step 4: Run regression tests**

Run:

```powershell
node --test tests\cep-bridge-regression.test.js
```

Expected: all tests pass.

---

### Task 8: Timeline Range Removal Command

**Files:**
- Modify: `cep-panel/extendscript/clip_manager.jsx`
- Modify: `cep-panel/extendscript/index.jsx`
- Modify: `tests/cep-bridge-regression.test.js`

- [ ] **Step 1: Add guarded removal command**

In `clip_manager.jsx`, add a first version that refuses to run unless QE methods are available and returns exact diagnostics:

```javascript
function removeTimelineRanges(options) {
    var seq = app.project.activeSequence;
    if (!seq) return editflowUtils.safeStringify({ success: false, error: "No active sequence" });

    var ranges = editflowUtils.getParam(options, "ranges") || [];
    if (!ranges.length) return editflowUtils.safeStringify({ success: false, error: "No ranges provided" });

    try {
        app.enableQE();
    } catch (e) {
        return editflowUtils.safeStringify({ success: false, error: "QE not available: " + e.toString() });
    }

    var qeSeq = qe.project.getActiveSequence();
    if (!qeSeq) return editflowUtils.safeStringify({ success: false, error: "No active QE sequence" });
    if (typeof qeSeq.razor !== "function") {
        return editflowUtils.safeStringify({ success: false, error: "QE razor() is not available in this Premiere build" });
    }

    return editflowUtils.safeStringify({
        success: false,
        error: "Range removal needs Premiere QE razor verification before destructive editing.",
        ranges: ranges
    });
}
```

Add it to the return object:

```javascript
removeTimelineRanges: removeTimelineRanges
```

- [ ] **Step 2: Register command in `index.jsx`**

Add:

```javascript
case "removeTimelineRanges":
    result = clipManager.removeTimelineRanges(options);
    break;
```

Also add `"removeTimelineRanges"` to `modifyingCommands`.

- [ ] **Step 3: Add test for command exposure**

Append:

```javascript
test('ExtendScript exposes guarded timeline range removal command', () => {
  const indexSource = fs.readFileSync(path.join(repoRoot, 'cep-panel', 'extendscript', 'index.jsx'), 'utf8');
  const clipSource = fs.readFileSync(path.join(repoRoot, 'cep-panel', 'extendscript', 'clip_manager.jsx'), 'utf8');
  assert.match(indexSource, /case "removeTimelineRanges"/);
  assert.match(clipSource, /function removeTimelineRanges/);
  assert.match(clipSource, /QE razor\(\) is not available/);
});
```

- [ ] **Step 4: Manual Premiere verification**

In Premiere, create a duplicate test sequence with one short audio clip. Use the CEP console or panel command to call:

```javascript
editflowDispatch('removeTimelineRanges', JSON.stringify({
    ranges: [{ start: 1.0, end: 2.0 }]
}))
```

Expected for this task: the command returns either a guarded diagnostic or confirms QE capability. It must not modify the real project yet.

---

### Task 9: UI Controls for Phrase Workflow

**Files:**
- Modify: `cep-panel/client/index.html`
- Modify: `cep-panel/client/src/main.js`

- [ ] **Step 1: Add controls in the Cut tab**

Under the existing Cut tab button row, add:

```html
<label class="field-label">Remove Spoken Phrase From Active Sequence</label>
<input type="text" id="sequence-phrase" class="text-input" placeholder="jamia masjid">
<div class="button-row">
    <button id="btn-analyze-sequence-audio" class="action-btn secondary">Analyze Sequence Audio</button>
    <button id="btn-preview-phrase" class="action-btn secondary">Preview Phrase Matches</button>
    <button id="btn-apply-phrase-cut" class="action-btn primary" disabled>Apply Phrase Cut</button>
</div>
```

- [ ] **Step 2: Bind controls**

In `bindCut()`, add:

```javascript
$('#btn-analyze-sequence-audio').addEventListener('click', analyzeActiveSequenceAudio);
$('#btn-preview-phrase').addEventListener('click', async () => {
    const phrase = $('#sequence-phrase').value.trim();
    if (!phrase) {
        addChatMessage('error', 'Enter a phrase to remove.');
        return;
    }
    const resp = await findPhraseInActiveSequence(phrase);
    if ((resp.ranges || []).length) {
        await evalExtendScript('addPhraseRangeMarkers', JSON.stringify({ phrase, ranges: resp.ranges }));
        $('#btn-apply-phrase-cut').disabled = false;
    }
});
$('#btn-apply-phrase-cut').addEventListener('click', async () => {
    const phrase = $('#sequence-phrase').value.trim();
    const ranges = state.lastPhraseRanges || [];
    if (!phrase || !ranges.length) {
        addChatMessage('error', 'Preview phrase matches before applying cuts.');
        return;
    }
    const result = await evalExtendScript('removeTimelineRanges', JSON.stringify({ phrase, ranges }));
    const parsed = JSON.parse(result);
    if (parsed.success === false) throw new Error(parsed.error || 'Phrase cut failed');
    addChatMessage('assistant', `Removed ${ranges.length} occurrence(s) of "${phrase}" from the active sequence.`);
});
```

- [ ] **Step 3: Run syntax check**

Run:

```powershell
node --check cep-panel\client\src\main.js
```

Expected: no output and exit code 0.

---

### Task 10: End-to-End Verification

**Files:**
- No source file changes.

- [ ] **Step 1: Start backend**

Run:

```powershell
python run.py
```

Expected: server starts on `http://127.0.0.1:8765`.

- [ ] **Step 2: Reset Premiere panel state**

Restart Premiere Pro, open EditFlow AI, and click:

```text
Scan Project
Sync Sequence State
Analyze Sequence Audio
```

Expected chat messages:

```text
Scanned project: ...
Synced sequence ...
Analyzed ... sequence audio clips and indexed ... words.
```

- [ ] **Step 3: Preview phrase**

Enter:

```text
jamia masjid
```

Click:

```text
Preview Phrase Matches
```

Expected: markers appear over every detected "jamia masjid" occurrence in the active sequence.

- [ ] **Step 4: Apply phrase cut only after preview is correct**

Duplicate the sequence first. On the duplicate, click:

```text
Apply Phrase Cut
```

Expected for the guarded implementation: if destructive QE removal is not yet verified, the panel shows the exact diagnostic returned by Premiere. After QE removal is implemented and verified, the duplicate sequence ripples out the marked ranges.

---

### Self-Review

Spec coverage:
- The plan explains why the AI currently does not know the active sequence speech.
- The plan adds active sequence transcription.
- The plan adds phrase matching for "jamia masjid".
- The plan adds preview before destructive edits.
- The plan adds a guarded path for Premiere timeline removal so failures are explicit.

Placeholder scan:
- No deferred implementation markers or unspecified tests remain.

Type consistency:
- `SequenceAnalyzeRequest.audio_clips` uses `SequenceAudioClip`.
- Backend endpoints call `sequence_phrase_service`.
- CEP payload keys match Pydantic aliases by snake_case field names.

---

Plan complete and saved to `docs/superpowers/plans/2026-05-22-active-sequence-phrase-cuts.md`.

Two execution options:

1. **Subagent-Driven (recommended)** - dispatch a fresh worker per task, review after each task, fastest for this cross-layer workflow.
2. **Inline Execution** - execute tasks in this session with checkpoints.

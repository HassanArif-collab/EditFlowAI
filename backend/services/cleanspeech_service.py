"""
EditFlow AI - CleanSpeech Service
Orchestrates transcription and AI-based timeline cleaning.
"""
import logging
import json
from typing import List, Dict, Any
from .whisper_service import whisper_service
from .provider_service import provider_service
from ..models.schemas import TranscriptResult

logger = logging.getLogger(__name__)

class CleanSpeechService:
    def __init__(self):
        pass

    async def analyze_transcript_for_cleaning(self, transcript: TranscriptResult) -> List[Dict[str, float]]:
        """
        Send transcript to LLM to identify fillers, repetitions, and dead air.
        Returns a list of cuts: [{"start": 1.2, "end": 2.5}, ...]
        """
        # Format transcript with timestamps for the LLM
        text_with_times = ""
        for seg in transcript.segments:
            text_with_times += f"[{seg.start:.2f} - {seg.end:.2f}] {seg.text}\n"

        prompt = f"""
        You are an expert video editor. I have a transcript of a speech with timestamps.
        Your task is to identify parts that should be REMOVED to make the speech clean, professional, and concise.
        
        REMOVE:
        1. Filler words (um, uh, like, you know, etc.)
        2. False starts and repetitions (e.g., "I went to... I went to the store")
        3. Long silences or awkward pauses.
        
        TRANSCRIPT:
        {text_with_times}
        
        Return ONLY a JSON array of objects representing segments to DELETE.
        Example: [{"start": 1.5, "end": 2.1}, {"start": 5.4, "end": 6.2}]
        If nothing needs to be removed, return an empty array [].
        """

        try:
            # Use the currently selected provider via provider_service
            response = await provider_service.chat_with_fallback(
                messages=[{"role": "user", "content": prompt}],
                system="You are a precise video editing assistant. Return only valid JSON.",
                temperature=0.1
            )
            
            content = response.get("response", "[]")
            # Clean up potential markdown formatting
            if "```json" in content:
                content = content.split("```json")[1].split("```")[0].strip()
            elif "```" in content:
                content = content.split("```")[1].split("```")[0].strip()
            
            cuts = json.loads(content)
            return cuts
        except Exception as e:
            logger.error(f"Failed to analyze transcript: {e}")
            return []

    async def clean_timeline(self, audio_path: str) -> Dict[str, Any]:
        """
        Full workflow: Transcribe -> Analyze -> Return Cuts
        """
        # 1. Transcribe
        logger.info(f"Transcribing {audio_path}...")
        transcript = await whisper_service.transcribe(audio_path, word_timestamps=True)
        
        # 2. Analyze
        logger.info("Analyzing transcript for cleaning...")
        cuts = await self.analyze_transcript_for_cleaning(transcript)
        
        return {
            "success": True,
            "transcript": transcript.full_text,
            "cuts": cuts
        }

cleanspeech_service = CleanSpeechService()

"""
EditFlow AI - Script Generation & Refinement Engine
Generates edit scripts from transcripts + catalog, refines based on feedback.
"""
import asyncio
import json
import logging
import uuid
from datetime import datetime
from typing import Any, Dict, List, Optional

from ..config import Settings
from ..models.schemas import (
    ClipType, EditClip, EDLClip, EDLInstruction, ScriptPreview,
    ScriptSection, ScriptStatus,
)
from ..models.database import db
from ..services.ollama_service import ollama_service
from ..services.catalog_service import catalog_service
from ..utils.progress import ProgressReporter

logger = logging.getLogger(__name__)


class TemplateManager:
    """Manages edit templates/presets."""

    def __init__(self, template_dir=None):
        self.template_dir = template_dir or Settings().TEMPLATE_DIR
        self.template_dir.mkdir(parents=True, exist_ok=True)
        self._ensure_default_templates()

    def _ensure_default_templates(self):
        """Create default templates if they don't exist."""
        # Jamia Masjid template
        jamia_path = self.template_dir / "jamia_masjid.json"
        if not jamia_path.exists():
            jamia_template = {
                "name": "Jamia Masjid Documentary",
                "description": "7-act narrative arc for mosque construction documentary ads",
                "target_duration": 90,
                "aspect_ratio": "9:16",
                "resolution": {"width": 1080, "height": 1920},
                "fps": 60,
                "acts": [
                    {
                        "name": "Hook",
                        "description": "Cinematic fast-cut hook to grab attention",
                        "duration_pct": 0.05,
                        "micro_cuts": True,
                        "micro_cut_interval": 1.0,
                        "style": "fast-paced",
                    },
                    {
                        "name": "Context",
                        "description": "Establish the project and community",
                        "duration_pct": 0.15,
                        "micro_cuts": True,
                        "micro_cut_interval": 1.5,
                        "style": "informative",
                    },
                    {
                        "name": "Challenge",
                        "description": "Present the obstacle or need",
                        "duration_pct": 0.15,
                        "micro_cuts": True,
                        "micro_cut_interval": 2.0,
                        "style": "emotional",
                    },
                    {
                        "name": "Progress",
                        "description": "Show the construction progress",
                        "duration_pct": 0.20,
                        "micro_cuts": True,
                        "micro_cut_interval": 1.5,
                        "style": "inspiring",
                    },
                    {
                        "name": "Community",
                        "description": "Show community impact and prayers",
                        "duration_pct": 0.15,
                        "micro_cuts": True,
                        "micro_cut_interval": 2.0,
                        "style": "heartwarming",
                    },
                    {
                        "name": "Vision",
                        "description": "Future vision and call to action",
                        "duration_pct": 0.15,
                        "micro_cuts": True,
                        "micro_cut_interval": 1.5,
                        "style": "aspirational",
                    },
                    {
                        "name": "Closing",
                        "description": "Powerful closing with contact info",
                        "duration_pct": 0.15,
                        "micro_cuts": False,
                        "style": "impactful",
                    },
                ],
            }
            with open(jamia_path, "w") as f:
                json.dump(jamia_template, f, indent=2)

        # General documentary template
        general_path = self.template_dir / "general_documentary.json"
        if not general_path.exists():
            general_template = {
                "name": "General Documentary",
                "description": "Flexible documentary template with standard pacing",
                "target_duration": 120,
                "aspect_ratio": "16:9",
                "resolution": {"width": 1920, "height": 1080},
                "fps": 30,
                "acts": [
                    {"name": "Opening", "description": "Set the scene", "duration_pct": 0.10, "micro_cuts": False, "style": "cinematic"},
                    {"name": "Introduction", "description": "Introduce subjects and themes", "duration_pct": 0.20, "micro_cuts": False, "style": "conversational"},
                    {"name": "Development", "description": "Develop the narrative", "duration_pct": 0.30, "micro_cuts": True, "micro_cut_interval": 2.0, "style": "engaging"},
                    {"name": "Climax", "description": "The peak moment", "duration_pct": 0.20, "micro_cuts": True, "micro_cut_interval": 1.5, "style": "intense"},
                    {"name": "Resolution", "description": "Wrap up and closing thoughts", "duration_pct": 0.20, "micro_cuts": False, "style": "reflective"},
                ],
            }
            with open(general_path, "w") as f:
                json.dump(general_template, f, indent=2)

        # Short ad template
        ad_path = self.template_dir / "short_ad.json"
        if not ad_path.exists():
            ad_template = {
                "name": "Short Ad (15-30s)",
                "description": "Fast-paced short advertisement",
                "target_duration": 30,
                "aspect_ratio": "9:16",
                "resolution": {"width": 1080, "height": 1920},
                "fps": 30,
                "acts": [
                    {"name": "Hook", "description": "Attention grabber", "duration_pct": 0.15, "micro_cuts": True, "micro_cut_interval": 0.8, "style": "punchy"},
                    {"name": "Message", "description": "Core message", "duration_pct": 0.50, "micro_cuts": True, "micro_cut_interval": 1.5, "style": "clear"},
                    {"name": "CTA", "description": "Call to action", "duration_pct": 0.35, "micro_cuts": False, "style": "direct"},
                ],
            }
            with open(ad_path, "w") as f:
                json.dump(ad_template, f, indent=2)

    def list_templates(self) -> List[Dict]:
        """List available templates."""
        templates = []
        for path in self.template_dir.glob("*.json"):
            try:
                with open(path) as f:
                    data = json.load(f)
                data["id"] = path.stem
                templates.append(data)
            except Exception:
                continue
        return templates

    def get_template(self, template_id: str) -> Optional[Dict]:
        """Get a specific template by ID."""
        path = self.template_dir / f"{template_id}.json"
        if path.exists():
            with open(path) as f:
                return json.load(f)
        return None


class ScriptEngine:
    """Generates and refines edit scripts from transcripts and catalogs."""

    def __init__(self, settings: Optional[Settings] = None):
        self.settings = settings or Settings()
        self.template_manager = TemplateManager(self.settings.TEMPLATE_DIR)

    async def generate_script(
        self,
        transcripts: List[Dict],
        catalog: List[Dict],
        template_id: str = "jamia_masjid",
        instructions: str = "",
        progress: Optional[ProgressReporter] = None,
    ) -> ScriptPreview:
        """Generate an edit script from transcripts and B-roll catalog.

        Args:
            transcripts: List of transcript data dicts
            catalog: B-roll catalog entries
            template_id: Template to use for structure
            instructions: Additional user instructions
            progress: Progress reporter

        Returns:
            ScriptPreview for user review
        """
        if progress:
            await progress.start("Generating edit script...")

        template = self.template_manager.get_template(template_id)
        if not template:
            if progress:
                await progress.fail(f"Template '{template_id}' not found")
            raise ValueError(f"Template '{template_id}' not found")

        if progress:
            await progress.update(0.2, "Analyzing transcripts and catalog...")

        # Build the generation prompt with all context
        prompt = self._build_generation_prompt(transcripts, catalog, template, instructions)

        if progress:
            await progress.update(0.4, "AI is creating your edit script...")

        # Generate with LLM
        result = await ollama_service.chat_with_fallback(
            messages=[{"role": "user", "content": prompt}],
            system="You are an expert video editor and scriptwriter. Generate structured edit scripts as JSON.",
            temperature=0.7,
            max_tokens=8192,
        )

        response = result["response"]

        if progress:
            await progress.update(0.8, "Parsing edit script...")

        # Parse the response into structured ScriptPreview
        script = self._parse_script_response(response, template, transcripts, catalog)

        if progress:
            await progress.complete(f"Script generated: {script.title} ({script.total_duration}s)")

        # Save script
        db.save_script(script.id, script.dict())

        return script

    async def refine_script(
        self,
        script: ScriptPreview,
        feedback: str,
        progress: Optional[ProgressReporter] = None,
    ) -> ScriptPreview:
        """Refine an existing script based on user feedback.

        Args:
            script: Current script to refine
            feedback: User's feedback/instructions
            progress: Progress reporter

        Returns:
            Updated ScriptPreview
        """
        if progress:
            await progress.start("Refining edit script...")

        # Build refinement prompt
        script_json = json.dumps(script.dict(), indent=2, default=str)
        prompt = f"""Here is the current edit script:
```json
{script_json}
```

The user wants these changes: {feedback}

Please provide the updated edit script as JSON. Keep the same structure but apply the requested changes.
Respond with ONLY the JSON, no additional text."""

        if progress:
            await progress.update(0.3, "AI is refining your script...")

        result = await ollama_service.chat_with_fallback(
            messages=[{"role": "user", "content": prompt}],
            system="You are an expert video editor. Refine edit scripts based on user feedback. Return only valid JSON.",
            temperature=0.5,
            max_tokens=8192,
        )

        response = result["response"]

        if progress:
            await progress.update(0.8, "Applying refinements...")

        # Parse the refined script
        try:
            # Try to parse the response as JSON
            refined_data = self._extract_json(response)
            if refined_data:
                refined_script = ScriptPreview(**refined_data)
                refined_script.version = script.version + 1
                refined_script.status = ScriptStatus.DRAFT
            else:
                raise ValueError("Could not parse refined script")
        except Exception as e:
            logger.warning(f"Failed to parse refined script, applying text-based changes: {e}")
            # Fallback: apply simple text-based modifications
            refined_script = self._apply_simple_refinement(script, feedback)

        if progress:
            await progress.complete("Script refined!")

        # Save updated script
        db.save_script(refined_script.id, refined_script.dict())

        return refined_script

    def script_to_edl(self, script: ScriptPreview) -> EDLInstruction:
        """Convert a script preview into an EDL instruction for ExtendScript.

        This is the bridge between the AI-generated script and actual
        Premiere Pro timeline manipulation.
        """
        clips = []
        for clip in script.all_clips:
            edl_clip = EDLClip(
                id=clip.id,
                action="add",
                clip_type=clip.clip_type,
                source_path=clip.source_path,
                in_point=clip.in_point,
                out_point=clip.out_point,
                start_time=clip.start_time,
                track_index=clip.track,
                scale=clip.scale,
                speed=clip.speed,
                effects=clip.effects,
            )
            clips.append(edl_clip)

        return EDLInstruction(
            script_id=script.id,
            clips=clips,
            undo_group=f"EditFlow AI - {script.title}",
        )

    def _build_generation_prompt(
        self,
        transcripts: List[Dict],
        catalog: List[Dict],
        template: Dict,
        instructions: str,
    ) -> str:
        """Build the LLM prompt for script generation."""
        # Summarize transcripts (don't send full text - too long)
        transcript_summary = []
        for t in transcripts[:10]:  # Limit to 10 transcripts
            source = t.get("source_file", "unknown")
            duration = t.get("duration", 0)
            text = t.get("full_text", t.get("text", ""))[:500]  # Truncate
            language = t.get("language", "unknown")
            transcript_summary.append(f"- {source} ({duration:.1f}s, {language}): {text}...")

        # Summarize catalog
        catalog_summary = []
        for c in catalog[:50]:  # Limit entries
            filename = c.get("filename", "")
            desc = c.get("visual_description", "")
            duration = c.get("duration", 0)
            keywords = ", ".join(c.get("keywords", [])[:3])
            path = c.get("path", "")
            catalog_summary.append(f"- {filename} ({duration:.1f}s): {desc} [{keywords}] | path: {path}")

        template_desc = f"{template['name']} - {template['description']}"
        acts_desc = "\n".join(
            f"  Act {i+1}: {act['name']} ({act['duration_pct']*100:.0f}%) - {act['description']}"
            for i, act in enumerate(template.get("acts", []))
        )

        target_dur = template.get("target_duration", 90)
        resolution = template.get("resolution", {"width": 1080, "height": 1920})

        return f"""Create a detailed edit script for a {target_dur}-second video using the {template_desc} template.

TEMPLATE STRUCTURE:
{acts_desc}

TARGET: {target_dur}s, {resolution['width']}x{resolution['height']}

AVAILABLE TRANSCRIPTS (A-roll):
{chr(10).join(transcript_summary)}

AVAILABLE B-ROLL CATALOG:
{chr(10).join(catalog_summary)}

ADDITIONAL INSTRUCTIONS: {instructions or "Follow the template structure"}

Generate the script as a JSON object with this exact structure:
{{
  "title": "Descriptive title",
  "sections": [
    {{
      "name": "Act name",
      "description": "What happens in this section",
      "clips": [
        {{
          "clip_type": "a_roll" or "b_roll" or "a_audio",
          "source_file": "filename.mp4",
          "source_path": "full/path/to/file",
          "in_point": 0.0,
          "out_point": 5.0,
          "start_time": 0.0,
          "track": 0,
          "scale": 100.0,
          "notes": "Why this clip here"
        }}
      ]
    }}
  ]
}}

Rules:
- Track 0 = main video (A-roll), Track 1 = B-roll overlay, Track 2+ = additional
- B-roll clips should have scale 110-150 for 9:16 content from 16:9 sources
- Micro-cuts: change B-roll every 1.5-2.0 seconds for fast-paced sections
- A-roll audio must be continuous (no gaps in A-audio clips)
- All timestamps in seconds
- Ensure clips don't overlap on the same track (except B-roll over A-roll)
- Match B-roll visually to what's being said in A-roll (semantic syncing)"""

    def _parse_script_response(
        self,
        response: str,
        template: Dict,
        transcripts: List[Dict],
        catalog: List[Dict],
    ) -> ScriptPreview:
        """Parse LLM response into a ScriptPreview."""
        data = self._extract_json(response)

        if data is None:
            # Fallback: create a simple script from template
            return self._create_fallback_script(template, transcripts, catalog)

        try:
            # Build sections and clips
            sections = []
            all_clips = []
            current_time = 0.0
            target_duration = template.get("target_duration", 90)

            for section_data in data.get("sections", []):
                section_clips = []
                for clip_data in section_data.get("clips", []):
                    # Resolve source path from catalog
                    source_file = clip_data.get("source_file", "")
                    source_path = clip_data.get("source_path", "")
                    if not source_path:
                        source_path = self._resolve_path(source_file, catalog, transcripts)

                    clip = EditClip(
                        clip_type=ClipType(clip_data.get("clip_type", "b_roll")),
                        source_file=source_file,
                        source_path=source_path,
                        in_point=float(clip_data.get("in_point", 0)),
                        out_point=float(clip_data.get("out_point", 0)),
                        start_time=float(clip_data.get("start_time", current_time)),
                        track=int(clip_data.get("track", 0)),
                        scale=float(clip_data.get("scale", 100)),
                        notes=clip_data.get("notes", ""),
                    )
                    clip.duration = clip.out_point - clip.in_point
                    section_clips.append(clip)
                    all_clips.append(clip)

                section = ScriptSection(
                    name=section_data.get("name", "Untitled"),
                    description=section_data.get("description", ""),
                    clips=section_clips,
                    start_time=min((c.start_time for c in section_clips), default=0),
                    end_time=max((c.start_time + c.duration for c in section_clips), default=0),
                )
                sections.append(section)

            total_duration = max(
                (c.start_time + c.duration for c in all_clips), default=0
            )

            return ScriptPreview(
                title=data.get("title", "Generated Edit"),
                template=template.get("name", ""),
                sections=sections,
                all_clips=all_clips,
                total_duration=total_duration,
                status=ScriptStatus.DRAFT,
            )

        except Exception as e:
            logger.error(f"Script parsing error: {e}")
            return self._create_fallback_script(template, transcripts, catalog)

    def _create_fallback_script(
        self,
        template: Dict,
        transcripts: List[Dict],
        catalog: List[Dict],
    ) -> ScriptPreview:
        """Create a basic script when LLM generation fails."""
        sections = []
        all_clips = []
        current_time = 0.0
        target_duration = template.get("target_duration", 90)

        for act in template.get("acts", []):
            act_duration = target_duration * act.get("duration_pct", 0.2)
            clips = []

            # Add A-roll from transcript if available
            if transcripts:
                t = transcripts[0]
                clip = EditClip(
                    clip_type=ClipType.A_ROLL,
                    source_file=t.get("source_file", "unknown"),
                    source_path=t.get("source_path", ""),
                    in_point=current_time,
                    out_point=min(current_time + act_duration, t.get("duration", act_duration)),
                    start_time=current_time,
                    track=0,
                    scale=100.0,
                    notes=f"A-roll for {act['name']}",
                )
                clip.duration = clip.out_point - clip.in_point
                clips.append(clip)
                all_clips.append(clip)

            # Add B-roll from catalog
            if catalog and act.get("micro_cuts"):
                interval = act.get("micro_cut_interval", 2.0)
                b_time = current_time
                b_idx = 0
                while b_time < current_time + act_duration and b_idx < len(catalog):
                    entry = catalog[b_idx]
                    dur = min(interval, entry.get("duration", interval), current_time + act_duration - b_time)
                    clip = EditClip(
                        clip_type=ClipType.B_ROLL,
                        source_file=entry.get("filename", ""),
                        source_path=entry.get("path", ""),
                        in_point=0,
                        out_point=dur,
                        start_time=b_time,
                        track=1,
                        scale=110.0,
                        notes=f"B-roll: {entry.get('visual_description', '')[:50]}",
                    )
                    clip.duration = dur
                    clips.append(clip)
                    all_clips.append(clip)
                    b_time += dur
                    b_idx += 1

            section = ScriptSection(
                name=act.get("name", "Section"),
                description=act.get("description", ""),
                clips=clips,
                start_time=current_time,
                end_time=current_time + act_duration,
            )
            sections.append(section)
            current_time += act_duration

        return ScriptPreview(
            title=f"{template.get('name', 'Edit')} - Auto Generated",
            template=template.get("name", ""),
            sections=sections,
            all_clips=all_clips,
            total_duration=current_time,
            status=ScriptStatus.DRAFT,
        )

    def _apply_simple_refinement(self, script: ScriptPreview, feedback: str) -> ScriptPreview:
        """Apply simple text-based refinements when LLM parsing fails."""
        # Just update the notes and bump version
        # Real refinement would need LLM, but this prevents total failure
        script.version += 1
        script.notes = f"Refined: {feedback}"
        script.status = ScriptStatus.DRAFT
        return script

    def _resolve_path(self, filename: str, catalog: List[Dict], transcripts: List[Dict]) -> str:
        """Resolve a filename to its full path from catalog or transcripts."""
        filename_lower = filename.lower()

        for entry in catalog:
            if entry.get("filename", "").lower() == filename_lower:
                return entry.get("path", "")

        for entry in catalog:
            if entry.get("filename", "").lower().startswith(filename_lower[:6]):
                return entry.get("path", "")

        for t in transcripts:
            if t.get("source_video_name", t.get("source_file", "")).lower() == filename_lower:
                return t.get("source_path", "")

        return filename  # Return filename if path not found

    def _extract_json(self, text: str) -> Optional[Dict]:
        """Extract JSON from LLM response (handles markdown wrapping)."""
        # Try direct parse
        text = text.strip()
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            pass

        # Try removing markdown code blocks
        if "```json" in text:
            start = text.index("```json") + 7
            end = text.index("```", start) if "```" in text[start:] else len(text)
            try:
                return json.loads(text[start:end].strip())
            except json.JSONDecodeError:
                pass

        if "```" in text:
            start = text.index("```") + 3
            if text[start:start+4] == "json":
                start += 4
            end = text.index("```", start) if "```" in text[start:] else len(text)
            try:
                return json.loads(text[start:end].strip())
            except json.JSONDecodeError:
                pass

        # Try finding JSON object boundaries
        for start_char, end_char in [("{", "}"), ("[", "]")]:
            start = text.find(start_char)
            if start >= 0:
                # Find matching end
                depth = 0
                for i in range(start, len(text)):
                    if text[i] == start_char:
                        depth += 1
                    elif text[i] == end_char:
                        depth -= 1
                    if depth == 0:
                        try:
                            return json.loads(text[start:i+1])
                        except json.JSONDecodeError:
                            break

        return None


# Global service instances
script_engine = ScriptEngine()
template_manager = TemplateManager()

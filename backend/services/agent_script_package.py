"""A small execution contract for scripts written by any external agent."""
from pathlib import Path
from typing import List, Literal, Optional
import hashlib
import json

from pydantic import BaseModel, ConfigDict, Field, model_validator


class AgentCut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["recorded_dialogue", "generated_narration", "graphic", "visual"] = "recorded_dialogue"
    source_file: str
    source_in: float = Field(0, ge=0, allow_inf_nan=False)
    source_out: float = Field(..., gt=0, allow_inf_nan=False)
    speaker: str = ""
    quote: str = ""
    caption: str = ""
    visual_cue: str = ""
    fit_mode: Literal["fill", "contain"] = "fill"
    zoom: float = Field(1, ge=1, le=3, allow_inf_nan=False)
    focal_point: Optional[List[float]] = Field(None, min_length=2, max_length=2)

    @model_validator(mode="after")
    def valid_range(self):
        if self.source_out <= self.source_in:
            raise ValueError("source_out must be after source_in")
        if self.focal_point and any(not 0 <= value <= 1 for value in self.focal_point):
            raise ValueError("focal_point must use normalized coordinates from 0 to 1")
        return self


class AgentVariant(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = "primary"
    label: str = "Primary cut"
    cuts: List[AgentCut] = Field(..., min_length=1)


class AgentScriptPackage(BaseModel):
    model_config = ConfigDict(extra="forbid")
    schema_version: Literal[1] = 1
    project_folder: str
    brand: str
    title: str
    script_revision: str = Field(..., min_length=64, max_length=64)
    variants: List[AgentVariant] = Field(..., min_length=1)
    captions_enabled: bool = False

    @model_validator(mode="after")
    def unique_variants(self):
        ids = [variant.id for variant in self.variants]
        if "primary" not in ids or len(ids) != len(set(ids)):
            raise ValueError("Variant IDs must be unique and include primary")
        return self


def load_package(script_path: str):
    """Markdown is the readable script; its optional sidecar links the approved media."""
    path = Path(script_path)
    if path.name.endswith(".editflow.json"):
        package_path = path
        markdown = path.with_name(path.name[:-len(".editflow.json")] + ".md")
    else:
        markdown = path
        package_path = path.with_suffix(".editflow.json")
    if not package_path.is_file():
        return None
    package = AgentScriptPackage.model_validate(json.loads(package_path.read_text(encoding="utf-8-sig")))
    if not markdown.is_file():
        raise ValueError(f"The execution sidecar needs its readable script: {markdown}")
    revision = hashlib.sha256(markdown.read_text(encoding="utf-8").encode("utf-8")).hexdigest()
    return package, str(markdown.resolve()), revision == package.script_revision

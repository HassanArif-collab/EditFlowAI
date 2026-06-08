"""Registry of cut-proposer approaches to bake off. Add new approaches here."""
from .baseline import baseline
from .a7_trim import a7_trim
from .a1_embed import a1_embed
from .a2_focused import a2_focused, a1a2
from .a8_safe import a8_safe
from .a5_script import a5_script
from .a5_llm_script import a5_llm_script
from .a5_clean import a5_clean

REGISTRY = {
    "a5_script": a5_script,
    "a5_llm_script": a5_llm_script,
    "a5_clean": a5_clean,
    "baseline": baseline,
    "a7_trim": a7_trim,
    "a1_embed": a1_embed,
    "a2_focused": a2_focused,
    "a1a2": a1a2,
    "a8_safe": a8_safe,
}

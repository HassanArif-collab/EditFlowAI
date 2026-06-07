"""Registry of cut-proposer approaches to bake off. Add new approaches here."""
from .baseline import baseline
from .a7_trim import a7_trim
from .a1_embed import a1_embed

REGISTRY = {
    "baseline": baseline,
    "a7_trim": a7_trim,
    "a1_embed": a1_embed,
}

"""Registry of cut-proposer approaches to bake off. Add new approaches here."""
from .baseline import baseline
from .a7_trim import a7_trim

REGISTRY = {
    "baseline": baseline,
    "a7_trim": a7_trim,
}

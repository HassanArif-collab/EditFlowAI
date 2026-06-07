"""Registry of cut-proposer approaches to bake off. Add new approaches here."""
from .baseline import baseline

REGISTRY = {
    "baseline": baseline,
}

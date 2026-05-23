"""EmbeddingService — lazy-loaded sentence-transformers wrapper.

Model: paraphrase-multilingual-MiniLM-L12-v2 (384-dim, ~80 MB, CPU-fast).
Falls back gracefully if sentence-transformers is not installed —
preflight check (Phase A.1) should have caught that.
"""

import logging
import math
from typing import Optional

logger = logging.getLogger(__name__)


class EmbeddingService:
    """Lazy-loaded sentence-transformers wrapper.

    Model: paraphrase-multilingual-MiniLM-L12-v2 (384-dim, ~80 MB, CPU-fast).
    Falls back gracefully if sentence-transformers is not installed —
    preflight check (Phase A.1) should have caught that.
    """

    def __init__(self, model_name: str = "paraphrase-multilingual-MiniLM-L12-v2"):
        self.model_name = model_name
        self._model = None  # lazy

    # ── Internal ──

    def _load(self) -> None:
        """Load the model on first use."""
        if self._model is not None:
            return
        try:
            from sentence_transformers import SentenceTransformer
        except ImportError:
            raise RuntimeError(
                "sentence-transformers not installed. Run: pip install sentence-transformers"
            )
        logger.info("Loading embedding model %s …", self.model_name)
        self._model = SentenceTransformer(self.model_name)
        logger.info("Embedding model loaded (dim=%d)", self._model.get_sentence_embedding_dimension())

    # ── Public API ──

    def embed(self, texts: list[str]) -> list[list[float]]:
        """Returns one 384-dim vector per text. Order preserved."""
        self._load()
        embeddings = self._model.encode(texts, convert_to_numpy=True, show_progress_bar=False)
        # Convert numpy array to plain Python lists for JSON-serialisation safety
        return embeddings.tolist()

    def top_k(
        self,
        query_embedding: list[float],
        candidate_embeddings: list[list[float]],
        k: int = 20,
    ) -> list[tuple[int, float]]:
        """(candidate_index, cosine_similarity) tuples sorted desc.

        Returns at most *k* pairs.
        """
        if not candidate_embeddings:
            return []

        try:
            import numpy as np

            query = np.asarray(query_embedding, dtype=np.float64)
            candidates = np.asarray(candidate_embeddings, dtype=np.float64)

            # Normalise rows to unit length for cosine-similarity via dot product
            query_norm = np.linalg.norm(query)
            if query_norm == 0:
                return []
            query = query / query_norm

            cand_norms = np.linalg.norm(candidates, axis=1, keepdims=True)
            # Guard against zero-norm rows
            cand_norms = np.where(cand_norms == 0, 1.0, cand_norms)
            candidates = candidates / cand_norms

            # Cosine similarities
            sims = candidates @ query  # shape (n,)

            # Top-k indices (descending)
            if k >= len(sims):
                top_idx = np.argsort(-sims)
            else:
                # argpartition is O(n) vs O(n log n) for full sort
                part_idx = np.argpartition(-sims, k)[:k]
                top_idx = part_idx[np.argsort(-sims[part_idx])]

            return [(int(idx), float(sims[idx])) for idx in top_idx]

        except ImportError:
            # Pure-Python fallback when numpy is not available
            return self._top_k_pure(query_embedding, candidate_embeddings, k)

    # ── Fallback (no numpy) ──

    @staticmethod
    def _top_k_pure(
        query_embedding: list[float],
        candidate_embeddings: list[list[float]],
        k: int,
    ) -> list[tuple[int, float]]:
        """Pure-Python cosine top-k — used only when numpy is absent."""
        q = query_embedding

        def _cosine(a: list[float], b: list[float]) -> float:
            dot = sum(x * y for x, y in zip(a, b))
            na = math.sqrt(sum(x * x for x in a))
            nb = math.sqrt(sum(x * x for x in b))
            if na == 0.0 or nb == 0.0:
                return 0.0
            return dot / (na * nb)

        scored = [(i, _cosine(q, c)) for i, c in enumerate(candidate_embeddings)]
        scored.sort(key=lambda t: t[1], reverse=True)
        return scored[:k]


# ── Module-level singleton ──

embedding_service = EmbeddingService()

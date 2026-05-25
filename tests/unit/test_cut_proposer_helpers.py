"""
Unit tests for cut_proposer helper functions (_cosine_sim, _compute_retake_pairs).
Pure math — no LLM or Whisper mocking required.
"""
from types import SimpleNamespace

import pytest

from backend.services.agent.cut_proposer import _cosine_sim, _compute_retake_pairs


# ── _cosine_sim ──────────────────────────────────────────────────────────


class TestCosineSim:
    def test_orthogonal_returns_zero(self):
        result = _cosine_sim([1, 0, 0], [0, 1, 0])
        assert result == pytest.approx(0.0, abs=1e-9)

    def test_identical_returns_one(self):
        result = _cosine_sim([1, 2, 3], [1, 2, 3])
        assert result == pytest.approx(1.0, abs=1e-6)

    def test_empty_returns_zero(self):
        assert _cosine_sim([], []) == 0.0
        assert _cosine_sim([1, 2], []) == 0.0
        assert _cosine_sim([], [1, 2]) == 0.0

    def test_mismatched_length_returns_zero(self):
        assert _cosine_sim([1, 2], [1, 2, 3]) == 0.0

    def test_zero_vector_returns_zero(self):
        assert _cosine_sim([0, 0, 0], [1, 2, 3]) == 0.0
        assert _cosine_sim([1, 2, 3], [0, 0, 0]) == 0.0


# ── _compute_retake_pairs ────────────────────────────────────────────────


class TestRetakePairs:
    def test_finds_similar(self):
        """Two takes with near-identical embeddings get paired; a third
        orthogonal take is not paired with either."""
        e_same = [1.0, 0.0, 0.0]
        e_same2 = [0.99, 0.01, 0.0]  # very similar to e_same
        e_diff = [0.0, 1.0, 0.0]     # orthogonal

        takes = [
            SimpleNamespace(embedding=e_same),
            SimpleNamespace(embedding=e_same2),
            SimpleNamespace(embedding=e_diff),
        ]

        pairs = _compute_retake_pairs(takes, threshold=0.80)

        # Only the pair (0, 1) should be found
        assert len(pairs) == 1
        assert pairs[0]["take_a"] == 0
        assert pairs[0]["take_b"] == 1
        assert pairs[0]["similarity"] >= 0.80

    def test_skips_takes_without_embeddings(self):
        """A take with empty embedding list never appears in pairs."""
        takes = [
            SimpleNamespace(embedding=[1.0, 0.0]),
            SimpleNamespace(embedding=[]),
            SimpleNamespace(embedding=[0.99, 0.01]),
        ]

        pairs = _compute_retake_pairs(takes, threshold=0.80)

        # Only pair (0, 2) — take 1 has no embedding
        for p in pairs:
            assert 1 not in (p["take_a"], p["take_b"])

    def test_ordering(self):
        """For any returned pair, take_a < take_b."""
        takes = [
            SimpleNamespace(embedding=[1.0, 0.0]),
            SimpleNamespace(embedding=[0.99, 0.01]),
            SimpleNamespace(embedding=[0.98, 0.02]),
        ]

        pairs = _compute_retake_pairs(takes, threshold=0.80)

        for p in pairs:
            assert p["take_a"] < p["take_b"]

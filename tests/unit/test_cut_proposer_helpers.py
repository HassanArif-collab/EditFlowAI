"""
Unit tests for cut_proposer helper functions (_cosine_sim, _compute_retake_pairs).
Pure math — no LLM or Whisper mocking required.
"""
from types import SimpleNamespace

import pytest

from backend.services.agent.cut_proposer import (
    _cosine_sim,
    _compute_retake_pairs,
    _cluster_retakes,
    _enforce_cluster_constraint,
    _dedup_by_similarity,
    _drop_trailing_filler,
)


def _take(idx, *, text="some content", duration=10.0, embedding=None, quality_score=0.7):
    """Minimal fake take for post-processing tests."""
    return SimpleNamespace(
        text=text,
        duration=duration,
        embedding=embedding or [],
        quality={"score": quality_score},
    )


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


# ── _cluster_retakes ──────────────────────────────────────────────────────


class TestClusterRetakes:
    def test_transitive_merge(self):
        """Pairs (0,1) and (1,2) → single cluster [0,1,2]."""
        pairs = [
            {"take_a": 0, "take_b": 1, "similarity": 0.85},
            {"take_a": 1, "take_b": 2, "similarity": 0.82},
        ]
        clusters = _cluster_retakes(pairs, num_takes=5)
        assert len(clusters) == 1
        assert clusters[0] == [0, 1, 2]

    def test_disjoint_groups(self):
        """Pairs (0,1) and (3,4) → two separate clusters."""
        pairs = [
            {"take_a": 0, "take_b": 1, "similarity": 0.9},
            {"take_a": 3, "take_b": 4, "similarity": 0.9},
        ]
        clusters = _cluster_retakes(pairs, num_takes=5)
        assert len(clusters) == 2
        clusters_sorted = sorted(clusters, key=lambda c: c[0])
        assert clusters_sorted[0] == [0, 1]
        assert clusters_sorted[1] == [3, 4]

    def test_no_pairs_returns_empty(self):
        """Empty input → empty cluster list."""
        assert _cluster_retakes([], num_takes=5) == []

    def test_each_cluster_sorted(self):
        """Each returned cluster is sorted ascending."""
        # Build pairs out of order to stress sorting
        pairs = [
            {"take_a": 5, "take_b": 2, "similarity": 0.9},
            {"take_a": 2, "take_b": 8, "similarity": 0.9},
        ]
        clusters = _cluster_retakes(pairs, num_takes=10)
        assert len(clusters) == 1
        # Must be sorted ascending regardless of pair insertion order
        assert clusters[0] == sorted(clusters[0])

    def test_chain_of_four(self):
        """Long chain (0,1) (1,2) (2,3) → single cluster of 4."""
        pairs = [
            {"take_a": 0, "take_b": 1, "similarity": 0.8},
            {"take_a": 1, "take_b": 2, "similarity": 0.8},
            {"take_a": 2, "take_b": 3, "similarity": 0.8},
        ]
        clusters = _cluster_retakes(pairs, num_takes=4)
        assert len(clusters) == 1
        assert clusters[0] == [0, 1, 2, 3]


# ── _enforce_cluster_constraint ───────────────────────────────────────────


class TestEnforceClusterConstraint:
    def test_drops_duplicate_from_same_cluster(self):
        """If LLM picked two takes from cluster [0,1,2], keep only one."""
        takes = [
            _take(0, quality_score=0.5),
            _take(1, quality_score=0.9),  # best in cluster
            _take(2, quality_score=0.6),
        ]
        clusters = [[0, 1, 2]]
        selected = [
            {"take_index": 0, "beat_text": "a"},
            {"take_index": 2, "beat_text": "b"},
            {"take_index": 1, "beat_text": "c"},
        ]
        kept = _enforce_cluster_constraint(selected, clusters, takes)
        assert len(kept) == 1
        # The one with highest quality (take 1) should win
        assert kept[0]["take_index"] == 1

    def test_preserves_standalone_takes(self):
        """Takes not in any cluster pass through unchanged."""
        takes = [_take(i) for i in range(4)]
        clusters = [[0, 1]]
        selected = [
            {"take_index": 0, "beat_text": "a"},
            {"take_index": 2, "beat_text": "b"},
            {"take_index": 3, "beat_text": "c"},
        ]
        kept = _enforce_cluster_constraint(selected, clusters, takes)
        # Should keep one of cluster {0,1} (only 0 in selection) + both standalones
        assert len(kept) == 3
        indices = [s["take_index"] for s in kept]
        assert 2 in indices
        assert 3 in indices

    def test_no_clusters_passthrough(self):
        """Empty cluster list → return selections unchanged."""
        takes = [_take(i) for i in range(3)]
        selected = [{"take_index": i, "beat_text": "x"} for i in range(3)]
        kept = _enforce_cluster_constraint(selected, [], takes)
        assert kept == selected


# ── _dedup_by_similarity ──────────────────────────────────────────────────


class TestDedupBySimilarity:
    def test_drops_highly_similar_pair(self):
        """Two final selections with >= 0.55 cosine should collapse to one."""
        takes = [
            _take(0, embedding=[1.0, 0.0, 0.0], quality_score=0.5),
            _take(1, embedding=[0.99, 0.01, 0.0], quality_score=0.8),  # almost identical
            _take(2, embedding=[0.0, 1.0, 0.0], quality_score=0.7),    # orthogonal
        ]
        selected = [
            {"take_index": 0, "beat_text": "a"},
            {"take_index": 1, "beat_text": "b"},
            {"take_index": 2, "beat_text": "c"},
        ]
        kept = _dedup_by_similarity(selected, takes, threshold=0.55)
        assert len(kept) == 2
        kept_indices = {s["take_index"] for s in kept}
        # Higher quality (take 1) wins over take 0; take 2 is independent
        assert 1 in kept_indices
        assert 2 in kept_indices

    def test_keeps_dissimilar_takes(self):
        """Takes below the threshold all pass through."""
        takes = [
            _take(0, embedding=[1.0, 0.0]),
            _take(1, embedding=[0.0, 1.0]),
            _take(2, embedding=[0.7, 0.7]),  # ~0.71 with both, but we use 0.55
        ]
        # All pairs >0.55 here actually — adjust to make truly dissimilar
        takes = [
            _take(0, embedding=[1.0, 0.0, 0.0]),
            _take(1, embedding=[0.0, 1.0, 0.0]),
            _take(2, embedding=[0.0, 0.0, 1.0]),
        ]
        selected = [{"take_index": i, "beat_text": "x"} for i in range(3)]
        kept = _dedup_by_similarity(selected, takes, threshold=0.55)
        assert len(kept) == 3

    def test_no_embeddings_passthrough(self):
        """Selections whose takes lack embeddings can't be deduped — keep all."""
        takes = [_take(0, embedding=[]), _take(1, embedding=[])]
        selected = [{"take_index": 0}, {"take_index": 1}]
        kept = _dedup_by_similarity(selected, takes)
        assert len(kept) == 2


# ── _drop_trailing_filler ─────────────────────────────────────────────────


class TestDropTrailingFiller:
    def test_drops_haan_ji_closer(self):
        """A short take ending with 'haan ji' (filler) should be dropped."""
        takes = [
            _take(0, text="big content take", duration=15.0),
            _take(1, text="ہاں جی", duration=1.5),
        ]
        selected = [
            {"take_index": 0, "beat_text": "main content"},
            {"take_index": 1, "beat_text": "closer"},
        ]
        kept = _drop_trailing_filler(selected, takes)
        assert len(kept) == 1
        assert kept[0]["take_index"] == 0

    def test_keeps_long_substantive_take_even_with_filler_word(self):
        """A long take that happens to end with 'okay' should NOT be dropped."""
        takes = [
            _take(0, text="this is a complete thought ending in okay", duration=12.0),
        ]
        selected = [{"take_index": 0, "beat_text": "x"}]
        kept = _drop_trailing_filler(selected, takes)
        assert len(kept) == 1  # duration > 5s → preserved

    def test_no_op_on_empty(self):
        """Empty input → empty output, no error."""
        assert _drop_trailing_filler([], []) == []

"""MVP Task M8: plan_store tests"""
import unittest
import tempfile
import shutil
from pathlib import Path
from backend.services.plan_store import PlanStore

class TestPlanStore(unittest.TestCase):
    def setUp(self):
        self.tmp_dir = Path(tempfile.mkdtemp())
        self.store = PlanStore(base_dir=self.tmp_dir)

    def tearDown(self):
        shutil.rmtree(self.tmp_dir, ignore_errors=True)

    def test_save_and_load_roundtrip(self):
        plan = {
            "plan_id": "abc123",
            "created_at": "2026-01-01T00:00:00",
            "bin_reference": "@bin:Test",
            "cuts": [{"beat_index": 0, "source_in": 0.0, "source_out": 5.0}],
            "summary": {"matched": 1},
        }
        # Use a simple object with plan_id for save
        class SimplePlan:
            def __init__(self, data):
                self.plan_id = data["plan_id"]
                self._data = data
            def model_dump_json(self, indent=2):
                import json
                return json.dumps(self._data, indent=indent)

        self.store.save(SimplePlan(plan))
        loaded = self.store.load("abc123")
        self.assertEqual(loaded["plan_id"], "abc123")
        self.assertEqual(loaded["summary"]["matched"], 1)

    def test_load_missing_raises(self):
        with self.assertRaises(FileNotFoundError):
            self.store.load("nonexistent")

    def test_list_returns_saved_plans(self):
        plan1 = type('P', (), {
            'plan_id': 'p1',
            'model_dump_json': lambda self, indent=2: '{"plan_id":"p1","created_at":"2026-01-01T00:00:00"}'
        })()
        plan2 = type('P', (), {
            'plan_id': 'p2',
            'model_dump_json': lambda self, indent=2: '{"plan_id":"p2","created_at":"2026-01-02T00:00:00"}'
        })()
        self.store.save(plan1)
        self.store.save(plan2)
        result = self.store.list()
        self.assertEqual(len(result), 2)

    def test_delete(self):
        plan = type('P', (), {
            'plan_id': 'del1',
            'model_dump_json': lambda self, indent=2: '{"plan_id":"del1"}'
        })()
        self.store.save(plan)
        self.assertTrue(self.store.delete("del1"))
        self.assertFalse(self.store.delete("del1"))  # already deleted

if __name__ == "__main__":
    unittest.main()

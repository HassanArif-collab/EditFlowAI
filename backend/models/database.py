"""
EditFlow AI - Simple JSON-based Database
Persistent storage for catalogs, transcripts, scripts, and session data.
"""
import json
import threading
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

from ..config import Settings


class JsonDatabase:
    """Thread-safe JSON file database for EditFlow data."""

    def __init__(self, data_dir: Optional[Path] = None):
        settings = Settings()
        self.data_dir = data_dir or settings.DATA_DIR
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self._locks: Dict[str, threading.RLock] = {}  # RLock allows reentrant locking
        self._master_lock = threading.Lock()  # Protects _locks dict itself

    def _get_lock(self, collection: str) -> threading.RLock:
        with self._master_lock:
            if collection not in self._locks:
                self._locks[collection] = threading.RLock()
            return self._locks[collection]

    def _path(self, collection: str) -> Path:
        return self.data_dir / f"{collection}.json"

    def _read_file(self, collection: str) -> Any:
        """Internal read without locking (caller must hold the lock)."""
        path = self._path(collection)
        if not path.exists():
            return None
        try:
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f)
        except (json.JSONDecodeError, IOError):
            return None

    def _write_file(self, collection: str, data: Any) -> None:
        """Internal write without locking (caller must hold the lock)."""
        path = self._path(collection)
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2, default=str)

    def load(self, collection: str) -> Any:
        """Load a collection from disk."""
        with self._get_lock(collection):
            return self._read_file(collection)

    def save(self, collection: str, data: Any) -> None:
        """Save a collection to disk."""
        with self._get_lock(collection):
            self._write_file(collection, data)

    def update(self, collection: str, updater: callable) -> Any:
        """Atomically load, update, and save a collection.
        The updater function receives the current data and should return the new data.
        """
        with self._get_lock(collection):
            data = self._read_file(collection)
            new_data = updater(data)
            self._write_file(collection, new_data)
            return new_data

    def append_to_list(self, collection: str, item: Dict) -> List:
        """Append an item to a list collection."""
        def updater(data):
            if data is None:
                data = []
            if isinstance(data, list):
                data.append(item)
            return data
        return self.update(collection, updater)

    def get_session(self, session_id: str) -> Optional[Dict]:
        """Get chat session data."""
        sessions = self.load("sessions") or {}
        return sessions.get(session_id)

    def save_session(self, session_id: str, data: Dict) -> None:
        """Save chat session data."""
        def updater(sessions):
            if sessions is None:
                sessions = {}
            sessions[session_id] = data
            # Keep only last 50 sessions
            if len(sessions) > 50:
                sorted_keys = sorted(sessions.keys(), 
                    key=lambda k: sessions[k].get('updated_at', ''), reverse=True)
                sessions = {k: sessions[k] for k in sorted_keys[:50]}
            return sessions
        self.update("sessions", updater)

    def get_catalog(self, catalog_name: str = "default") -> Optional[Dict]:
        """Get a B-roll catalog."""
        return self.load(f"catalog_{catalog_name}")

    def save_catalog(self, catalog_name: str, data: Dict) -> None:
        """Save a B-roll catalog."""
        self.save(f"catalog_{catalog_name}", data)

    def get_script(self, script_id: str) -> Optional[Dict]:
        """Get a saved edit script."""
        scripts = self.load("scripts") or {}
        return scripts.get(script_id)

    def save_script(self, script_id: str, data: Dict) -> None:
        """Save an edit script."""
        def updater(scripts):
            if scripts is None:
                scripts = {}
            scripts[script_id] = data
            return scripts
        self.update("scripts", updater)


# Global database instance
db = JsonDatabase()

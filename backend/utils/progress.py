"""
EditFlow AI - Progress Reporter
WebSocket-based real-time progress reporting.
"""
import time
import uuid
from typing import Dict, Optional

from fastapi import WebSocket


_MAX_CONNECTIONS = 64


class ConnectionManager:
    """Manages active WebSocket connections with a hard cap."""

    def __init__(self):
        self.active_connections: Dict[str, WebSocket] = {}

    async def connect(
        self,
        websocket: WebSocket,
        client_id: Optional[str] = None,
    ) -> Optional[str]:
        """Accept a new WebSocket. Returns the client_id, or None if refused."""
        if len(self.active_connections) >= _MAX_CONNECTIONS:
            try:
                # Code 1013 = "Try Again Later"
                await websocket.close(code=1013, reason="Server connection limit reached")
            except Exception:
                pass
            return None
        await websocket.accept()
        client_id = client_id or str(uuid.uuid4())
        self.active_connections[client_id] = websocket
        return client_id

    def disconnect(self, client_id: str):
        self.active_connections.pop(client_id, None)

    async def send_to(self, client_id: str, message: Dict):
        ws = self.active_connections.get(client_id)
        if ws:
            try:
                await ws.send_json(message)
            except Exception:
                self.disconnect(client_id)

    async def broadcast(self, message: Dict):
        # Snapshot first — sending may yield to the loop, which can mutate the dict
        disconnected = []
        for cid, ws in list(self.active_connections.items()):
            try:
                await ws.send_json(message)
            except Exception:
                disconnected.append(cid)
        for cid in disconnected:
            self.disconnect(cid)


# Global connection manager
manager = ConnectionManager()


class ProgressReporter:
    """Reports task progress via WebSocket.

    Usage:
        reporter = ProgressReporter(task_id="abc", task_type="transcribe")
        await reporter.start("Transcribing video...")
        await reporter.update(0.5, "Halfway done...")
        await reporter.complete("Transcription finished!")
    """

    def __init__(
        self,
        task_id: Optional[str] = None,
        task_type: str = "generic",
        client_id: Optional[str] = None,
    ):
        self.task_id = task_id or str(uuid.uuid4())[:8]
        self.task_type = task_type
        self.client_id = client_id
        self.start_time = time.time()
        self._last_progress = 0.0

    async def _emit(self, status: str, progress: float, message: str, data: Optional[Dict] = None):
        event = {
            "type": "progress",
            "payload": {
                "task_id": self.task_id,
                "task_type": self.task_type,
                "status": status,
                "progress": round(progress, 3),
                "message": message,
                "elapsed": round(time.time() - self.start_time, 1),
                "data": data,
            },
        }
        if self.client_id:
            await manager.send_to(self.client_id, event)
        else:
            await manager.broadcast(event)

    async def start(self, message: str = "Task started"):
        self.start_time = time.time()
        await self._emit("started", 0.0, message)

    async def update(self, progress: float, message: str = "", data: Optional[Dict] = None):
        self._last_progress = progress
        await self._emit("progress", progress, message, data)

    async def complete(self, message: str = "Task completed", data: Optional[Dict] = None):
        await self._emit("completed", 1.0, message, data)

    async def fail(self, message: str = "Task failed", data: Optional[Dict] = None):
        await self._emit("failed", self._last_progress, message, data)

    async def step(self, step_num: int, total_steps: int, message: str = ""):
        progress = step_num / total_steps if total_steps > 0 else 0.0
        await self.update(progress, message or f"Step {step_num}/{total_steps}")

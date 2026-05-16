from fastapi.testclient import TestClient

from backend.main import app


def test_ping_is_cheap_backend_liveness_endpoint():
    with TestClient(app) as client:
        response = client.get("/api/ping")

    assert response.status_code == 200
    data = response.json()
    assert data["server"] == "running"
    assert "feature_flags" in data

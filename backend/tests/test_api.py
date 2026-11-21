"""Route-level tests through FastAPI's TestClient (fake Alpaca, no network)."""


def test_health(client):
    body = client.get("/api/health").json()
    assert set(body) >= {"configured", "account", "feed"}


def test_bars_payload_shape(client):
    r = client.get("/api/bars/AAPL", params={"range": "1Y", "sma": "10,30,100", "rsi": "7"})
    assert r.status_code == 200
    body = r.json()
    assert body["params"]["sma"] == [10, 30, 100] and body["params"]["rsi"] == 7
    cols = body["columns"]
    assert len(cols["time"]) == body["count"] == len(cols["close"]) == len(cols["sma1"])


def test_bars_validation_errors(client):
    assert client.get("/api/bars/aa$pl").status_code == 400
    assert client.get("/api/bars/AAPL", params={"range": "XX"}).status_code == 400
    r = client.get("/api/bars/AAPL", params={"macd": "26,12,9"})
    assert r.status_code == 400 and "fast length" in r.json()["detail"]


def test_quote(client):
    q = client.get("/api/quote/AAPL").json()
    assert q["symbol"] == "AAPL" and q["price"] == 101.0
    assert q["prev_close"] is not None and q["week52_high"] >= q["week52_low"]
    assert client.get("/api/quote/NOPE").status_code == 404


def test_search(client):
    assert [a["symbol"] for a in client.get("/api/search", params={"q": "aap"}).json()] == ["AAP", "AAPL"]


def test_live_status_shape(client):
    body = client.get("/api/live/status").json()
    assert {"state", "symbols", "watching", "upstream"} <= set(body)

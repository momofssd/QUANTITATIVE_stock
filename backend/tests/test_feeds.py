from backend.app.alpaca_api.feeds import merge_tail


def bar(t, h, l, c, v):
    return {"t": t, "o": c, "h": h, "l": l, "c": c, "v": v}


def test_merge_tail_folds_overlap_and_appends_newer():
    hist = [bar("2026-11-20T05:00:00Z", 5, 1, 4, 1000)]
    live = [bar("2026-11-19T05:00:00Z", 9, 0, 0, 1),        # older than history: ignored
            bar("2026-11-20T05:00:00Z", 6, 2, 5.5, 40),     # same bar: extend high/low, take close
            bar("2026-11-21T05:00:00Z", 6, 5, 6, 7)]        # newer: appended
    out = merge_tail(hist, live)
    assert len(out) == 2
    assert out[0] == {**hist[0], "h": 6, "l": 1, "c": 5.5, "v": 1000}
    assert out[1]["t"] == "2026-11-21T05:00:00Z"


def test_merge_tail_without_history_returns_live():
    live = [bar("2026-11-21T05:00:00Z", 6, 5, 6, 7)]
    assert merge_tail([], live) == live

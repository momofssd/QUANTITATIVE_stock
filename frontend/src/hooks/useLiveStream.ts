/**
 * Live WebSocket for the symbol on screen. Changing `symbol` closes the old socket before opening the new one
 * (the backend then terminates the old Alpaca connection). `symbol = null` disconnects.
 */
import { useEffect, useRef, useState } from "react";
import { LiveFeed } from "../services/liveFeed";
import type { LiveMessage, StreamStatus } from "../types/api";

const IDLE: StreamStatus = { type: "status", state: "idle", detail: "" };

export function useLiveStream(symbol: string | null, onMessage: (m: LiveMessage) => void): StreamStatus {
  const [status, setStatus] = useState<StreamStatus>(IDLE);
  const handler = useRef(onMessage);
  handler.current = onMessage;
  const feedRef = useRef<LiveFeed | null>(null);

  useEffect(() => {
    const feed = new LiveFeed((m) => {
      if (m.type === "status") setStatus(m);
      handler.current(m);
    });
    feedRef.current = feed;
    return () => {
      feed.dispose();
      feedRef.current = null;
    };
  }, []);

  useEffect(() => {
    const feed = feedRef.current;
    if (!feed) return;
    if (symbol) feed.open(symbol); // closes the previous symbol's socket first
    else {
      feed.close();
      setStatus(IDLE);
    }
  }, [symbol]);

  return status;
}

/**
 * Browser side of the live stream: one WebSocket to the backend for the symbol on screen.
 * open(symbol) always closes the previous socket first, which makes the backend drop that symbol
 * and reconnect Alpaca for only what is still being watched.
 */
import type { LiveMessage } from "../types/api";

export class LiveFeed {
  private ws: WebSocket | null = null;
  private symbol: string | null = null;
  private delay = 1000;
  private retryTimer = 0;
  private pingTimer = 0;
  private readonly onPageHide = () => this.close();

  constructor(private readonly onMessage: (m: LiveMessage) => void) {
    window.addEventListener("pagehide", this.onPageHide);
  }

  open(symbol: string): void {
    this.close();
    this.symbol = symbol;
    this.delay = 1000;
    this.connect();
  }

  close(): void {
    window.clearTimeout(this.retryTimer);
    window.clearInterval(this.pingTimer);
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = ws.onmessage = ws.onerror = ws.onopen = null;
      try {
        ws.close(1000, "symbol changed");
      } catch {
        /* already closed */
      }
    }
  }

  /** Close for good (component unmount). */
  dispose(): void {
    this.close();
    window.removeEventListener("pagehide", this.onPageHide);
  }

  private connect(): void {
    if (!this.symbol) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws/live/${encodeURIComponent(this.symbol)}`);
    this.ws = ws;
    ws.onopen = () => {
      this.delay = 1000;
      window.clearInterval(this.pingTimer);
      this.pingTimer = window.setInterval(() => ws.readyState === WebSocket.OPEN && ws.send("ping"), 25000);
    };
    ws.onmessage = (e) => {
      try {
        this.onMessage(JSON.parse(e.data) as LiveMessage);
      } catch {
        /* ignore malformed frames */
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return; // replaced by open() / close()
      window.clearInterval(this.pingTimer);
      this.ws = null;
      this.onMessage({ type: "status", state: "offline", detail: "Lost connection to the local server; retrying…" });
      this.retryTimer = window.setTimeout(() => this.connect(), this.delay);
      this.delay = Math.min(this.delay * 2, 15000);
    };
  }
}

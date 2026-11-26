import undici, { CloseEvent, MessageEvent } from "undici/index.js";

type LocalSlack = {
  readonly url: string;
  readonly fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  readonly connected: (receive: (frame: unknown) => void) => void;
  readonly acknowledged: (envelopeId: string) => void;
};

/** Replace the SDK's lowest-level socket in CLI subprocesses so we can exit inside send(). */
export function installLocalSlack(slack: LocalSlack) {
  class Peer extends EventTarget {
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readyState = 0;

    constructor(endpoint: string) {
      super();
      if (endpoint !== slack.url) throw new Error("Unexpected fixture WebSocket URL");
      setImmediate(() => {
        this.readyState = Peer.OPEN;
        this.dispatchEvent(new Event("open"));
        slack.connected(frame => {
          if (this.readyState === Peer.OPEN) {
            this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(frame) }));
          }
        });
      });
    }

    send(frame: string) {
      const { envelope_id: id } = JSON.parse(frame);
      if (typeof id !== "string" || !id) throw new Error("Missing envelope ID in ACK");
      slack.acknowledged(id);
    }

    close() {
      this.readyState = Peer.CLOSING;
      queueMicrotask(() => {
        this.readyState = Peer.CLOSED;
        this.dispatchEvent(new CloseEvent("close", { code: 1000 }));
      });
    }
  }

  // Only the CLI fixture subprocess sees this socket. The wire suite uses the
  // real npm undici implementation against a TLS peer.
  Object.defineProperty(undici, "WebSocket", { value: Peer });
  Object.defineProperty(globalThis, "fetch", { value: slack.fetch });
}

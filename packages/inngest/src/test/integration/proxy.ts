import {
  createServer as createNetServer,
  type Server as NetServer,
  type Socket,
  connect as tcpConnect,
} from "node:net";
import { DEV_SERVER_PORT } from "@inngest/test-harness";

// The dev server's Connect WebSocket gateway runs on the port after the API.
const GATEWAY_WS_PORT = DEV_SERVER_PORT + 1;

/**
 * Parse WebSocket frames from a raw byte stream and extract binary payloads.
 * Only handles non-fragmented binary frames (opcode 0x02), which is all
 * the Connect protocol uses.
 */
class WsFrameParser {
  private buffer = Buffer.alloc(0);
  private onFrame: (payload: Uint8Array) => void;

  constructor(onFrame: (payload: Uint8Array) => void) {
    this.onFrame = onFrame;
  }

  push(data: Buffer) {
    this.buffer = Buffer.concat([this.buffer, data]);
    this.drain();
  }

  private drain() {
    while (this.buffer.length >= 2) {
      const byte0 = this.buffer[0]!;
      const byte1 = this.buffer[1]!;
      const masked = (byte1 & 0x80) !== 0;
      let payloadLen = byte1 & 0x7f;
      let offset = 2;

      if (payloadLen === 126) {
        if (this.buffer.length < 4) {
          return;
        }
        payloadLen = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (this.buffer.length < 10) {
          return;
        }
        payloadLen = Number(this.buffer.readBigUInt64BE(2));
        offset = 10;
      }

      const maskSize = masked ? 4 : 0;
      const totalLen = offset + maskSize + payloadLen;
      if (this.buffer.length < totalLen) {
        return;
      }

      const opcode = byte0 & 0x0f;

      // Binary frame
      if (opcode === 0x02) {
        const payloadStart = offset + maskSize;
        const raw = this.buffer.subarray(
          payloadStart,
          payloadStart + payloadLen,
        );
        let payload: Buffer;

        if (masked) {
          const maskKey = this.buffer.subarray(offset, offset + 4);
          payload = Buffer.from(raw);
          for (let i = 0; i < payload.length; i++) {
            payload[i] = payload[i]! ^ maskKey[i % 4]!;
          }
        } else {
          payload = Buffer.from(raw);
        }

        this.onFrame(new Uint8Array(payload));
      }

      this.buffer = this.buffer.subarray(totalLen);
    }
  }
}

/**
 * Transparent TCP proxy for WebSocket connections.
 *
 * Forwards raw bytes between a client and an upstream server. After the HTTP
 * upgrade handshake completes, binary WebSocket frames sent by the client
 * (worker → gateway) are decoded and recorded so tests can assert on message
 * types.
 */
export class WebSocketProxy {
  private server: NetServer;
  private sockets: Set<Socket> = new Set();
  private _url: string | undefined;
  readonly forwardedClientMessages: Uint8Array[] = [];

  constructor() {
    this.server = createNetServer((clientSocket) => {
      this.sockets.add(clientSocket);
      const upstreamSocket = tcpConnect(GATEWAY_WS_PORT, "127.0.0.1");
      this.sockets.add(upstreamSocket);

      let handshakeComplete = false;
      let responseBuffer = Buffer.alloc(0);
      const parser = new WsFrameParser((payload) => {
        this.forwardedClientMessages.push(payload);
      });

      // Client → upstream: forward all data; parse WS frames once the
      // HTTP upgrade handshake is done.
      clientSocket.on("data", (data) => {
        upstreamSocket.write(data);
        if (handshakeComplete) {
          parser.push(data);
        }
      });

      // Upstream → client: forward all data; detect end of HTTP response
      // headers to know when WebSocket framing begins.
      upstreamSocket.on("data", (data) => {
        clientSocket.write(data);
        if (!handshakeComplete) {
          responseBuffer = Buffer.concat([responseBuffer, data]);
          if (responseBuffer.includes("\r\n\r\n")) {
            handshakeComplete = true;
          }
        }
      });

      clientSocket.on("close", () => {
        this.sockets.delete(clientSocket);
        upstreamSocket.destroy();
      });
      upstreamSocket.on("close", () => {
        this.sockets.delete(upstreamSocket);
        clientSocket.destroy();
      });
      clientSocket.on("error", () => upstreamSocket.destroy());
      upstreamSocket.on("error", () => clientSocket.destroy());
    });
  }

  /**
   * The `ws://` URL that clients should connect to. Only available after
   * {@link start} resolves.
   */
  get url(): string {
    if (!this._url) {
      throw new Error("WebSocketProxy not started");
    }
    return this._url;
  }

  async start(): Promise<void> {
    return this.listen(0);
  }

  async listen(port: number): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(port, "127.0.0.1", () => {
        const addr = this.server.address();
        if (typeof addr === "string" || addr === null) {
          throw new Error("Unreachable");
        }

        this._url = `ws://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) {
      socket.destroy();
    }
    this.sockets.clear();
    return new Promise((resolve) => {
      this.server.close(() => resolve());
    });
  }
}

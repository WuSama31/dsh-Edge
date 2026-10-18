/**
 * Minimal RFC 6455 WebSocket client for the Chrome DevTools Protocol.
 *
 * The DSH host runs as an Electron main process; we cannot rely on a bundler
 * or on a published `ws` package resolving from this bundle's directory, so
 * the handshake and framing live here (client frames masked, server frames
 * plain, fragmented text messages reassembled).
 */
import { createHash, randomBytes } from 'node:crypto';
import { request } from 'node:http';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const OPCODE_CONTINUATION = 0x0;
const OPCODE_TEXT = 0x1;
const OPCODE_BINARY = 0x2;
const OPCODE_CLOSE = 0x8;
const OPCODE_PING = 0x9;
const OPCODE_PONG = 0xa;

/**
 * Encode one masked client frame.
 * @param {number} opcode
 * @param {Buffer | string} payload
 * @returns {Buffer}
 */
function encodeFrame(opcode, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
  const mask = randomBytes(4);
  const length = data.length;
  let header;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
    header.writeUInt32BE(Math.floor(length / 0x100000000), 2);
    header.writeUInt32BE(length >>> 0, 6);
  }
  header[0] = 0x80 | opcode;
  const masked = Buffer.alloc(length);
  for (let index = 0; index < length; index += 1) masked[index] = data[index] ^ mask[index & 3];
  return Buffer.concat([header, mask, masked]);
}

export class WebSocketClient {
  #socket;
  #buffer;
  #closed = false;
  #fragments = [];
  #fragmentOpcode = 0;
  #handlers = new Map();
  /** @param {import('node:net').Socket} socket @param {Buffer | undefined} head */
  constructor(socket, head) {
    this.#socket = socket;
    this.#buffer = head !== undefined && head.length > 0 ? Buffer.from(head) : Buffer.alloc(0);
    socket.setNoDelay(true);
    socket.on('data', (chunk) => this.#onData(chunk));
    socket.on('close', () => this.#fail(new Error('CDP WebSocket closed')));
    socket.on('error', (error) => this.#fail(error instanceof Error ? error : new Error(String(error))));
    if (this.#buffer.length > 0) this.#drain();
  }

  /**
   * Open a WebSocket to `url` (ws://host:port/path).
   * @param {string} url
   * @param {number} timeoutMs
   * @returns {Promise<WebSocketClient>}
   */
  static connect(url, timeoutMs = 10_000) {
    const target = new URL(url);
    const key = randomBytes(16).toString('base64');
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      const req = request({
        host: target.hostname,
        port: target.port === '' ? 80 : Number(target.port),
        path: `${target.pathname}${target.search}`,
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Key': key,
          'Sec-WebSocket-Version': '13',
        },
      });
      req.setTimeout(timeoutMs, () => req.destroy(new Error(`WebSocket handshake to ${target.host} timed out`)));
      req.on('error', fail);
      req.on('response', (response) => {
        response.resume();
        fail(new Error(`WebSocket handshake rejected with HTTP ${response.statusCode}`));
      });
      req.on('upgrade', (response, socket, head) => {
        const accept = response.headers['sec-websocket-accept'];
        const expected = createHash('sha1').update(`${key}${GUID}`).digest('base64');
        if (accept !== expected) {
          socket.destroy();
          fail(new Error('WebSocket handshake failed: unexpected Sec-WebSocket-Accept'));
          return;
        }
        if (settled) {
          socket.destroy();
          return;
        }
        settled = true;
        resolve(new WebSocketClient(socket, head));
      });
      req.end();
    });
  }

  /** @param {'message' | 'close'} event @param {(payload: unknown) => void} handler */
  on(event, handler) {
    const list = this.#handlers.get(event);
    if (list === undefined) this.#handlers.set(event, [handler]);
    else list.push(handler);
  }

  get closed() {
    return this.#closed;
  }

  /** @param {string} text */
  send(text) {
    if (this.#closed) throw new Error('CDP WebSocket is closed');
    this.#socket.write(encodeFrame(OPCODE_TEXT, text));
  }

  /** @param {number} code @param {string} reason */
  close(code = 1000, reason = '') {
    if (this.#closed) return;
    const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
    payload.writeUInt16BE(code, 0);
    payload.write(reason, 2, 'utf8');
    try {
      this.#socket.write(encodeFrame(OPCODE_CLOSE, payload));
    } catch {}
    this.#socket.end();
    this.#fail(new Error('CDP WebSocket closed by client'));
  }

  #emit(event, payload) {
    for (const handler of this.#handlers.get(event) ?? []) {
      try {
        handler(payload);
      } catch {}
    }
  }

  #fail(error) {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#socket.destroy();
    } catch {}
    this.#emit('close', error);
  }

  /** @param {Buffer} chunk */
  #onData(chunk) {
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
    this.#drain();
  }

  #drain() {
    for (;;) {
      const buffer = this.#buffer;
      if (buffer.length < 2) return;
      const fin = (buffer[0] & 0x80) !== 0;
      const opcode = buffer[0] & 0x0f;
      const masked = (buffer[1] & 0x80) !== 0;
      let length = buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        length = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }
      let maskKey;
      if (masked) {
        if (buffer.length < offset + 4) return;
        maskKey = buffer.subarray(offset, offset + 4);
        offset += 4;
      }
      if (buffer.length < offset + length) return;
      let payload = buffer.subarray(offset, offset + length);
      this.#buffer = buffer.subarray(offset + length);
      if (maskKey !== undefined) {
        const unmasked = Buffer.alloc(length);
        for (let index = 0; index < length; index += 1) unmasked[index] = payload[index] ^ maskKey[index & 3];
        payload = unmasked;
      }
      this.#frame(fin, opcode, payload);
      if (this.#closed) return;
    }
  }

  #frame(fin, opcode, payload) {
    if (opcode === OPCODE_PING) {
      try {
        this.#socket.write(encodeFrame(OPCODE_PONG, payload));
      } catch {}
      return;
    }
    if (opcode === OPCODE_PONG) return;
    if (opcode === OPCODE_CLOSE) {
      this.close(1000, '');
      return;
    }
    if (opcode === OPCODE_CONTINUATION) {
      this.#fragments.push(payload);
      if (fin) {
        const message = Buffer.concat(this.#fragments);
        this.#fragments = [];
        this.#emitMessage(this.#fragmentOpcode, message);
      }
      return;
    }
    if (opcode === OPCODE_TEXT || opcode === OPCODE_BINARY) {
      if (!fin) {
        this.#fragments = [payload];
        this.#fragmentOpcode = opcode;
        return;
      }
      this.#emitMessage(opcode, payload);
    }
  }

  #emitMessage(opcode, payload) {
    if (opcode !== OPCODE_TEXT) return;
    let parsed;
    try {
      parsed = JSON.parse(payload.toString('utf8'));
    } catch {
      return;
    }
    this.#emit('message', parsed);
  }
}

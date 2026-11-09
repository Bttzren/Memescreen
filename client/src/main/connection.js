'use strict';

const { EventEmitter } = require('node:events');
const WebSocket = require('ws');
const { DEFAULT_LIMITS } = require('../shared/validate');

const REQUEST_TIMEOUT_MS = 20_000;
const DEAD_CONNECTION_MS = 75_000; // server pings every 30 s
const FATAL_JOIN_ERRORS = new Set(['bad_room', 'bad_nickname', 'room_full']);

/**
 * Keeps one WebSocket to the relay alive: joins the room, reconnects with
 * backoff when Wi-Fi blips, and matches replies to requests.
 *
 * Events:
 *   'state'  (state)  – whenever status / peers / room change
 *   'drop'   (drop)   – a friend dropped something on us
 */
class Connection extends EventEmitter {
  constructor({ WebSocketImpl = WebSocket } = {}) {
    super();
    this.WebSocketImpl = WebSocketImpl;
    this.ws = null;
    this.target = null; // { url, room, nickname }
    this.wantConnected = false;
    this.retry = 0;
    this.retryTimer = null;
    this.deadTimer = null;
    this.nextRef = 1;
    this.pending = new Map(); // ref/reqId -> { resolve, reject, timer, expects }
    this.state = {
      status: 'disconnected', // disconnected | connecting | connected | reconnecting
      url: null,
      room: null,
      nickname: null,
      selfId: null,
      peers: [],
      features: { giphy: false },
      limits: { ...DEFAULT_LIMITS },
      error: null,
    };
  }

  setState(patch) {
    this.state = { ...this.state, ...patch };
    this.emit('state', this.state);
  }

  connect({ url, room, nickname }) {
    this.disconnect({ silent: true });
    this.target = { url, room, nickname };
    this.wantConnected = true;
    this.retry = 0;
    this.setState({ status: 'connecting', url, room, nickname, error: null, peers: [], selfId: null });
    this.open();
  }

  disconnect({ silent = false } = {}) {
    this.wantConnected = false;
    clearTimeout(this.retryTimer);
    clearTimeout(this.deadTimer);
    this.retryTimer = null;
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      ws.removeAllListeners();
      ws.on('error', () => {});
      try {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'leave' }));
        ws.close();
      } catch {
        ws.terminate();
      }
    }
    this.failAllPending('Disconnected.');
    if (!silent) this.setState({ status: 'disconnected', peers: [], selfId: null, error: null });
  }

  open() {
    const { url } = this.target;
    let ws;
    try {
      ws = new this.WebSocketImpl(url, { handshakeTimeout: 10_000, maxPayload: 64 * 1024 * 1024 });
    } catch (err) {
      this.wantConnected = false;
      this.setState({ status: 'disconnected', error: `Bad server address: ${err.message}` });
      return;
    }
    this.ws = ws;

    ws.on('open', () => {
      this.armDeadTimer();
      ws.send(JSON.stringify({ type: 'join', room: this.target.room, nickname: this.target.nickname }));
    });
    ws.on('ping', () => this.armDeadTimer());
    ws.on('message', (raw) => {
      this.armDeadTimer();
      let msg;
      try {
        msg = JSON.parse(raw.toString('utf8'));
      } catch {
        return;
      }
      this.handleMessage(msg);
    });
    ws.on('error', (err) => {
      this.lastSocketError = friendlySocketError(err);
    });
    ws.on('close', (code) => {
      if (this.ws !== ws) return; // superseded
      this.ws = null;
      clearTimeout(this.deadTimer);
      this.failAllPending(code === 1009 ? 'That was too big for the server.' : 'Lost connection to the server.');
      if (!this.wantConnected) {
        this.setState({ status: 'disconnected', peers: [], selfId: null });
        return;
      }
      this.scheduleReconnect(this.lastSocketError);
      this.lastSocketError = null;
    });
  }

  /** After sleep/resume: skip the backoff wait if we're between retries. */
  reconnectNow() {
    if (!this.wantConnected || this.ws || this.state.status !== 'reconnecting') return;
    clearTimeout(this.retryTimer);
    this.retry = 0;
    this.open();
  }

  armDeadTimer() {
    clearTimeout(this.deadTimer);
    this.deadTimer = setTimeout(() => {
      if (this.ws) this.ws.terminate();
    }, DEAD_CONNECTION_MS);
  }

  scheduleReconnect(reason) {
    const delay = Math.min(15_000, 1000 * 2 ** this.retry) + Math.floor(Math.random() * 400);
    this.retry += 1;
    this.setState({
      status: 'reconnecting',
      peers: [],
      error: reason ? `${reason} Retrying in ${Math.round(delay / 1000)}s…` : `Reconnecting in ${Math.round(delay / 1000)}s…`,
    });
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      if (this.wantConnected) this.open();
    }, delay);
  }

  handleMessage(msg) {
    switch (msg.type) {
      case 'welcome':
        this.retry = 0;
        this.setState({
          status: 'connected',
          room: msg.room,
          nickname: msg.nickname,
          selfId: msg.id,
          peers: Array.isArray(msg.peers) ? msg.peers : [],
          features: { giphy: Boolean(msg.features && msg.features.giphy) },
          limits: { ...DEFAULT_LIMITS, ...(msg.limits || {}) },
          error: null,
        });
        break;
      case 'roster':
        this.setState({ peers: Array.isArray(msg.peers) ? msg.peers : [] });
        break;
      case 'features':
        this.setState({ features: { giphy: Boolean(msg.features && msg.features.giphy) } });
        break;
      case 'drop':
        this.emit('drop', msg);
        break;
      case 'reaction':
        this.emit('reaction', msg);
        break;
      case 'drop-sent':
        this.settle(msg.ref, msg);
        break;
      case 'gif-results':
        this.settle(msg.reqId, msg);
        break;
      case 'error': {
        const key = msg.ref !== undefined ? msg.ref : msg.reqId;
        if (key !== undefined && this.pending.has(key)) {
          this.settle(key, null, msg);
        } else if (FATAL_JOIN_ERRORS.has(msg.code) && this.state.status !== 'connected') {
          // Wrong room code / nickname: retrying won't help.
          this.disconnect({ silent: true });
          this.setState({ status: 'disconnected', error: msg.message });
        } else {
          this.emit('server-error', msg);
        }
        break;
      }
      default:
        break;
    }
  }

  /** Fire-and-forget (reactions). Returns false when not connected. */
  send(message) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this.state.status !== 'connected') return false;
    try {
      this.ws.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  /** Send a message and wait for the reply carrying the same ref/reqId. */
  request(message, { idField = 'ref', timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this.state.status !== 'connected') {
      return Promise.reject(new Error('Not connected to the server.'));
    }
    const id = this.nextRef++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('The server took too long to answer.'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify({ ...message, [idField]: id }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  settle(id, value, error) {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    clearTimeout(p.timer);
    if (error) {
      const err = new Error(error.message || 'Something went wrong.');
      err.code = error.code;
      p.reject(err);
    } else {
      p.resolve(value);
    }
  }

  failAllPending(message) {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(message));
      this.pending.delete(id);
    }
  }
}

function friendlySocketError(err) {
  const code = err && err.code;
  if (code === 'ECONNREFUSED') return "Can't reach the server (is it running?).";
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return "Can't find that server address.";
  if (code === 'ETIMEDOUT' || /timed out/i.test(err && err.message)) return 'The server is not answering.';
  if (/Unexpected server response/i.test(err && err.message)) return "That address isn't a MemeDrop server.";
  return err && err.message ? `${err.message}.` : 'Connection problem.';
}

module.exports = { Connection, friendlySocketError };

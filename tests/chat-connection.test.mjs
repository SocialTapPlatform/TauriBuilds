import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../src-tauri/src/chat-connection.js', import.meta.url), 'utf8');
function fixture(origin = 'https://socialtap.social') {
  const listeners = new Map();
  const timers = new Set();
  const window = {
    location: { origin },
    addEventListener(event, fn) {
      const callbacks = listeners.get(event) || [];
      callbacks.push(fn);
      listeners.set(event, callbacks);
    },
    setInterval(fn) { timers.add(fn); return fn; },
    clearInterval(fn) { timers.delete(fn); }
  };
  window.top = window;
  let now = 0;
  const navigator = { onLine: true };
  runInNewContext(source, { window, navigator, document: window, Date: { now: () => now } });
  let closes = 0;
  let connects = 0;
  const requests = [];
  const settings = {};
  const manager = { engine: { close() { closes++; } } };
  for (const name of ['reconnection', 'reconnectionAttempts', 'reconnectionDelay', 'reconnectionDelayMax']) {
    manager[name] = value => { settings[name] = value; };
  }
  const socket = {
    io: manager, connected: false, active: false,
    connect() { connects++; },
    timeout(ms) { assert.equal(ms, 10000); return this; },
    emit(event, data, ack) { requests.push({ event, data, ack }); }
  };
  const factory = () => socket;
  factory.Manager = manager;
  factory.connect = factory;
  factory.io = factory;
  window.io = factory;
  window.io({ autoConnect: false });
  return { window, navigator, socket, manager, settings, requests, timers,
    advance: ms => { now += ms; },
    event: (name, event = {}) => { for (const fn of listeners.get(name) || []) fn(event); },
    get closes() { return closes; }, get connects() { return connects; } };
}

test('installs before io loads, preserves aliases/exports and autoConnect:false', () => {
  const f = fixture();
  assert.equal(f.window.io.Manager, f.manager);
  assert.equal(f.window.io.connect, f.window.io);
  assert.equal(f.window.io.io, f.window.io);
  assert.equal(f.settings.reconnectionAttempts, Infinity);
  f.event('socialtap:connection-check');
  assert.equal(f.connects, 0);
  assert.equal(f.requests.length, 0);
  assert.equal(f.timers.size, 1);
  f.window.io.connect();
  assert.equal(f.timers.size, 1);
});

test('healthy idle connection stays open and overlapping checks do not accumulate', () => {
  const f = fixture(); f.socket.connected = true;
  f.event('socialtap:connection-check'); f.event('focus');
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].event, 'notifications:get');
  f.requests[0].ack(null, { status: 200 });
  f.event('socialtap:connection-check');
  assert.equal(f.requests.length, 2);
  assert.equal(f.closes, 0);
});

test('unacknowledged connection closes transport to trigger normal catch-up reconnect', () => {
  const f = fixture(); f.socket.connected = true;
  f.event('socialtap:connection-check');
  f.requests[0].ack(new Error('timeout'));
  assert.equal(f.closes, 1);
});

test('late timeout from previous connection cannot close the new engine', () => {
  const f = fixture(); f.socket.connected = true;
  f.event('socialtap:connection-check');
  f.manager.engine = { close() { throw Error('new connection closed'); } };
  f.requests[0].ack(new Error('timeout'));
  assert.equal(f.closes, 0);
});

test('network restoration reconnects active sockets but respects logout/auth rejection', () => {
  const f = fixture(); f.socket.active = true; f.navigator.onLine = false;
  f.event('socialtap:connection-check'); assert.equal(f.connects, 0);
  f.navigator.onLine = true; f.event('online'); assert.equal(f.connects, 1);
  f.socket.active = false; f.event('focus'); assert.equal(f.connects, 1);
});

test('navigation stops checks and pending acknowledgements cannot reopen transport', () => {
  const f = fixture(); f.socket.connected = true;
  f.event('focus'); f.event('pagehide');
  f.requests[0].ack(new Error('timeout'));
  f.event('socialtap:connection-check');
  assert.equal(f.closes, 0); assert.equal(f.requests.length, 1);
  assert.equal(f.timers.size, 0);
});

test('other origins are untouched', () => {
  const f = fixture('https://example.com');
  assert.equal(f.timers.size, 0);
  assert.equal(f.settings.reconnection, undefined);
});


test('native tick detects a dead connection even if JS acknowledgement timeout was throttled', () => {
  const f = fixture(); f.socket.connected = true;
  f.event('socialtap:connection-check');
  f.advance(25000);
  f.event('socialtap:connection-check');
  assert.equal(f.closes, 1);
  f.requests[0].ack(new Error('late timeout'));
  assert.equal(f.closes, 1);
});

test('restoring a cached document restarts supervision', () => {
  const f = fixture(); f.socket.connected = true;
  f.event('pagehide');
  f.event('pageshow', { persisted: true });
  assert.equal(f.timers.size, 1);
  assert.equal(f.requests.length, 1);
});

// Installed before the hosted site's scripts, on every navigation.
(() => {
  if (window.location.origin !== 'https://socialtap.social' || window.top !== window) return;

  const sockets = new Set();
  let leaving = false;

  function supervise(socket) {
    if (sockets.has(socket)) return socket;
    sockets.add(socket);
    const manager = socket.io;
    manager.reconnection(true);
    manager.reconnectionAttempts(Infinity);
    manager.reconnectionDelay(1000);
    manager.reconnectionDelayMax(10000);

    let pending = null;
    function check() {
      if (leaving || !navigator.onLine) return;
      // active is false after an explicit disconnect or an authentication rejection.
      if (!socket.connected) {
        if (socket.active) socket.connect();
        return;
      }
      if (pending) {
        if (Date.now() < pending.deadline) return;
        const expired = pending;
        pending = null;
        if (manager.engine === expired.engine) {
          expired.engine.close();
          return;
        }
      }
      const probe = { engine: manager.engine, deadline: Date.now() + 10000 };
      pending = probe;
      // The high message cursor avoids loading history for this health probe.
      // An acknowledged, read-only request keeps idle connections busy and detects
      // half-open transports. Never replay message sends (they could duplicate).
      socket.timeout(10000).emit('notifications:get', { since: 2147483647 }, (error) => {
        if (pending !== probe) return;
        pending = null;
        if (error && !leaving && socket.connected && manager.engine === probe.engine) {
          // Closing the transport lets Socket.IO reconnect and the site's connect
          // handler catch up messages and notifications using its existing cursors.
          probe.engine.close();
        }
      });
    }
    let timer = window.setInterval(check, 25000);
    window.addEventListener('socialtap:connection-check', check);
    window.addEventListener('online', check);
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', check);
    window.addEventListener('pagehide', () => {
      leaving = true;
      window.clearInterval(timer);
    });
    window.addEventListener('pageshow', event => {
      if (!event.persisted) return;
      leaving = false;
      timer = window.setInterval(check, 25000);
      check();
    });
    return socket;
  }

  // The website loads Socket.IO's UMD bundle. Intercept its global assignment
  // before it creates chatSocket; preserve io's exports and io.connect alias.
  let factory;
  function wrap(value) {
    if (typeof value !== 'function') return value;
    let proxy;
    proxy = new Proxy(value, {
      apply(target, receiver, args) {
        return supervise(Reflect.apply(target, receiver, args));
      },
      get(target, property, receiver) {
        if (property === 'connect' || property === 'io') return proxy;
        return Reflect.get(target, property, receiver);
      }
    });
    return proxy;
  }
  factory = wrap(window.io);
  Object.defineProperty(window, 'io', {
    configurable: true,
    enumerable: true,
    get: () => factory,
    set: value => { factory = wrap(value); }
  });
})();

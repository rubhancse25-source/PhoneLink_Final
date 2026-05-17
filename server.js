/**
 * PhoneLink – Server
 * Express + Socket.io backend with WebRTC signaling, session management,
 * QR code generation, and optional native input injection via nut-js.
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const os = require('os');
const crypto = require('crypto');
const path = require('path');

// ── Optional nut-js ──────────────────────────────────────────────────
let nutAvailable = false;
let keyboard, mouse, Key, Button, straightTo, Point;
try {
  const nut = require('@nut-tree-fork/nut-js');
  keyboard = nut.keyboard;
  mouse = nut.mouse;
  Key = nut.Key;
  Button = nut.Button;
  straightTo = nut.straightTo;
  Point = nut.Point;
  nutAvailable = true;
  console.log('[ok] nut-js loaded - native input injection available');
} catch (e) {
  console.warn('[warn] nut-js not found - input will be forwarded to dashboard only');
}

// ── Express + Socket.io Setup ────────────────────────────────────────
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  transports: ['websocket'],          // websocket-only for lowest latency
  allowUpgrades: false,
  pingInterval: 3000,
  pingTimeout: 8000,
  maxHttpBufferSize: 1e6,             // 1 MB for whiteboard payloads
  serveClient: true
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ── Session Management ───────────────────────────────────────────────
const sessions = new Map();
const SESSION_TIMEOUT = 5 * 60 * 1000; // 5 minutes without heartbeat

function generateSessionId() {
  return crypto.randomBytes(4).toString('hex').toUpperCase();
}

function createSession() {
  const id = generateSessionId();
  const session = {
    id,
    laptopSocket: null,
    phoneSocket: null,
    createdAt: Date.now(),
    lastHeartbeat: Date.now(),
    mode: 'presentation',
    theme: 'dark',
    rtcConnected: false
  };
  sessions.set(id, session);
  return session;
}

// Cleanup stale sessions every 30 seconds
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.lastHeartbeat > SESSION_TIMEOUT) {
      console.log(`[cleanup] Cleaning up stale session: ${id}`);
      if (session.laptopSocket) session.laptopSocket.emit('session-expired');
      if (session.phoneSocket) session.phoneSocket.emit('session-expired');
      sessions.delete(id);
    }
  }
}, 30000);

// ── REST API ─────────────────────────────────────────────────────────
function getLocalIP() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return 'localhost';
}

app.get('/api/session/create', (req, res) => {
  const session = createSession();
  res.json({ sessionId: session.id });
});

app.get('/api/qr/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const ip = getLocalIP();
  const port = process.env.PORT || 3000;
  const url = `http://${ip}:${port}/controller.html?session=${sessionId}`;

  try {
    const qrDataUrl = await QRCode.toDataURL(url, {
      width: 300,
      margin: 2,
      color: { dark: '#ffffff', light: '#00000000' }
    });
    res.json({ qr: qrDataUrl, url, sessionId, ip, port });
  } catch (err) {
    res.status(500).json({ error: 'QR generation failed' });
  }
});

app.get('/api/qr-url/:sessionId/:mode', async (req, res) => {
  const { sessionId, mode } = req.params;
  const session = sessions.get(sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const ip = getLocalIP();
  const port = process.env.PORT || 3000;
  const normalizedMode = mode === 'keyboard-builder' ? 'builder' : mode;
  const controllerModes = new Set(['mobile', 'controller', 'home', 'presentation', 'media', 'keyboard', 'whiteboard', 'builder']);
  const targetMode = controllerModes.has(normalizedMode) ? normalizedMode : 'home';
  const modeParam = ['mobile', 'controller', 'home'].includes(targetMode) ? '' : `&mode=${targetMode}`;
  const url = `http://${ip}:${port}/controller.html?session=${sessionId}${modeParam}`;

  try {
    const qrDataUrl = await QRCode.toDataURL(url, {
      width: 300,
      margin: 2,
      color: { dark: '#ffffff', light: '#00000000' }
    });
    res.json({ qr: qrDataUrl, url, sessionId });
  } catch (err) {
    res.status(500).json({ error: 'QR generation failed' });
  }
});

app.get('/api/nut-status', (req, res) => {
  res.json({ available: nutAvailable });
});

// ── Key Mapping for nut-js ───────────────────────────────────────────
const keyMap = {
  'ArrowRight': 'Right',
  'ArrowLeft': 'Left',
  'ArrowUp': 'Up',
  'ArrowDown': 'Down',
  'Space': 'Space',
  'Enter': 'Return',
  'Escape': 'Escape',
  'Backspace': 'Backspace',
  'Tab': 'Tab',
  'Delete': 'Delete',
  'CapsLock': 'CapsLock',
  'ShiftLeft': 'LeftShift',
  'ShiftRight': 'RightShift',
  'ControlLeft': 'LeftControl',
  'ControlRight': 'RightControl',
  'AltLeft': 'LeftAlt',
  'AltRight': 'RightAlt',
  'MetaLeft': 'LeftSuper',
  'MetaRight': 'RightSuper',
  'F1': 'F1', 'F2': 'F2', 'F3': 'F3', 'F4': 'F4',
  'F5': 'F5', 'F6': 'F6', 'F7': 'F7', 'F8': 'F8',
  'F9': 'F9', 'F10': 'F10', 'F11': 'F11', 'F12': 'F12',
  'MediaPlayPause': 'AudioPlay',
  'MediaNextTrack': 'AudioNext',
  'MediaPrevTrack': 'AudioPrev',
  'AudioVolumeUp': 'AudioVolUp',
  'AudioVolumeDown': 'AudioVolDown',
  'AudioVolumeMute': 'AudioMute',
  'KeyA': 'A', 'KeyB': 'B', 'KeyC': 'C', 'KeyD': 'D',
  'KeyE': 'E', 'KeyF': 'F', 'KeyG': 'G', 'KeyH': 'H',
  'KeyI': 'I', 'KeyJ': 'J', 'KeyK': 'K', 'KeyL': 'L',
  'KeyM': 'M', 'KeyN': 'N', 'KeyO': 'O', 'KeyP': 'P',
  'KeyQ': 'Q', 'KeyR': 'R', 'KeyS': 'S', 'KeyT': 'T',
  'KeyU': 'U', 'KeyV': 'V', 'KeyW': 'W', 'KeyX': 'X',
  'KeyY': 'Y', 'KeyZ': 'Z',
  'Digit0': 'Num0', 'Digit1': 'Num1', 'Digit2': 'Num2',
  'Digit3': 'Num3', 'Digit4': 'Num4', 'Digit5': 'Num5',
  'Digit6': 'Num6', 'Digit7': 'Num7', 'Digit8': 'Num8',
  'Digit9': 'Num9'
};

async function injectKey(keyCode, modifiers = []) {
  if (!nutAvailable) return false;
  try {
    const nutKey = keyMap[keyCode];
    if (!nutKey || typeof Key[nutKey] === 'undefined') return false;

    const mods = modifiers
      .map(m => keyMap[m])
      .filter(m => m && typeof Key[m] !== 'undefined')
      .map(m => Key[m]);

    if (mods.length > 0) {
      await keyboard.pressKey(...mods);
      await keyboard.pressKey(Key[nutKey]);
      await keyboard.releaseKey(Key[nutKey]);
      await keyboard.releaseKey(...mods);
    } else {
      await keyboard.pressKey(Key[nutKey]);
      await keyboard.releaseKey(Key[nutKey]);
    }
    return true;
  } catch (err) {
    console.error('Key injection error:', err.message);
    return false;
  }
}

async function injectMouseMove(dx, dy) {
  if (!nutAvailable) return false;
  try {
    const pos = await mouse.getPosition();
    await mouse.setPosition(new Point(pos.x + dx, pos.y + dy));
    return true;
  } catch (err) {
    return false;
  }
}

async function injectMouseClick(button = 'left') {
  if (!nutAvailable) return false;
  try {
    const btn = button === 'right' ? Button.RIGHT : button === 'middle' ? Button.MIDDLE : Button.LEFT;
    await mouse.click(btn);
    return true;
  } catch (err) {
    return false;
  }
}

async function injectMouseScroll(dx, dy) {
  if (!nutAvailable) return false;
  try {
    const amount = Math.max(1, Math.round(Math.abs(dy)));
    if (dy > 0) await mouse.scrollDown(amount);
    else if (dy < 0) await mouse.scrollUp(amount);
    return true;
  } catch (err) {
    return false;
  }
}

async function injectText(text) {
  if (!nutAvailable) return false;
  try {
    await keyboard.type(text);
    return true;
  } catch (err) {
    return false;
  }
}

// ── Socket.io ────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[socket] Connected: ${socket.id}`);

  // ── Laptop joins session ──
  socket.on('laptop-join', (sessionId) => {
    const session = sessions.get(sessionId);
    if (!session) {
      socket.emit('error-msg', 'Session not found');
      return;
    }
    session.laptopSocket = socket;
    session.lastHeartbeat = Date.now();
    socket.join(`session-${sessionId}`);
    socket.sessionId = sessionId;
    socket.role = 'laptop';
    socket.emit('joined', { sessionId, role: 'laptop' });
    console.log(`[laptop] Joined session: ${sessionId}`);

    // Notify phone if already connected
    if (session.phoneSocket) {
      session.phoneSocket.emit('peer-connected', { role: 'laptop' });
      socket.emit('peer-connected', { role: 'phone' });
    }
  });

  // ── Phone joins session ──
  socket.on('phone-join', (sessionId) => {
    const session = sessions.get(sessionId);
    if (!session) {
      socket.emit('error-msg', 'Invalid session ID');
      return;
    }
    session.phoneSocket = socket;
    session.lastHeartbeat = Date.now();
    socket.join(`session-${sessionId}`);
    socket.sessionId = sessionId;
    socket.role = 'phone';
    socket.emit('joined', { sessionId, role: 'phone', theme: session.theme });
    console.log(`[phone] Joined session: ${sessionId}`);

    // Notify laptop
    if (session.laptopSocket) {
      session.laptopSocket.emit('peer-connected', { role: 'phone' });
      socket.emit('peer-connected', { role: 'laptop' });
    }
  });

  // ── Heartbeat ──
  socket.on('heartbeat', () => {
    if (socket.sessionId) {
      const session = sessions.get(socket.sessionId);
      if (session) {
        session.lastHeartbeat = Date.now();
        socket.emit('heartbeat-ack', { ts: Date.now() });
      }
    }
  });

  // ── WebRTC Signaling ──
  socket.on('rtc-offer', (data) => {
    const session = sessions.get(socket.sessionId);
    if (session) {
      const target = socket.role === 'phone' ? session.laptopSocket : session.phoneSocket;
      if (target) target.emit('rtc-offer', data);
    }
  });

  socket.on('rtc-answer', (data) => {
    const session = sessions.get(socket.sessionId);
    if (session) {
      const target = socket.role === 'phone' ? session.laptopSocket : session.phoneSocket;
      if (target) target.emit('rtc-answer', data);
    }
  });

  socket.on('rtc-ice', (data) => {
    const session = sessions.get(socket.sessionId);
    if (session) {
      const target = socket.role === 'phone' ? session.laptopSocket : session.phoneSocket;
      if (target) target.emit('rtc-ice', data);
    }
  });

  socket.on('rtc-connected', () => {
    const session = sessions.get(socket.sessionId);
    if (session) session.rtcConnected = true;
  });

  // ── Input events ──
  socket.on('key-input', async (data) => {
    const session = sessions.get(socket.sessionId);
    if (!session) return;

    // Forward to laptop dashboard
    if (session.laptopSocket) {
      session.laptopSocket.emit('key-input', data);
    }

    // Inject via nut-js
    await injectKey(data.key, data.modifiers || []);
  });

  socket.on('text-input', async (data) => {
    const session = sessions.get(socket.sessionId);
    if (!session) return;

    if (session.laptopSocket) {
      session.laptopSocket.emit('text-input', data);
    }
    await injectText(data.text);
  });

  socket.on('mouse-move', async (data) => {
    const session = sessions.get(socket.sessionId);
    if (!session) return;

    if (session.laptopSocket) {
      session.laptopSocket.emit('mouse-move', data);
    }
    await injectMouseMove(data.dx, data.dy);
  });

  socket.on('mouse-click', async (data) => {
    const session = sessions.get(socket.sessionId);
    if (!session) return;

    if (session.laptopSocket) {
      session.laptopSocket.emit('mouse-click', data);
    }
    await injectMouseClick(data.button || 'left');
  });

  socket.on('mouse-scroll', async (data) => {
    const session = sessions.get(socket.sessionId);
    if (!session) return;

    if (session.laptopSocket) {
      session.laptopSocket.emit('mouse-scroll', data);
    }
    await injectMouseScroll(data.dx || 0, data.dy || 0);
  });

  // ── Presentation laser overlay ──
  socket.on('laser-pointer', (data) => {
    const session = sessions.get(socket.sessionId);
    if (session && session.laptopSocket) {
      session.laptopSocket.emit('laser-pointer', data);
    }
  });

  // ── Mode switching ──
  socket.on('mode-change', (data) => {
    const session = sessions.get(socket.sessionId);
    if (session) {
      session.mode = data.mode;
      io.to(`session-${socket.sessionId}`).emit('mode-change', data);
    }
  });

  // ── Theme sync ──
  socket.on('theme-change', (data) => {
    const session = sessions.get(socket.sessionId);
    if (session) {
      session.theme = data.theme;
      io.to(`session-${socket.sessionId}`).emit('theme-change', data);
    }
  });

  // ── Whiteboard sync (unified protocol) ──────────────────────
  // All wb events use a single 'wb-event' channel for minimal overhead.
  // The server just relays to the peer without processing.
  socket.on('wb-event', (data) => {
    const session = sessions.get(socket.sessionId);
    if (!session) return;
    // Relay to the other peer in the session
    const target = socket.role === 'phone' ? session.laptopSocket : session.phoneSocket;
    if (target) target.emit('wb-event', data);
  });

  // ── Presentation updates from laptop ──
  socket.on('slide-update', (data) => {
    const session = sessions.get(socket.sessionId);
    if (session && session.phoneSocket) {
      session.phoneSocket.emit('slide-update', data);
    }
  });

  // ── Media now-playing from laptop ──
  socket.on('now-playing', (data) => {
    const session = sessions.get(socket.sessionId);
    if (session && session.phoneSocket) {
      session.phoneSocket.emit('now-playing', data);
    }
  });

  // ── Custom keyboard layout sharing ──
  socket.on('custom-kb-layout', (data) => {
    const session = sessions.get(socket.sessionId);
    if (session && session.laptopSocket) {
      session.laptopSocket.emit('custom-kb-layout', data);
    }
  });

  // ── Disconnect ──
  socket.on('disconnect', () => {
    console.log(`[socket] Disconnected: ${socket.id}`);
    if (socket.sessionId) {
      const session = sessions.get(socket.sessionId);
      if (session) {
        if (socket.role === 'laptop') {
          session.laptopSocket = null;
          if (session.phoneSocket) session.phoneSocket.emit('peer-disconnected', { role: 'laptop' });
        } else if (socket.role === 'phone') {
          session.phoneSocket = null;
          if (session.laptopSocket) session.laptopSocket.emit('peer-disconnected', { role: 'phone' });
        }
      }
    }
  });
});

// ── Start Server ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIP();
  console.log('');
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║          PhoneLink - Server Ready                ║');
  console.log('╠══════════════════════════════════════════════════╣');
  console.log(`  Local:   http://localhost:${PORT}                 `);
  console.log(`  Network: http://${ip}:${PORT}        `);
  console.log(`  nut-js:  ${nutAvailable ? 'Available' : 'Not installed'}`);
  console.log('╚══════════════════════════════════════════════════╝');
  console.log('');
});

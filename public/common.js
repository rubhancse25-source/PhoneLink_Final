/**
 * PhoneLink – Shared Client Utilities (common.js)
 * WebRTC signaling, Socket.io helpers, session management, theme sync, toasts
 */

/* ── Socket.io Connection ──────────────────────────────────── */
const socket = io({ transports: ['websocket'], upgrade: false });

/* ── Session Helper ────────────────────────────────────────── */
const PhoneBridge = {
  sessionId: null,
  role: null,         // 'laptop' or 'phone'
  rtcConn: null,      // RTCPeerConnection
  dataChannel: null,  // RTCDataChannel
  rtcReady: false,
  heartbeatInterval: null,
  rtt: 0,
  socketFallbackUntil: 0,

  /** Extract session ID from URL params */
  getSessionFromURL() {
    const p = new URLSearchParams(window.location.search);
    return p.get('session');
  },

  /** Create a new session (laptop side) */
  async createSession() {
    const res = await fetch('/api/session/create');
    if (!res.ok) throw new Error(`Session create failed (${res.status})`);
    const data = await res.json();
    if (!data.sessionId) throw new Error('Session create response missing sessionId');
    this.sessionId = data.sessionId;
    return data.sessionId;
  },

  /** Join session as laptop */
  joinAsLaptop(sessionId) {
    this.sessionId = sessionId;
    this.role = 'laptop';
    socket.emit('laptop-join', sessionId);
    this.startHeartbeat();
  },

  /** Join session as phone */
  joinAsPhone(sessionId) {
    this.sessionId = sessionId;
    this.role = 'phone';
    socket.emit('phone-join', sessionId);
    this.startHeartbeat();
  },

  /** Heartbeat for session keep-alive & RTT measurement */
  startHeartbeat() {
    clearInterval(this.heartbeatInterval);
    let sentAt = 0;
    this.heartbeatInterval = setInterval(() => {
      sentAt = Date.now();
      socket.emit('heartbeat');
    }, 3000);
    socket.on('heartbeat-ack', () => {
      this.rtt = Date.now() - sentAt;
      document.dispatchEvent(new CustomEvent('rtt-update', { detail: this.rtt }));
    });
  },

  /** Get QR data for a specific mode */
  async getQR(sessionId, mode = 'presentation') {
    const res = await fetch(`/api/qr-url/${sessionId}/${mode}`);
    if (!res.ok) throw new Error(`QR generation failed (${res.status})`);
    const data = await res.json();
    if (!data.qr) throw new Error('QR response missing image data');
    return data;
  },

  /* ── WebRTC Setup ─────────────────────────────────────────── */
  async setupWebRTC(isInitiator = false) {
    const config = {
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    };
    this.rtcConn = new RTCPeerConnection(config);

    this.rtcConn.onicecandidate = (e) => {
      if (e.candidate) {
        socket.emit('rtc-ice', { candidate: e.candidate });
      }
    };

    this.rtcConn.onconnectionstatechange = () => {
      const state = this.rtcConn.connectionState;
      document.dispatchEvent(new CustomEvent('rtc-state', { detail: state }));
      if (state === 'connected') {
        this.rtcReady = true;
        socket.emit('rtc-connected');
      }
    };

    if (isInitiator) {
      this.dataChannel = this.rtcConn.createDataChannel('input', {
        ordered: false,
        maxRetransmits: 0
      });
      this._bindDataChannel(this.dataChannel);
      const offer = await this.rtcConn.createOffer();
      await this.rtcConn.setLocalDescription(offer);
      socket.emit('rtc-offer', { sdp: offer });
    } else {
      this.rtcConn.ondatachannel = (e) => {
        this.dataChannel = e.channel;
        this._bindDataChannel(this.dataChannel);
      };
    }

    // Signaling listeners
    socket.on('rtc-offer', async (data) => {
      if (!this.rtcConn) return;
      await this.rtcConn.setRemoteDescription(new RTCSessionDescription(data.sdp));
      const answer = await this.rtcConn.createAnswer();
      await this.rtcConn.setLocalDescription(answer);
      socket.emit('rtc-answer', { sdp: answer });
    });

    socket.on('rtc-answer', async (data) => {
      if (!this.rtcConn) return;
      await this.rtcConn.setRemoteDescription(new RTCSessionDescription(data.sdp));
    });

    socket.on('rtc-ice', async (data) => {
      if (!this.rtcConn) return;
      try {
        await this.rtcConn.addIceCandidate(new RTCIceCandidate(data.candidate));
      } catch (e) { /* ignore */ }
    });
  },

  _bindDataChannel(ch) {
    ch.binaryType = 'arraybuffer';
    ch.onopen = () => {
      this.rtcReady = true;
      document.dispatchEvent(new CustomEvent('datachannel-open'));
    };
    ch.onclose = () => {
      this.rtcReady = false;
      document.dispatchEvent(new CustomEvent('datachannel-close'));
    };
    ch.onmessage = (e) => {
      document.dispatchEvent(new CustomEvent('datachannel-message', { detail: e.data }));
    };
  },

  /** Send data via WebRTC DataChannel (fallback to socket) */
  sendRTC(data) {
    // Mobile browsers can suspend a data channel while the user saves an image.
    // Use Socket.IO briefly on return; it reconnects reliably and preserves input.
    if (Date.now() < this.socketFallbackUntil) return false;
    if (this.rtcReady && this.dataChannel && this.dataChannel.readyState === 'open') {
      if (typeof data === 'string') {
        this.dataChannel.send(data);
      } else {
        this.dataChannel.send(data);
      }
      return true;
    }
    return false;
  },

  /** Send key input - tries RTC first, fallback to socket */
  sendKey(key, modifiers = []) {
    const payload = { key, modifiers, ts: Date.now() };
    if (!this.sendRTC(JSON.stringify({ type: 'key', ...payload }))) {
      socket.emit('key-input', payload);
    }
  },

  sendKeyDown(key, modifiers = []) {
    const payload = { key, modifiers, ts: Date.now() };
    if (!this.sendRTC(JSON.stringify({ type: 'key-down', ...payload }))) socket.emit('key-down', payload);
  },

  sendKeyUp(key, modifiers = []) {
    const payload = { key, modifiers, ts: Date.now() };
    if (!this.sendRTC(JSON.stringify({ type: 'key-up', ...payload }))) socket.emit('key-up', payload);
  },

  /** Send text input */
  sendText(text) {
    const payload = { text, ts: Date.now() };
    if (!this.sendRTC(JSON.stringify({ type: 'text', ...payload }))) {
      socket.emit('text-input', payload);
    }
  },

  /** Send mouse move delta */
  sendMouseMove(dx, dy) {
    const buf = new Float32Array([dx, dy]);
    const sentRtc = this.sendRTC(buf.buffer);
    if (!sentRtc) {
      socket.emit('mouse-move', { dx, dy });
    }
    return sentRtc;
  },

  /** Send mouse click */
  sendMouseClick(button = 'left') {
    const payload = { button, ts: Date.now() };
    if (!this.sendRTC(JSON.stringify({ type: 'click', ...payload }))) {
      socket.emit('mouse-click', payload);
    }
  },

  /** Send mouse scroll */
  sendMouseScroll(dx, dy) {
    const payload = { dx, dy };
    if (!this.sendRTC(JSON.stringify({ type: 'scroll', ...payload }))) {
      socket.emit('mouse-scroll', payload);
    }
  },

  /** Send whiteboard events - realtime over RTC with socket fallback */
  sendWhiteboard(event) {
    const json = JSON.stringify({ type: 'wb', event });
    if (!this.sendRTC(json)) {
      socket.emit('wb-event', event);
    }
  },

  /** Send presentation laser pointer position */
  sendLaserPointer(data) {
    socket.emit('laser-pointer', { ...data, ts: Date.now() });
  }
};

/* ── Theme Management ──────────────────────────────────────── */
const ThemeManager = {
  current: 'dark-galaxy',
  themes: [
    'dark-galaxy', 'aurora-glass', 'sunset-glass', 'minimal-mono'
  ],
  labels: {
    'dark-galaxy': 'Dark Galaxy',
    'aurora-glass': 'Aurora Glass',
    'sunset-glass': 'Sunset Glass',
    'minimal-mono': 'Minimal Mono'
  },
  aliases: { dark: 'dark-galaxy', neon: 'aurora-glass', glass: 'sunset-glass', mono: 'minimal-mono' },

  init() {
    const saved = localStorage.getItem('pb-theme') || localStorage.getItem('theme') || 'dark-galaxy';
    this.apply(saved);

    socket.on('theme-change', (data) => {
      this.apply(data.theme, false);
    });
  },

  apply(theme, broadcast = true) {
    theme = this.aliases[theme] || theme || 'dark-galaxy';
    if (!this.themes.includes(theme)) theme = 'dark-galaxy';
    this.current = theme;
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('pb-theme', theme);
    localStorage.setItem('theme', theme);
    document.querySelectorAll('.theme-chip').forEach(el => {
      el.classList.toggle('active', el.dataset.theme === theme);
    });
    if (broadcast) {
      socket.emit('theme-change', { theme });
    }
  }
};

/* ── Toast Notifications ───────────────────────────────────── */
const Toast = {
  container: null,

  init() {
    this.container = document.createElement('div');
    this.container.className = 'toast-container';
    document.body.appendChild(this.container);
  },

  show(message, type = 'info', duration = 3000) {
    if (!this.container) this.init();
    const icons = { success: '✓', error: '×', info: 'i', warning: '!' };
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `<span>${icons[type] || ''}</span><span>${message}</span>`;
    this.container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(100%)';
      toast.style.transition = 'all .3s';
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }
};

/* ── Ripple Effect for Buttons ─────────────────────────────── */
function addRipple(e) {
  const btn = e.currentTarget;
  const rect = btn.getBoundingClientRect();
  const ripple = document.createElement('span');
  ripple.className = 'ripple';
  const size = Math.max(rect.width, rect.height);
  ripple.style.width = ripple.style.height = size + 'px';
  ripple.style.left = (e.clientX || e.touches?.[0]?.clientX || rect.left + rect.width/2) - rect.left - size/2 + 'px';
  ripple.style.top = (e.clientY || e.touches?.[0]?.clientY || rect.top + rect.height/2) - rect.top - size/2 + 'px';
  btn.appendChild(ripple);
  setTimeout(() => ripple.remove(), 600);
}

document.addEventListener('DOMContentLoaded', () => {
  // Add ripple to all buttons
  document.querySelectorAll('.btn').forEach(btn => {
    btn.addEventListener('pointerdown', addRipple);
  });

  // Track mouse position for button glow effect
  document.addEventListener('pointermove', (e) => {
    const btn = e.target.closest('.btn');
    if (btn) {
      const rect = btn.getBoundingClientRect();
      btn.style.setProperty('--x', ((e.clientX - rect.left) / rect.width * 100) + '%');
      btn.style.setProperty('--y', ((e.clientY - rect.top) / rect.height * 100) + '%');
    }
  });

  // Initialize theme
  ThemeManager.init();
  Toast.init();
  // The dashboard owns its compact laptop-only settings panel. Phone pages use
  // the shared settings overlay (including haptics and pointer speed).
  if (!document.getElementById('dashboardSettings')) buildGlobalSettings();
  addFullscreenControl();
});

/* ── Haptic Feedback ───────────────────────────────────────── */
function haptic(style = 'light') {
  if (localStorage.getItem('phonelink-vibrate') === 'off') return;
  if (navigator.vibrate) {
    const patterns = { light: 10, medium: 25, heavy: 50 };
    navigator.vibrate(patterns[style] || 10);
  }
}

function setVibrationEnabled(enabled) {
  localStorage.setItem('phonelink-vibrate', enabled ? 'on' : 'off');
  document.querySelectorAll('[data-vibration-toggle]').forEach(el => { el.checked = enabled; });
}

function getControlSpeed(kind = 'keyboard') {
  const key = kind === 'presentation' ? 'phonelink-presentation-mouse-speed' : 'phonelink-keyboard-mouse-speed';
  return parseFloat(localStorage.getItem(key) || '4');
}

function setControlSpeed(kind, value) {
  const key = kind === 'presentation' ? 'phonelink-presentation-mouse-speed' : 'phonelink-keyboard-mouse-speed';
  localStorage.setItem(key, value);
  document.querySelectorAll(`[data-speed-control="${kind}"]`).forEach(el => { el.value = value; });
  document.dispatchEvent(new CustomEvent('control-speed-change', { detail: { kind, value: parseFloat(value) } }));
}

function setSharedKeyboardOS(os, broadcast = true) {
  const value = os === 'mac' ? 'mac' : 'windows';
  localStorage.setItem('phonelink-keyboard-os', value);
  document.querySelectorAll('[data-keyboard-os]').forEach(el => el.classList.toggle('active', el.dataset.keyboardOs === value));
  document.dispatchEvent(new CustomEvent('shared-keyboard-os-change', { detail: { os: value } }));
  if (broadcast && PhoneBridge.sessionId) socket.emit('keyboard-os-change', { os: value });
}

function setPseudoFullscreen(enabled) {
  document.documentElement.classList.toggle('app-fullscreen', enabled);
  document.body.classList.toggle('app-fullscreen', enabled);
  document.querySelectorAll('[data-fullscreen-btn]').forEach(btn => { btn.textContent = enabled ? '×' : '⛶'; btn.title = enabled ? 'Exit fullscreen' : 'Fullscreen'; });
  if (enabled) Toast.show('App fullscreen enabled', 'success');
}

async function requestAppFullscreen(target = document.documentElement) {
  haptic('light');
  const el = target || document.documentElement;
  const active = document.fullscreenElement || document.webkitFullscreenElement;
  const request = el.requestFullscreen || el.webkitRequestFullscreen;
  const exit = document.exitFullscreen || document.webkitExitFullscreen;
  if (document.documentElement.classList.contains('app-fullscreen')) { setPseudoFullscreen(false); return; }
  if (!request) { setPseudoFullscreen(true); return; }
  try {
    // A detached whiteboard element can remain reported briefly after download.
    // Clear that stale state before requesting fullscreen on the current page.
    if (active && active !== el && exit) {
      await Promise.resolve(exit.call(document)).catch(() => {});
    } else if (active === el && exit) {
      await Promise.resolve(exit.call(document));
      return;
    }
    // navigationUI is supported by Chromium browsers (including Brave Android)
    // and requests that the browser chrome is hidden as well.
    try { await Promise.resolve(request.call(el, { navigationUI: 'hide' })); }
    catch (_) { await Promise.resolve(request.call(el)); }
    setTimeout(() => {
      if (document.fullscreenElement || document.webkitFullscreenElement) {
        Toast.show('Fullscreen enabled', 'success');
      } else {
        setPseudoFullscreen(true);
      }
    }, 180);
  } catch (_) {
    setPseudoFullscreen(true);
  }
}

function addFullscreenControl() {
  document.querySelectorAll('.phone-header .flex.items-center').forEach(actions => {
    if (actions.querySelector('[data-fullscreen-btn]')) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-icon btn-compact';
    btn.dataset.fullscreenBtn = 'true';
    btn.title = 'Fullscreen';
    btn.textContent = '⛶';
    btn.onclick = () => requestAppFullscreen();
    actions.insertBefore(btn, actions.firstChild);
  });
}

document.addEventListener('fullscreenchange', () => {
  const active = !!(document.fullscreenElement || document.webkitFullscreenElement);
  if (!active) document.querySelectorAll('[data-fullscreen-btn]').forEach(btn => { btn.textContent = '⛶'; btn.title = 'Fullscreen'; });
});

function buildGlobalSettings() {
  if (document.getElementById('globalSettingsOverlay')) return;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay settings-overlay';
  overlay.id = 'globalSettingsOverlay';
  overlay.innerHTML = `
    <div class="modal settings-modal">
      <div class="modal-header">
        <h2>Settings</h2>
        <button class="guide-close" type="button" onclick="closeGlobalSettings()">✕</button>
      </div>
      <div class="settings-section">
        <div class="label">Themes</div>
        <div class="theme-grid">
          ${ThemeManager.themes.map(t => `<button class="theme-chip" data-theme="${t}" onclick="ThemeManager.apply('${t}')">${ThemeManager.labels[t]}</button>`).join('')}
        </div>
      </div>
      <div class="settings-section">
        <label class="setting-row">
          <span><strong>Vibration</strong><small>Button taps feel more physical on phone.</small></span>
          <input type="checkbox" data-vibration-toggle ${localStorage.getItem('phonelink-vibrate') === 'off' ? '' : 'checked'} onchange="setVibrationEnabled(this.checked)">
        </label>
      </div>
      <div class="settings-section">
        <div class="label">Pointer Speed</div>
        <label class="speed-setting">
          <span>Keyboard mousepad</span>
          <input type="range" class="slider" min="1" max="10" step="0.5" value="${getControlSpeed('keyboard')}" data-speed-control="keyboard" oninput="setControlSpeed('keyboard', this.value)">
        </label>
        <label class="speed-setting">
          <span>Presentation mousepad</span>
          <input type="range" class="slider" min="1" max="10" step="0.5" value="${getControlSpeed('presentation')}" data-speed-control="presentation" oninput="setControlSpeed('presentation', this.value)">
        </label>
      </div>
      <div class="settings-section">
        <div class="label">Keyboard Layout</div>
        <div class="theme-grid">
          <button class="theme-chip" type="button" data-keyboard-os="windows" onclick="setSharedKeyboardOS('windows')">Windows</button>
          <button class="theme-chip" type="button" data-keyboard-os="mac" onclick="setSharedKeyboardOS('mac')">MacBook</button>
        </div>
      </div>
      <div class="settings-section settings-actions">
        <button class="btn btn-primary" type="button" onclick="requestAppFullscreen()">⛶ Fullscreen</button>
        <button class="btn" type="button" onclick="closeGlobalSettings(); Guide.open()">Guide</button>
      </div>
    </div>
  `;
  overlay.addEventListener('click', e => { if (e.target === overlay) closeGlobalSettings(); });
  document.body.appendChild(overlay);
  ThemeManager.apply(ThemeManager.current, false);
  setSharedKeyboardOS(localStorage.getItem('phonelink-keyboard-os') || 'windows', false);

  document.querySelectorAll('.phone-header .flex.items-center').forEach(actions => {
    if (actions.querySelector('[data-settings-btn]')) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-icon btn-compact';
    btn.dataset.settingsBtn = 'true';
    btn.title = 'Settings';
    btn.textContent = 'S';
    btn.onclick = () => openGlobalSettings();
    actions.insertBefore(btn, actions.firstChild);
  });
}

function openGlobalSettings() {
  document.getElementById('globalSettingsOverlay')?.classList.add('active');
  document.querySelectorAll('[data-vibration-toggle]').forEach(el => {
    el.checked = localStorage.getItem('phonelink-vibrate') !== 'off';
  });
}

function closeGlobalSettings() {
  document.getElementById('globalSettingsOverlay')?.classList.remove('active');
}

/* ── Utility: Throttle ─────────────────────────────────────── */
function throttle(fn, ms) {
  let last = 0;
  return function(...args) {
    const now = Date.now();
    if (now - last >= ms) {
      last = now;
      fn.apply(this, args);
    }
  };
}

/* ── Utility: Format time mm:ss ────────────────────────────── */
function formatTime(seconds) {
  const m = Math.floor(seconds / 60).toString().padStart(2, '0');
  const s = (seconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

/* ── Socket status listeners ───────────────────────────────── */
socket.on('connect', () => {
  // Socket.IO gives a reconnecting browser a new socket id. Re-associate it with
  // the existing session so controls continue working after download/share flows.
  if (PhoneBridge.sessionId && PhoneBridge.role) {
    socket.emit(PhoneBridge.role === 'laptop' ? 'laptop-join' : 'phone-join', PhoneBridge.sessionId);
  }
  document.dispatchEvent(new CustomEvent('socket-connected'));
});
socket.on('disconnect', () => {
  document.dispatchEvent(new CustomEvent('socket-disconnected'));
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    PhoneBridge.socketFallbackUntil = Date.now() + 15000;
    socket.connect();
  }
});
socket.on('error-msg', (msg) => {
  Toast.show(msg, 'error');
});
socket.on('keyboard-os-change', data => setSharedKeyboardOS(data?.os, false));
socket.on('session-expired', () => {
  Toast.show('Session expired', 'error', 5000);
});

/* ── Phone Navigation Bar ──────────────────────────────────── */
function buildPhoneNav(activeMode) {
  const sessionId = PhoneBridge.getSessionFromURL();
  if (!sessionId) return;
  document.querySelector('.phone-layout')?.classList.add('has-phone-nav');
  const modes = [
    { id: 'mobile', icon: '⌂', label: 'Modes', mode: 'home' },
    { id: 'presentation', icon: '▭', label: 'Present', mode: 'presentation' },
    { id: 'media', icon: '♪', label: 'Media', mode: 'media' },
    { id: 'keyboard', icon: '⌗', label: 'Keys', mode: 'keyboard' },
    { id: 'whiteboard', icon: '□', label: 'Board', mode: 'whiteboard' },
    { id: 'keyboard-builder', icon: '◇', label: 'Custom', mode: 'builder' }
  ];

  const nav = document.createElement('nav');
  nav.className = 'phone-nav';
  modes.forEach(m => {
    const a = document.createElement('a');
    if (m.mode === 'home') a.href = `controller.html?session=${sessionId}`;
    else a.href = `controller.html?session=${sessionId}&mode=${m.mode}`;
    a.className = m.id === activeMode ? 'active' : '';
    a.innerHTML = `<span class="nav-icon">${m.icon}</span>${m.label}`;
    nav.appendChild(a);
  });
  document.body.appendChild(nav);
}

/* ── Interactive Guide System ──────────────────────────────── */
const Guide = {
  steps: [],
  currentStep: 0,
  overlay: null,

  init(steps) {
    this.steps = steps;
    this.currentStep = 0;
    this._buildOverlay();
  },

  _buildOverlay() {
    if (this.overlay) this.overlay.remove();
    const ol = document.createElement('div');
    ol.className = 'guide-overlay';
    ol.id = 'guideOverlay';
    ol.innerHTML = `
      <div class="guide-card">
        <div class="guide-header">
          <h2>Guide</h2>
          <button class="guide-close" onclick="Guide.close()">✕</button>
        </div>
        <div class="guide-body" id="guideBody"></div>
        <div class="guide-footer">
          <div class="guide-dots" id="guideDots"></div>
          <div style="display:flex;gap:.4rem">
            <button class="guide-nav-btn" id="guidePrev" onclick="Guide.prev()">← Back</button>
            <button class="guide-nav-btn primary" id="guideNext" onclick="Guide.next()">Next →</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(ol);
    this.overlay = ol;
    this._renderSteps();
    this._renderDots();
  },

  _renderSteps() {
    const body = document.getElementById('guideBody');
    body.innerHTML = '';
    this.steps.forEach((s, i) => {
      const div = document.createElement('div');
      div.className = 'guide-step' + (i === this.currentStep ? ' active' : '');
      div.innerHTML = `
        <div class="step-icon">${s.icon || '•'}</div>
        <h3>${s.title}</h3>
        <p>${s.description}</p>
        ${s.tip ? `<div class="tip">${s.tip}</div>` : ''}
      `;
      body.appendChild(div);
    });
    this._updateNav();
  },

  _renderDots() {
    const dots = document.getElementById('guideDots');
    dots.innerHTML = '';
    this.steps.forEach((_, i) => {
      const d = document.createElement('div');
      d.className = 'guide-dot' + (i === this.currentStep ? ' active' : '');
      d.onclick = () => { this.currentStep = i; this._update(); };
      dots.appendChild(d);
    });
  },

  _update() {
    document.querySelectorAll('.guide-step').forEach((s, i) => s.classList.toggle('active', i === this.currentStep));
    document.querySelectorAll('.guide-dot').forEach((d, i) => d.classList.toggle('active', i === this.currentStep));
    this._updateNav();
  },

  _updateNav() {
    const prev = document.getElementById('guidePrev');
    const next = document.getElementById('guideNext');
    if (prev) prev.style.visibility = this.currentStep === 0 ? 'hidden' : 'visible';
    if (next) next.textContent = this.currentStep === this.steps.length - 1 ? 'Done ✓' : 'Next →';
  },

  open() { this.currentStep = 0; this._update(); this.overlay?.classList.add('active'); },
  close() { this.overlay?.classList.remove('active'); },
  next() { if (this.currentStep < this.steps.length - 1) { this.currentStep++; this._update(); } else this.close(); },
  prev() { if (this.currentStep > 0) { this.currentStep--; this._update(); } }
};

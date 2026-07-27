# PhoneLink

**Multi-mode remote control suite for education, presentations, and productivity.**

Control your laptop from your phone via QR code pairing with low-latency WebSocket and WebRTC communication.

---

## Features

### 5 Control Modes

| Mode | Description |
|------|-------------|
| **Presentation Remote** | Next/Prev slides, timer, laser pointer (mouse control) |
| **Media Remote** | Play/Pause, volume, seek, track controls, now-playing sync |
| **Keyboard & Mouse** | Full QWERTY, numeric, Fn keys, sticky modifiers, trackpad |
| **Whiteboard** | Low-latency shared canvas with pen, eraser, shapes, arrows, text, undo, redo, and PNG export |
| **Custom Keyboard** | Drag-and-drop key builder with macros, shapes, import/export |

### Core Features
- **QR Code Pairing** – Scan to connect instantly
- **WebRTC DataChannel** – Ultra-low-latency input (ordered: false, maxRetransmits: 0)
- **Socket.io Fallback** – Reliable communication when WebRTC isn't available
- **3 Themes** – Dark, Neon, Glass – synced between devices
- **Native Input Injection** – Optional `@nut-tree-fork/nut-js` for real keyboard/mouse control
- **Session Management** – Auto-cleanup, heartbeat, RTT monitoring
- **Glassmorphism UI** – Premium design with smooth animations

---

## Quick Start

```bash
# Clone and install
cd phone-bridge
npm install

# Start the server
npm start
```

Open `http://localhost:3000` on your laptop. Scan the QR code with your phone.

> **Note:** Both devices must be on the same WiFi network.

---

## File Structure

```
phone-bridge/
├── server.js                 # Express + Socket.io + WebRTC signaling
├── package.json
├── public/
│   ├── index.html            # Laptop dashboard
│   ├── common.css            # Design system (3 themes, glassmorphism)
│   ├── common.js             # WebRTC, Socket.io helpers, utilities
│   ├── presentation.html     # Phone: Presentation remote
│   ├── media.html            # Phone: Media remote
│   ├── keyboard.html         # Phone: Keyboard & mouse
│   ├── whiteboard.html       # Phone: Collaborative whiteboard
│   └── keyboard-builder.html # Phone: Custom keyboard builder
└── README.md
```

---

## Native Input Injection (Optional)

For actual keyboard/mouse control on the laptop OS:

```bash
npm install @nut-tree-fork/nut-js
```

Without it, the app still works — inputs are shown in the dashboard monitor but won't control the OS.

---

## Themes

Switch themes from the laptop dashboard. All connected devices sync automatically.

- **Dark** – Default, deep dark with purple/teal accents
- **Neon** – Cyberpunk green/pink glow
- **Glass** – Warm glass with red accents

---

## Architecture

```
Phone (Browser)  ──WebRTC DataChannel──▶  Laptop (Browser)
       │                                        │
       └──Socket.io──▶  Server  ◀──Socket.io──┘
                          │
                        nut-js
                          │
                      OS Input
```

- **WebRTC** used for mouse movement and rapid key input (low latency)
- **Socket.io** used for signaling, session management, and fallback
- **nut-js** injects actual OS-level keyboard/mouse events

---

## License

MIT

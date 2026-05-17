/**
 * PhoneLink – Whiteboard Core v4 (Zero-Lag, Excalidraw-parity)
 *
 * Key fixes vs v3:
 *  1. Distance filter now compares in NORMALIZED space (not mixed world/pixel)
 *  2. onPointerDown no longer guards on e.button for touch events
 *  3. Local draw is ALWAYS instant – sync is fire-and-forget
 *  4. getCoalescedEvents() used on every move for dense paths
 *  5. scheduleEmitDelta fires via microtask (queueMicrotask) not rAF
 *     so points are sent ASAP without waiting a full frame
 *  6. Render loop is decoupled from sync
 */
(function () {
  'use strict';

  const clamp = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
  const uid   = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36);

  function createWhiteboard(options) {
    const canvas = options.canvas;
    const ctx    = canvas.getContext('2d', { alpha: false, desynchronized: true });
    const onSend = options.send || null;
    const onDraw = options.onDraw || null;

    /* ── State ── */
    const S = {
      elements  : [],
      redo      : [],
      live      : null,
      remoteLive: null,
      tool      : 'pen',
      color     : '#1e1e2e',
      fill      : 'none',
      size      : 3,
      opacity   : 1,
      zoom      : 1,
      panX      : 0,
      panY      : 0,
      drawing   : false,
      panning   : false,
      panStart  : null,
      rafId     : 0,
      dirty     : true,
      sentPoints: 0,
      pointerId : null,
    };

    /* ── Resize (HiDPI) ── */
    function resize() {
      const W = canvas.offsetWidth  || 800;
      const H = canvas.offsetHeight || 600;
      const dpr = window.devicePixelRatio || 1;
      canvas.width  = Math.max(1, Math.round(W * dpr));
      canvas.height = Math.max(1, Math.round(H * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      constrainView();
      markDirty();
    }

    /* ── Coordinate helpers ── */
    function clientToWorld(cx, cy) {
      const r = canvas.getBoundingClientRect();
      return {
        x: (cx - r.left - S.panX) / S.zoom,
        y: (cy - r.top  - S.panY) / S.zoom,
      };
    }
    function worldToCanvas(wx, wy) {
      return { x: wx * S.zoom + S.panX, y: wy * S.zoom + S.panY };
    }
    function constrainView() {
      const W = canvas.offsetWidth  || 800;
      const H = canvas.offsetHeight || 600;
      if (S.zoom <= 1) {
        S.zoom = 1;
        S.panX = 0;
        S.panY = 0;
        return;
      }
      const minX = W - W * S.zoom;
      const minY = H - H * S.zoom;
      S.panX = clamp(S.panX, minX, 0);
      S.panY = clamp(S.panY, minY, 0);
    }
    // Normalise world → [0,1] relative to logical canvas size
    function norm(wx, wy) {
      const W = canvas.offsetWidth  || 800;
      const H = canvas.offsetHeight || 600;
      return { x: clamp(wx / W), y: clamp(wy / H) };
    }
    function denorm(nx, ny) {
      const W = canvas.offsetWidth  || 800;
      const H = canvas.offsetHeight || 600;
      return { x: nx * W, y: ny * H };
    }

    /* ── Element factory ── */
    function makeElement(wx, wy) {
      const n = norm(wx, wy);
      const base = {
        id     : uid(),
        tool   : S.tool,
        color  : S.color,
        fill   : S.fill,
        size   : S.size,
        opacity: S.opacity,
      };
      if (S.tool === 'pen' || S.tool === 'eraser') {
        return { ...base, type: 'path', points: [n] };
      }
      return { ...base, type: S.tool, x1: n.x, y1: n.y, x2: n.x, y2: n.y };
    }

    /* ── Emit helpers ── */
    function emit(kind, payload) {
      if (onSend) onSend({ kind, payload });
    }

    // Send only new tail of live stroke — called via microtask for immediacy
    let emitPending = false;
    function scheduleEmitDelta() {
      if (emitPending) return;
      emitPending = true;
      // queueMicrotask fires before next paint — lower latency than rAF
      queueMicrotask(() => {
        emitPending = false;
        if (!S.live || !onSend) return;
        const el   = S.live;
        const from = S.sentPoints;
        if (el.type === 'path') {
          if (el.points.length <= from) return;
          const delta = el.points.slice(from);
          S.sentPoints = el.points.length;
          emit('delta', {
            id: el.id, tool: el.tool, color: el.color,
            size: el.size, opacity: el.opacity, points: delta,
          });
        } else {
          emit('live', el);
        }
      });
    }

    /* ── True vector eraser ── */
    function distanceToSegment(p, a, b) {
      const vx = b.x - a.x;
      const vy = b.y - a.y;
      const wx = p.x - a.x;
      const wy = p.y - a.y;
      const lenSq = vx * vx + vy * vy;
      const t = lenSq ? clamp((wx * vx + wy * vy) / lenSq) : 0;
      const x = a.x + t * vx;
      const y = a.y + t * vy;
      return Math.hypot(p.x - x, p.y - y);
    }

    function pointInBounds(p, a, b, pad = 0) {
      return p.x >= Math.min(a.x, b.x) - pad &&
             p.x <= Math.max(a.x, b.x) + pad &&
             p.y >= Math.min(a.y, b.y) - pad &&
             p.y <= Math.max(a.y, b.y) + pad;
    }

    function elementHitByEraser(el, n, radius) {
      const p = denorm(n.x, n.y);
      const strokePad = radius + (el.size || 3) * 0.75;

      if (el.type === 'path') {
        const pts = el.points || [];
        if (pts.length === 1) {
          const a = denorm(pts[0].x, pts[0].y);
          return Math.hypot(p.x - a.x, p.y - a.y) <= strokePad;
        }
        for (let i = 1; i < pts.length; i += 1) {
          const a = denorm(pts[i - 1].x, pts[i - 1].y);
          const b = denorm(pts[i].x, pts[i].y);
          if (distanceToSegment(p, a, b) <= strokePad) return true;
        }
        return false;
      }

      if (el.type === 'line' || el.type === 'arrow') {
        return distanceToSegment(p, denorm(el.x1, el.y1), denorm(el.x2, el.y2)) <= strokePad;
      }

      if (el.type === 'rect' || el.type === 'diamond' || el.type === 'ellipse') {
        const a = denorm(el.x1, el.y1);
        const b = denorm(el.x2, el.y2);
        return pointInBounds(p, a, b, strokePad);
      }

      if (el.type === 'text') {
        const a = denorm(el.x, el.y);
        const width = Math.max(40, (el.text || '').length * Math.max(10, (el.size || 3) * 3));
        const height = Math.max(22, (el.size || 3) * 7);
        return p.x >= a.x - strokePad && p.x <= a.x + width + strokePad &&
               p.y >= a.y - height - strokePad && p.y <= a.y + strokePad;
      }

      return false;
    }

    function eraseAt(wx, wy) {
      const n = norm(wx, wy);
      const radius = Math.max(10, S.size * 4);
      const removed = [];
      S.elements = S.elements.filter(el => {
        if (elementHitByEraser(el, n, radius)) {
          removed.push(el.id);
          return false;
        }
        return true;
      });
      if (removed.length) {
        S.redo = [];
        emit('erase', { ids: removed });
        markDirty();
      }
    }

    /* ── Pointer handlers ── */
    function onPointerDown(e) {
      // Allow left-button mouse OR any touch/stylus pointer
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.preventDefault();

      try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
      S.pointerId = e.pointerId;

      const { x, y } = clientToWorld(e.clientX, e.clientY);

      if (S.tool === 'hand') {
        S.panStart = { x: e.clientX - S.panX, y: e.clientY - S.panY };
        S.panning  = true;
        return;
      }
      if (S.tool === 'text') {
        openInlineText(x, y);
        return;
      }
      if (S.tool === 'eraser') {
        S.drawing = true;
        S.live = null;
        eraseAt(x, y);
        return;
      }

      S.drawing    = true;
      S.live       = makeElement(x, y);
      S.sentPoints = 0;
      markDirty();
      scheduleEmitDelta();
    }

    function onPointerMove(e) {
      if (e.pointerId !== S.pointerId && S.pointerId !== null) return;
      e.preventDefault();

      if (S.panning && S.panStart) {
        S.panX = e.clientX - S.panStart.x;
        S.panY = e.clientY - S.panStart.y;
        constrainView();
        markDirty();
        return;
      }
      if (!S.drawing) return;

      // Use coalesced events for dense touch paths
      const events = (e.getCoalescedEvents ? e.getCoalescedEvents() : null) || [e];
      for (const ev of events) {
        const { x, y } = clientToWorld(ev.clientX, ev.clientY);
        if (S.tool === 'eraser') {
          eraseAt(x, y);
          continue;
        }
        if (!S.live) continue;
        if (S.live.type === 'path') {
          const pts  = S.live.points;
          const last = pts[pts.length - 1];
          const n    = norm(x, y);
          // Distance filter in NORMALIZED space (fixes dots bug)
          const dx = n.x - last.x, dy = n.y - last.y;
          const MIN_DIST_SQ = 0.0001 * 0.0001; // ~0.01% of canvas = ~0.1px on 1000px canvas
          if (dx * dx + dy * dy > MIN_DIST_SQ) {
            pts.push(n);
          }
        } else {
          const n   = norm(x, y);
          S.live.x2 = n.x;
          S.live.y2 = n.y;
        }
      }
      markDirty();
      scheduleEmitDelta();
    }

    function onPointerUp(e) {
      if (e.pointerId !== S.pointerId && S.pointerId !== null) return;
      e.preventDefault();
      S.panning   = false;
      S.panStart  = null;
      S.pointerId = null;

      if (S.tool === 'eraser') {
        S.drawing = false;
        S.live = null;
        emit('live', null);
        return;
      }
      if (!S.drawing || !S.live) return;
      S.drawing = false;

      const el = S.live;
      S.live = null;
      S.elements.push(el);
      S.redo = [];
      emit('add', el);
      emit('live', null);
      markDirty();
    }

    /* ── Wheel zoom (laptop) ── */
    function onWheel(e) {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.08 : 0.93;
      const r  = canvas.getBoundingClientRect();
      const cx = e.clientX - r.left;
      const cy = e.clientY - r.top;
      S.panX = cx - (cx - S.panX) * factor;
      S.panY = cy - (cy - S.panY) * factor;
      S.zoom = clamp(S.zoom * factor, 1, 20);
      constrainView();
      updateZoomLabel();
      markDirty();
    }

    /* ── Pinch-to-zoom ── */
    let pinchState = null;
    const activeTouches = new Map();

    function onTouchStart(e) {
      for (const t of e.changedTouches) activeTouches.set(t.identifier, t);
      if (activeTouches.size === 2) {
        e.preventDefault();
        S.drawing = false;
        S.live    = null;
        S.pointerId = null;
        const [a, b] = [...activeTouches.values()];
        pinchState = {
          dist: Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY),
          midX: (a.clientX + b.clientX) / 2,
          midY: (a.clientY + b.clientY) / 2,
          zoom: S.zoom, panX: S.panX, panY: S.panY,
        };
      }
    }
    function onTouchMove(e) {
      for (const t of e.changedTouches) activeTouches.set(t.identifier, t);
      if (activeTouches.size === 2 && pinchState) {
        e.preventDefault();
        const [a, b] = [...activeTouches.values()];
        const newDist = Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY);
        const newMidX = (a.clientX + b.clientX) / 2;
        const newMidY = (a.clientY + b.clientY) / 2;
        const scale   = newDist / pinchState.dist;
        const r       = canvas.getBoundingClientRect();
        const cx      = pinchState.midX - r.left;
        const cy      = pinchState.midY - r.top;
        S.zoom = clamp(pinchState.zoom * scale, 1, 20);
        S.panX = newMidX - r.left - (cx - pinchState.panX) * (S.zoom / pinchState.zoom);
        S.panY = newMidY - r.top  - (cy - pinchState.panY) * (S.zoom / pinchState.zoom);
        constrainView();
        updateZoomLabel();
        markDirty();
      }
    }
    function onTouchEnd(e) {
      for (const t of e.changedTouches) activeTouches.delete(t.identifier);
      if (activeTouches.size < 2) pinchState = null;
    }

    /* ── Inline text editor ── */
    let textOverlay = null;
    function openInlineText(wx, wy) {
      if (textOverlay) textOverlay.remove();
      const cp = worldToCanvas(wx, wy);
      const r  = canvas.getBoundingClientRect();
      const host = document.fullscreenElement || options.root || document.body;
      const ta = document.createElement('textarea');
      ta.placeholder = 'Enter text';
      ta.inputMode = 'text';
      ta.style.cssText = [
        `position:fixed`,
        `left:${r.left + cp.x}px`,
        `top:${r.top  + cp.y}px`,
        `min-width:140px`,
        `min-height:36px`,
        `background:rgba(255,255,255,.97)`,
        `color:#111`,
        `border:2px solid #6366f1`,
        `border-radius:6px`,
        `padding:5px 10px`,
        `font-size:${Math.max(12, S.size * 4 * S.zoom)}px`,
        `font-family:Inter,sans-serif`,
        `outline:none`,
        `resize:both`,
        `z-index:9999`,
        `box-shadow:0 4px 24px rgba(0,0,0,.2)`,
      ].join(';');
      host.appendChild(ta);
      textOverlay = ta;
      requestAnimationFrame(() => ta.focus());
      const commit = () => {
        if (!textOverlay) return;
        const text = ta.value.trim();
        ta.remove();
        textOverlay = null;
        if (!text) return;
        const n  = norm(wx, wy);
        const el = {
          id: uid(), type: 'text', tool: 'text',
          x: n.x, y: n.y, text,
          color: S.color, size: S.size, opacity: S.opacity,
        };
        S.elements.push(el);
        S.redo = [];
        emit('add', el);
        markDirty();
      };
      ta.addEventListener('blur', commit);
      ta.addEventListener('keydown', e => {
        if (e.key === 'Escape') { ta.value = ''; ta.blur(); }
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') ta.blur();
      });
    }

    /* ── Rendering ── */
    function markDirty() {
      S.dirty = true;
      if (!S.rafId) S.rafId = requestAnimationFrame(render);
    }

    function applyCtxStyle(el) {
      ctx.globalAlpha = el.opacity ?? 1;
      ctx.strokeStyle = el.color || '#111';
      ctx.fillStyle   = el.fill === 'solid' ? (el.color || '#111') : 'transparent';
      ctx.lineWidth   = (el.size || 3) * S.zoom;
      ctx.lineCap     = 'round';
      ctx.lineJoin    = 'round';
      ctx.globalCompositeOperation = 'source-over';
    }

    function drawElement(el) {
      if (!el) return;
      ctx.save();
      applyCtxStyle(el);
      const W = canvas.offsetWidth  || 800;
      const H = canvas.offsetHeight || 600;
      const d = (nx, ny) => ({
        x: nx * W * S.zoom + S.panX,
        y: ny * H * S.zoom + S.panY,
      });

      if (el.type === 'path') {
        const pts = el.points;
        if (!pts || pts.length === 0) { ctx.restore(); return; }
        const p0 = d(pts[0].x, pts[0].y);
        ctx.beginPath();
        ctx.moveTo(p0.x, p0.y);
        if (pts.length === 1) {
          ctx.arc(p0.x, p0.y, ctx.lineWidth / 2, 0, Math.PI * 2);
          ctx.fill();
        } else {
          for (let i = 1; i < pts.length; i++) {
            const cur  = d(pts[i].x, pts[i].y);
            const prev = d(pts[i - 1].x, pts[i - 1].y);
            const mx   = (prev.x + cur.x) / 2;
            const my   = (prev.y + cur.y) / 2;
            ctx.quadraticCurveTo(prev.x, prev.y, mx, my);
          }
          const last = d(pts[pts.length - 1].x, pts[pts.length - 1].y);
          ctx.lineTo(last.x, last.y);
          ctx.stroke();
        }

      } else if (el.type === 'rect') {
        const a = d(el.x1, el.y1), b = d(el.x2, el.y2);
        ctx.beginPath();
        ctx.rect(a.x, a.y, b.x - a.x, b.y - a.y);
        if (el.fill === 'solid') ctx.fill();
        ctx.stroke();

      } else if (el.type === 'diamond') {
        const a = d(el.x1, el.y1), b = d(el.x2, el.y2);
        const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
        ctx.beginPath();
        ctx.moveTo(cx, a.y); ctx.lineTo(b.x, cy);
        ctx.lineTo(cx, b.y); ctx.lineTo(a.x, cy);
        ctx.closePath();
        if (el.fill === 'solid') ctx.fill();
        ctx.stroke();

      } else if (el.type === 'ellipse') {
        const a = d(el.x1, el.y1), b = d(el.x2, el.y2);
        ctx.beginPath();
        ctx.ellipse(
          (a.x + b.x) / 2, (a.y + b.y) / 2,
          Math.abs(b.x - a.x) / 2, Math.abs(b.y - a.y) / 2,
          0, 0, Math.PI * 2
        );
        if (el.fill === 'solid') ctx.fill();
        ctx.stroke();

      } else if (el.type === 'line') {
        const a = d(el.x1, el.y1), b = d(el.x2, el.y2);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
        ctx.stroke();

      } else if (el.type === 'arrow') {
        const a = d(el.x1, el.y1), b = d(el.x2, el.y2);
        const angle  = Math.atan2(b.y - a.y, b.x - a.x);
        const arrLen = Math.min(20, Math.hypot(b.x - a.x, b.y - a.y) * 0.35) * S.zoom;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
        ctx.lineTo(b.x - arrLen * Math.cos(angle - Math.PI / 6),
                   b.y - arrLen * Math.sin(angle - Math.PI / 6));
        ctx.moveTo(b.x, b.y);
        ctx.lineTo(b.x - arrLen * Math.cos(angle + Math.PI / 6),
                   b.y - arrLen * Math.sin(angle + Math.PI / 6));
        ctx.stroke();

      } else if (el.type === 'text') {
        const p   = d(el.x, el.y);
        const fSz = Math.max(10, (el.size || 3) * 5 * S.zoom);
        ctx.font  = `${fSz}px Inter, system-ui, sans-serif`;
        ctx.fillStyle   = el.color || '#111';
        ctx.globalAlpha = el.opacity ?? 1;
        ctx.globalCompositeOperation = 'source-over';
        const lines = (el.text || '').split('\n');
        lines.forEach((line, i) => ctx.fillText(line, p.x, p.y + i * fSz * 1.2));
      }
      ctx.restore();
    }

    function drawGrid() {
      const W = canvas.offsetWidth  || 800;
      const H = canvas.offsetHeight || 600;
      const gs  = 24 * S.zoom;
      const ox  = S.panX % gs;
      const oy  = S.panY % gs;
      ctx.save();
      ctx.strokeStyle = 'rgba(99,102,241,.07)';
      ctx.lineWidth   = 1;
      ctx.beginPath();
      for (let x = ox; x < W; x += gs) { ctx.moveTo(x, 0); ctx.lineTo(x, H); }
      for (let y = oy; y < H; y += gs) { ctx.moveTo(0, y); ctx.lineTo(W, y); }
      ctx.stroke();
      ctx.restore();
    }

    function render() {
      S.rafId = 0;
      if (!S.dirty) return;
      S.dirty = false;
      const W = canvas.offsetWidth  || 800;
      const H = canvas.offsetHeight || 600;
      const dpr = window.devicePixelRatio || 1;
      ctx.save();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
      drawGrid();
      S.elements.forEach(drawElement);
      drawElement(S.remoteLive);
      drawElement(S.live);
      onDraw?.();
    }

    /* ── Receive events from peer ── */
    function receive(event) {
      if (!event) return;
      switch (event.kind) {
        case 'delta': {
          const d = event.payload;
          if (!S.remoteLive || S.remoteLive.id !== d.id) {
            S.remoteLive = {
              id: d.id, type: 'path', tool: d.tool,
              color: d.color, size: d.size, opacity: d.opacity,
              points: [],
            };
          }
          S.remoteLive.points.push(...d.points);
          break;
        }
        case 'live':  S.remoteLive = event.payload; break;
        case 'add': {
          if (event.payload) {
            S.elements = S.elements.filter(e => e.id !== event.payload.id);
            S.elements.push(event.payload);
            if (S.remoteLive?.id === event.payload.id) S.remoteLive = null;
          }
          break;
        }
        case 'undo':  if (S.elements.length) S.redo.push(S.elements.pop()); break;
        case 'redo':  if (S.redo.length) S.elements.push(S.redo.pop()); break;
        case 'clear': S.elements = []; S.redo = []; S.remoteLive = null; break;
        case 'erase': {
          const ids = new Set(event.payload?.ids || []);
          if (ids.size) {
            S.elements = S.elements.filter(el => !ids.has(el.id));
            if (S.remoteLive && ids.has(S.remoteLive.id)) S.remoteLive = null;
          }
          break;
        }
        case 'state': if (event.payload?.elements) S.elements = event.payload.elements; break;
      }
      markDirty();
    }

    /* ── Tool API ── */
    function setTool(tool) {
      S.tool = tool;
      const cursors = {
        pen: 'crosshair', eraser: 'cell', hand: 'grab',
        text: 'text', rect: 'crosshair', ellipse: 'crosshair',
        diamond: 'crosshair', line: 'crosshair', arrow: 'crosshair',
      };
      canvas.style.cursor = cursors[tool] || 'crosshair';
      options.root?.querySelectorAll('[data-wb-tool]').forEach(btn =>
        btn.classList.toggle('active', btn.dataset.wbTool === tool)
      );
    }

    function setColor(c)   { S.color   = c; }
    function setSize(n)    { S.size    = Number(n) || 3; }
    function setFill(f)    { S.fill    = f; }
    function setOpacity(o) { S.opacity = clamp(Number(o), 0, 1); }

    function undo() {
      if (!S.elements.length) return;
      S.redo.push(S.elements.pop());
      emit('undo', null); markDirty();
    }
    function redo() {
      if (!S.redo.length) return;
      S.elements.push(S.redo.pop());
      emit('redo', null); markDirty();
    }
    function clear() {
      S.elements = []; S.redo = []; S.live = null; S.remoteLive = null;
      emit('clear', null); markDirty();
    }
    function exportPNG() {
      const link = document.createElement('a');
      link.download = 'phonelink-whiteboard.png';
      link.href = canvas.toDataURL('image/png', 0.95);
      link.click();
    }
    function resetView() {
      S.zoom = 1; S.panX = 0; S.panY = 0;
      updateZoomLabel(); markDirty();
    }
    function updateZoomLabel() {
      const lbl = options.root?.querySelector('[data-wb-zoom]');
      if (lbl) lbl.textContent = Math.round(S.zoom * 100) + '%';
    }
    function getState() { return { elements: S.elements }; }

    /* ── Control bindings ── */
    function bindControls() {
      const root = options.root;
      if (!root) return;
      root.querySelectorAll('[data-wb-tool]').forEach(btn =>
        btn.addEventListener('click', () => setTool(btn.dataset.wbTool))
      );
      root.querySelector('[data-wb-color]')
        ?.addEventListener('input', e => setColor(e.target.value));
      root.querySelector('[data-wb-size]')
        ?.addEventListener('input', e => setSize(e.target.value));
      root.querySelector('[data-wb-fill]')
        ?.addEventListener('change', e => setFill(e.target.value));
      root.querySelector('[data-wb-undo]')  ?.addEventListener('click', undo);
      root.querySelector('[data-wb-redo]')  ?.addEventListener('click', redo);
      root.querySelector('[data-wb-clear]') ?.addEventListener('click', clear);
      root.querySelector('[data-wb-export]')?.addEventListener('click', exportPNG);
      root.querySelector('[data-wb-reset]') ?.addEventListener('click', resetView);
    }

    /* ── Wire up events ── */
    // Use the canvas wrapper if available so the full area is hit-tested
    const target = canvas;
    target.addEventListener('pointerdown',   onPointerDown,  { passive: false });
    target.addEventListener('pointermove',   onPointerMove,  { passive: false });
    target.addEventListener('pointerup',     onPointerUp,    { passive: false });
    target.addEventListener('pointercancel', onPointerUp,    { passive: false });
    target.addEventListener('wheel',         onWheel,        { passive: false });
    // Touch events for pinch zoom (pointer events handle the rest)
    target.addEventListener('touchstart',  onTouchStart, { passive: false });
    target.addEventListener('touchmove',   onTouchMove,  { passive: false });
    target.addEventListener('touchend',    onTouchEnd,   { passive: false });
    target.addEventListener('touchcancel', onTouchEnd,   { passive: false });
    window.addEventListener('resize', resize);

    // Keyboard shortcuts (laptop)
    document.addEventListener('keydown', e => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      const map = { p:'pen', e:'eraser', h:'hand', t:'text',
                    r:'rect', d:'diamond', o:'ellipse', l:'line', a:'arrow' };
      if (map[e.key]) { setTool(map[e.key]); return; }
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); undo(); }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'Z') { e.preventDefault(); redo(); }
      if (e.key === '0') resetView();
    });

    bindControls();
    resize();
    setTool('pen');
    markDirty();

    return {
      receive, resize, setTool, setColor, setSize, setFill, setOpacity,
      undo, redo, clear, exportPNG, resetView, getState,
      get state() { return S; },
    };
  }

  window.PhoneLinkWhiteboard = { create: createWhiteboard };
})();

/**
 * Sunray / CaSSAndRA Map Card
 *
 * A plain-canvas Lovelace card that renders the live mowing map from the
 * sunray_cassandra integration's "Map Data" sensor entity.
 *
 * Data contract (sensor extra_state_attributes):
 *   origin_lat       float   WGS-84 latitude  (unused for rendering — coords are already local metres)
 *   origin_lon       float   WGS-84 longitude (unused for rendering)
 *   geojson_layers   dict    keyed by CaSSAndRA layer name string:
 *                              "current map"      → FeatureCollection (perimeter, dockpoints, exclusions)
 *                              "current mow path" → FeatureCollection (mow path LineString)
 *                              "obstacles"        → FeatureCollection (obstacle Polygons)
 *   finished_idx     int     mow-point index up to which path is "done"
 *   idx_total        int     total mow-point count
 *   mow_progress_pct int     0-100
 *   position_x       float   rover X in metres (local, relative to GPS origin)
 *   position_y       float   rover Y in metres (local, relative to GPS origin)
 *
 * GeoJSON quirks from CaSSAndRA:
 *   - Feature 0 in every FeatureCollection is a header with no geometry.
 *   - mowPath LineString coordinates are double-wrapped:
 *       coordinates: [[[x,y], [x,y], ...]]   (extra outer array)
 *   - All coordinates are [x, y] in metres relative to the GPS origin.
 *   - Y axis in CaSSAndRA is "northward" positive; canvas Y is inverted,
 *     so we flip Y when projecting.
 */

const CARD_VERSION = "0.2.1";

// ─── Default colours (all overridable via card config) ──────────────────────
const DEFAULTS = {
  background:       null,            // null = use HA card background CSS variable
  perimeter_fill:   "rgba(34, 139, 34, 0.18)",
  perimeter_stroke: "#4caf50",
  exclusion_fill:   "rgba(180, 30, 30, 0.25)",
  exclusion_stroke: "#e53935",
  obstacle_fill:    "rgba(255, 152, 0, 0.35)",
  obstacle_stroke:  "#ff9800",
  mow_done:         "#1565c0",
  mow_todo:         "rgba(100, 181, 246, 0.45)",
  dock_stroke:      "#ffd54f",
  rover_fill:       "#ffffff",
  rover_stroke:     "#00e5ff",
  rover_radius:     6,        // px
  padding:          16,       // px around the map content
  height:           400,      // px
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Unwrap CaSSAndRA's double-wrapped LineString coordinates.
 * Standard GeoJSON: coordinates = [[x,y], [x,y], ...]
 * CaSSAndRA:        coordinates = [[[x,y], [x,y], ...]]
 */
function unwrapLineString(coords) {
  if (!Array.isArray(coords) || coords.length === 0) return [];
  if (Array.isArray(coords[0]) && Array.isArray(coords[0][0])) {
    // double-wrapped — take the inner array
    return coords[0];
  }
  return coords;
}

/**
 * Compute the axis-aligned bounding box across all [x,y] point arrays.
 * Returns { minX, maxX, minY, maxY } or null if no points.
 */
function computeBBox(pointArrays) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  let hasPoints = false;
  for (const pts of pointArrays) {
    for (const [x, y] of pts) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      hasPoints = true;
    }
  }
  return hasPoints ? { minX, maxX, minY, maxY } : null;
}

/**
 * Build a projection function [x,y] → [cx,cy] (canvas pixels) that fits
 * the bounding box into the canvas with padding, and flips Y.
 */
function makeProjection(bbox, canvasWidth, canvasHeight, padding) {
  const { minX, maxX, minY, maxY } = bbox;
  const mapW = maxX - minX || 1;
  const mapH = maxY - minY || 1;
  const drawW = canvasWidth  - padding * 2;
  const drawH = canvasHeight - padding * 2;
  const scale = Math.min(drawW / mapW, drawH / mapH);
  // Centre the map within the draw area
  const offsetX = padding + (drawW - mapW * scale) / 2;
  const offsetY = padding + (drawH - mapH * scale) / 2;

  return ([x, y]) => [
    offsetX + (x - minX) * scale,
    // flip Y so that "north" (positive Y) is upward on canvas
    canvasHeight - offsetY - (y - minY) * scale,
  ];
}

// ─── Card class ──────────────────────────────────────────────────────────────

class SunrayCassandraMapCard extends HTMLElement {
  // Called once when the element is created
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = {};
    this._hass   = null;
    this._rafId  = null;
    this._dirty  = false;

    // Zoom / pan state (user-driven via pinch & drag)
    this._zoom   = 1;       // multiplicative zoom on top of auto-fit
    this._panX   = 0;       // pixel offset X (in display pixels)
    this._panY   = 0;       // pixel offset Y
  }

  // ── Lovelace lifecycle ───────────────────────────────────────────────────

  setConfig(config) {
    if (!config.entity) {
      throw new Error("sunray-cassandra-map-card: 'entity' is required");
    }
    this._config = { ...DEFAULTS, ...config };
    this._ensureDOM();
  }

  set hass(hass) {
    this._hass  = hass;
    this._dirty = true;
    this._scheduleRender();
  }

  // ── DOM bootstrap ────────────────────────────────────────────────────────

  _ensureDOM() {
    if (this._canvas) return;

    const style = document.createElement("style");
    style.textContent = `
      :host { display: block; }
      ha-card {
        overflow: hidden;
        background: var(--card-background-color, #1c1c1e);
        border-radius: var(--ha-card-border-radius, 12px);
      }
      .card-header {
        padding: 12px 16px 4px;
        font-size: 1em;
        font-weight: 500;
        color: var(--primary-text-color, #fff);
        display: flex;
        align-items: center;
        gap: 8px;
      }
      canvas {
        display: block;
        width: 100%;
        touch-action: none;
        cursor: grab;
      }
      .status-bar {
        padding: 4px 16px 10px;
        font-size: 1em;
        color: var(--secondary-text-color, #aaa);
        display: flex;
        gap: 16px;
        flex-wrap: wrap;
      }
      .offline {
        padding: 24px 16px;
        text-align: center;
        color: var(--secondary-text-color, #888);
        font-size: 0.9em;
      }
    `;

    const card = document.createElement("ha-card");
    card.innerHTML = `
      <canvas></canvas>
      <div class="status-bar"></div>
    `;

    this._card      = card;
    this._titleEl   = null;
    this._canvas    = card.querySelector("canvas");
    this._statusBar = card.querySelector(".status-bar");
    this._ctx       = this._canvas.getContext("2d");

    this.shadowRoot.append(style, card);

    // ── Touch zoom / pan ─────────────────────────────────────────────────
    this._initTouchHandlers();

    // Observe resize so the canvas scales with the card
    this._resizeObserver = new ResizeObserver(() => {
      this._dirty = true;
      this._scheduleRender();
    });
    this._resizeObserver.observe(this._canvas);
  }

  // ── Touch zoom / pan handlers ────────────────────────────────────────────

  _initTouchHandlers() {
    const canvas = this._canvas;

    // Internal touch tracking
    let _touches      = [];   // active touch list (copies)
    let _lastDist     = null; // last pinch distance (px)
    let _lastMidX     = null; // last pinch midpoint X
    let _lastMidY     = null; // last pinch midpoint Y
    let _lastSingleX  = null; // last single-finger X
    let _lastSingleY  = null; // last single-finger Y

    const dist = (a, b) =>
      Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY);

    const mid = (a, b) => ({
      x: (a.clientX + b.clientX) / 2,
      y: (a.clientY + b.clientY) / 2,
    });

    const canvasRect = () => canvas.getBoundingClientRect();

    canvas.addEventListener("touchstart", (e) => {
      e.preventDefault();
      _touches = Array.from(e.touches);
      if (_touches.length === 2) {
        _lastDist = dist(_touches[0], _touches[1]);
        const m = mid(_touches[0], _touches[1]);
        _lastMidX = m.x;
        _lastMidY = m.y;
      } else if (_touches.length === 1) {
        _lastSingleX = _touches[0].clientX;
        _lastSingleY = _touches[0].clientY;
      }
    }, { passive: false });

    canvas.addEventListener("touchmove", (e) => {
      e.preventDefault();
      _touches = Array.from(e.touches);

      if (_touches.length === 2) {
        // ── Pinch zoom ──────────────────────────────────────────────────
        const newDist = dist(_touches[0], _touches[1]);
        const m       = mid(_touches[0], _touches[1]);
        const rect    = canvasRect();

        if (_lastDist !== null) {
          const ratio   = newDist / _lastDist;
          const newZoom = Math.min(Math.max(this._zoom * ratio, 0.5), 10);

          // Zoom towards the pinch midpoint (in canvas-local coords)
          const midX = m.x - rect.left;
          const midY = m.y - rect.top;
          const cw   = canvas.clientWidth;
          const ch   = canvas.clientHeight;
          const cx   = cw / 2;
          const cy   = ch / 2;

          // Current mapped position of midpoint before zoom:
          // px = cx + panX + (midX - cx) * zoom  → solve for new panX/Y
          const zoomDelta = newZoom / this._zoom;
          this._panX = (this._panX + midX - cx) * zoomDelta - (midX - cx);
          this._panY = (this._panY + midY - cy) * zoomDelta - (midY - cy);
          this._zoom = newZoom;

          // Pan with midpoint movement
          this._panX += m.x - _lastMidX;
          this._panY += m.y - _lastMidY;
        }

        _lastDist = newDist;
        _lastMidX = m.x;
        _lastMidY = m.y;
        _lastSingleX = null;
        _lastSingleY = null;

        this._dirty = true;
        this._scheduleRender();

      } else if (_touches.length === 1 && this._zoom > 1) {
        // ── Single-finger pan (only when zoomed in) ─────────────────────
        if (_lastSingleX !== null) {
          this._panX += _touches[0].clientX - _lastSingleX;
          this._panY += _touches[0].clientY - _lastSingleY;
          this._dirty = true;
          this._scheduleRender();
        }
        _lastSingleX = _touches[0].clientX;
        _lastSingleY = _touches[0].clientY;
        _lastDist    = null;
      }
    }, { passive: false });

    canvas.addEventListener("touchend", (e) => {
      _touches = Array.from(e.touches);
      if (_touches.length < 2) {
        _lastDist = null;
        _lastMidX = null;
        _lastMidY = null;
      }
      if (_touches.length < 1) {
        _lastSingleX = null;
        _lastSingleY = null;
      }
    }, { passive: true });

    // Double-tap to reset zoom/pan
    let _lastTap = 0;
    canvas.addEventListener("touchend", (e) => {
      if (e.changedTouches.length !== 1) return;
      const now = Date.now();
      if (now - _lastTap < 300) {
        this._zoom = 1;
        this._panX = 0;
        this._panY = 0;
        this._dirty = true;
        this._scheduleRender();
      }
      _lastTap = now;
    }, { passive: true });
  }

  // ── Render scheduling ────────────────────────────────────────────────────

  _scheduleRender() {
    if (this._rafId) return;
    this._rafId = requestAnimationFrame(() => {
      this._rafId = null;
      if (this._dirty) {
        this._render();
        this._dirty = false;
      }
    });
  }

  // ── Main render ──────────────────────────────────────────────────────────

  _render() {
    if (!this._hass || !this._config.entity) return;

    const stateObj = this._hass.states[this._config.entity];
    const cfg      = this._config;

    // Title
    const title = cfg.title ||
      (stateObj
        ? (this._hass.formatEntityAttributeValue?.(stateObj, "friendly_name")
           ?? stateObj.attributes.friendly_name
           ?? cfg.entity)
        : cfg.entity);
    if (this._titleEl) this._titleEl.textContent = title;

    if (!stateObj) {
      this._showOffline("Entity not found: " + cfg.entity);
      return;
    }

    const attrs = stateObj.attributes;
    const layers      = attrs.geojson_layers   ?? {};
    const finishedIdx = attrs.finished_idx     ?? 0;
    const posX        = attrs.position_x;
    const posY        = attrs.position_y;
    const progress    = attrs.mow_progress_pct ?? stateObj.state;

    // ── Collect all coordinate arrays for bbox calculation ───────────────

    const mapFC      = layers["current map"];
    const pathFC     = layers["current mow path"];
    const obstFC     = layers["obstacles"];

    const perimeterPts  = [];
    const exclusionList = [];
    const dockPts       = [];
    let   mowPoints     = [];
    const obstaclePts   = [];

    // Parse currentMap features
    if (mapFC?.features) {
      for (const feat of mapFC.features) {
        if (!feat.geometry) continue;
        const name = feat.properties?.name ?? "";
        const geom = feat.geometry;
        if (name === "perimeter" && geom.type === "Polygon") {
          perimeterPts.push(...(geom.coordinates[0] ?? []));
        } else if (name === "exclusion" && geom.type === "Polygon") {
          exclusionList.push(geom.coordinates[0] ?? []);
        } else if (name === "dockpoints" && geom.type === "LineString") {
          dockPts.push(...(geom.coordinates ?? []));
        }
      }
    }

    // Parse mowPath
    if (pathFC?.features) {
      for (const feat of pathFC.features) {
        if (!feat.geometry) continue;
        if (feat.geometry.type === "LineString") {
          mowPoints = unwrapLineString(feat.geometry.coordinates);
        }
      }
    }

    // Parse obstacles
    if (obstFC?.features) {
      for (const feat of obstFC.features) {
        if (!feat.geometry) continue;
        if (feat.geometry.type === "Polygon" && feat.geometry.coordinates[0]?.length) {
          obstaclePts.push(feat.geometry.coordinates[0]);
        }
      }
    }

    // Rover position point
    const roverPt = (posX != null && posY != null) ? [[posX, posY]] : [];

    // ── Compute bounding box ─────────────────────────────────────────────

    const allPointSets = [
      perimeterPts,
      ...exclusionList,
      dockPts,
      mowPoints,
      ...obstaclePts,
      roverPt,
    ].filter(pts => pts.length > 0);

    const bbox = computeBBox(allPointSets);

    // ── Size canvas ──────────────────────────────────────────────────────

    const displayWidth  = this._canvas.clientWidth  || 400;
    const displayHeight = cfg.height;
    const dpr           = window.devicePixelRatio   || 1;

    this._canvas.width  = displayWidth  * dpr;
    this._canvas.height = displayHeight * dpr;
    this._canvas.style.height = displayHeight + "px";

    const ctx = this._ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Background — use configured colour or fall back to the HA card background CSS variable
    const bgColor = cfg.background ||
      getComputedStyle(this._card).getPropertyValue("--card-background-color").trim() ||
      "#1c1c1e";
    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, displayWidth, displayHeight);

    if (!bbox) {
      this._drawNoData(ctx, displayWidth, displayHeight);
      this._updateStatusBar(progress, posX, posY, stateObj);
      return;
    }

    const proj = makeProjection(bbox, displayWidth, displayHeight, cfg.padding);

    // Apply user zoom / pan on top of the auto-fit projection.
    // We zoom around the canvas centre.
    const cx = displayWidth  / 2;
    const cy = displayHeight / 2;
    ctx.save();
    ctx.translate(cx + this._panX, cy + this._panY);
    ctx.scale(this._zoom, this._zoom);
    ctx.translate(-cx, -cy);

    // ── Draw layers (back → front) ───────────────────────────────────────

    // 1. Perimeter fill
    if (perimeterPts.length > 1) {
      this._drawPolygon(ctx, perimeterPts, proj,
        cfg.perimeter_fill, cfg.perimeter_stroke, 1.5);
    }

    // 2. Exclusion zones
    for (const ring of exclusionList) {
      if (ring.length > 1) {
        this._drawPolygon(ctx, ring, proj,
          cfg.exclusion_fill, cfg.exclusion_stroke, 1.2);
      }
    }

    // 3. Mow path — split into done / todo segments
    if (mowPoints.length > 1) {
      const splitIdx = Math.min(Math.max(0, finishedIdx), mowPoints.length);

      // Todo portion (draw first so done overlays it)
      if (splitIdx < mowPoints.length) {
        this._drawPolyline(ctx, mowPoints.slice(splitIdx), proj,
          cfg.mow_todo, 1.0);
      }

      // Done portion
      if (splitIdx > 0) {
        this._drawPolyline(ctx, mowPoints.slice(0, splitIdx + 1), proj,
          cfg.mow_done, 1.5);
      }
    }

    // 4. Obstacles
    for (const ring of obstaclePts) {
      if (ring.length > 1) {
        this._drawPolygon(ctx, ring, proj,
          cfg.obstacle_fill, cfg.obstacle_stroke, 1.0);
      }
    }

    // 5. Dock approach line
    if (dockPts.length > 1) {
      this._drawPolyline(ctx, dockPts, proj, cfg.dock_stroke, 1.5, [4, 3]);
    }

    // 6. Rover position
    if (roverPt.length) {
      const [rx, ry] = proj(roverPt[0]);
      this._drawRover(ctx, rx, ry, cfg.rover_radius, cfg.rover_fill, cfg.rover_stroke);
    }

    ctx.restore();

    // ── Status bar ───────────────────────────────────────────────────────
    this._updateStatusBar(progress, posX, posY, stateObj);
  }

  // ── Drawing primitives ───────────────────────────────────────────────────

  _drawPolygon(ctx, ring, proj, fill, stroke, lineWidth) {
    ctx.beginPath();
    const [x0, y0] = proj(ring[0]);
    ctx.moveTo(x0, y0);
    for (let i = 1; i < ring.length; i++) {
      const [x, y] = proj(ring[i]);
      ctx.lineTo(x, y);
    }
    ctx.closePath();
    if (fill) {
      ctx.fillStyle = fill;
      ctx.fill();
    }
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth   = lineWidth;
      ctx.stroke();
    }
  }

  _drawPolyline(ctx, pts, proj, stroke, lineWidth, dash = []) {
    if (pts.length < 2) return;
    ctx.beginPath();
    ctx.setLineDash(dash);
    const [x0, y0] = proj(pts[0]);
    ctx.moveTo(x0, y0);
    for (let i = 1; i < pts.length; i++) {
      const [x, y] = proj(pts[i]);
      ctx.lineTo(x, y);
    }
    ctx.strokeStyle = stroke;
    ctx.lineWidth   = lineWidth;
    ctx.stroke();
    ctx.setLineDash([]);
  }

  _drawRover(ctx, cx, cy, r, fill, stroke) {
    // Outer glow
    const grd = ctx.createRadialGradient(cx, cy, r * 0.2, cx, cy, r * 2.5);
    grd.addColorStop(0, stroke.replace(")", ", 0.4)").replace("rgb", "rgba"));
    grd.addColorStop(1, "transparent");
    ctx.beginPath();
    ctx.arc(cx, cy, r * 2.5, 0, Math.PI * 2);
    ctx.fillStyle = grd;
    ctx.fill();

    // Circle body
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.strokeStyle = stroke;
    ctx.lineWidth   = 2;
    ctx.stroke();
  }

  _drawNoData(ctx, w, h) {
    ctx.fillStyle    = "rgba(255,255,255,0.2)";
    ctx.font         = "14px sans-serif";
    ctx.textAlign    = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("Waiting for map data…", w / 2, h / 2);
  }

  _showOffline(msg) {
    if (!this._card.querySelector(".offline")) {
      const div = document.createElement("div");
      div.className = "offline";
      this._card.querySelector("canvas").replaceWith(div);
    }
    this._card.querySelector(".offline").textContent = msg;
  }

  _updateStatusBar(progress, posX, posY, stateObj) {
    const parts = [];
    if (progress != null && progress !== "unknown") {
      parts.push(`Progress: ${progress}%`);
    }
    const status = stateObj?.attributes?.status
      ?? this._hass?.states[this._config.entity]?.attributes?.status;
    if (status) parts.push(`Status: ${status}`);
    this._statusBar.textContent = parts.join("  ·  ");
  }

  // ── HACS / Lovelace card metadata ────────────────────────────────────────

  static getConfigElement() {
    // Visual editor stub — Lovelace will fall back to YAML editor
    return null;
  }

  static getStubConfig() {
    return { entity: "sensor.cassandra_map_data" };
  }

  getCardSize() {
    return Math.ceil((this._config.height ?? DEFAULTS.height) / 50);
  }
}

customElements.define("sunray-cassandra-map-card", SunrayCassandraMapCard);

window.customCards = window.customCards || [];
window.customCards.push({
  type:        "sunray-cassandra-map-card",
  name:        "Sunray / CaSSAndRA Map Card",
  description: "Live canvas map for Sunray lawn mowers managed by CaSSAndRA",
  preview:     false,
  documentationURL: "https://github.com/ha-sunray-cassandra/ha-sunray-cassandra-map-card",
});

console.info(
  `%c SUNRAY-CASSANDRA-MAP-CARD %c v${CARD_VERSION} `,
  "background:#4caf50;color:#000;font-weight:bold;padding:2px 4px;border-radius:3px 0 0 3px",
  "background:#1a1a2e;color:#4caf50;font-weight:bold;padding:2px 4px;border-radius:0 3px 3px 0",
);

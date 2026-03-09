import { useState, useEffect, useRef } from 'react';
import { addMinimizeToggle } from './addMinimizeToggle.js';
import { makeDraggable } from './makeDraggable.js';

/**
 * MUF (Maximum Usable Frequency) Map Layer v1.0.0
 *
 * Renders a real-time MUF heatmap across the world using ionosonde station
 * data from the KC2G/GIRO network. Station MUF(3000) readings are spatially
 * interpolated using Inverse Distance Weighting to produce a smooth
 * color-coded overlay showing current HF propagation conditions.
 *
 * Color scale:
 *   ≤3 MHz  — dark purple  (no usable HF)
 *   5 MHz   — blue         (80m only)
 *   10 MHz  — cyan         (30m and below)
 *   14 MHz  — green        (20m open)
 *   21 MHz  — yellow       (15m open)
 *   28 MHz  — orange       (10m open)
 *   ≥35 MHz — red/magenta  (6m / sporadic-E)
 *
 * Data source: /api/ionosonde (server-proxied from prop.kc2g.com)
 * Update interval: 10 minutes
 */

export const metadata = {
  id: 'muf-map',
  name: 'MUF Map',
  description: 'Real-time Maximum Usable Frequency map from global ionosonde network',
  icon: '📡',
  category: 'propagation',
  defaultEnabled: false,
  defaultOpacity: 0.4,
  version: '1.0.0',
};

// ── Color scale: MUF frequency → RGBA ──────────────────────────────
// Designed for dark map backgrounds, smooth gradient across HF range
function mufColor(mhz) {
  if (mhz == null || mhz <= 0) return null;

  // Clamp to displayable range
  const f = Math.max(2, Math.min(40, mhz));

  let r, g, b;

  if (f < 5) {
    // 2–5 MHz: dark purple → blue
    const t = (f - 2) / 3;
    r = Math.round(60 + t * -10); // 60 → 50
    g = Math.round(0 + t * 40); // 0 → 40
    b = Math.round(120 + t * 95); // 120 → 215
  } else if (f < 10) {
    // 5–10 MHz: blue → cyan
    const t = (f - 5) / 5;
    r = Math.round(50 * (1 - t)); // 50 → 0
    g = Math.round(40 + t * 200); // 40 → 240
    b = Math.round(215 + t * 25); // 215 → 240
  } else if (f < 15) {
    // 10–15 MHz: cyan → green
    const t = (f - 10) / 5;
    r = Math.round(0 + t * 30); // 0 → 30
    g = Math.round(240 - t * 20); // 240 → 220
    b = Math.round(240 * (1 - t)); // 240 → 0
  } else if (f < 21) {
    // 15–21 MHz: green → yellow
    const t = (f - 15) / 6;
    r = Math.round(30 + t * 225); // 30 → 255
    g = Math.round(220 + t * 35); // 220 → 255
    b = 0;
  } else if (f < 28) {
    // 21–28 MHz: yellow → orange
    const t = (f - 21) / 7;
    r = 255;
    g = Math.round(255 - t * 140); // 255 → 115
    b = 0;
  } else {
    // 28–40 MHz: orange → red-magenta
    const t = Math.min((f - 28) / 12, 1);
    r = 255;
    g = Math.round(115 - t * 115); // 115 → 0
    b = Math.round(t * 80); // 0 → 80
  }

  return { r, g, b };
}

// ── IDW interpolation ──────────────────────────────────────────────
// Inverse Distance Weighting with power=2.5 and distance-capped influence
function interpolateMUF(lat, lon, stations, power = 2.5, maxDist = 4000) {
  let wSum = 0;
  let vSum = 0;

  for (let i = 0; i < stations.length; i++) {
    const s = stations[i];
    const d = haversine(lat, lon, s.lat, s.lon);
    if (d < 1) return s.mufd; // On top of a station
    if (d > maxDist) continue; // Too far, skip

    const w = 1 / Math.pow(d, power);
    wSum += w;
    vSum += w * s.mufd;
  }

  return wSum > 0 ? vSum / wSum : null;
}

// Fast haversine (km)
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * 0.017453293;
  const dLon = (lon2 - lon1) * 0.017453293;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * 0.017453293) * Math.cos(lat2 * 0.017453293) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Build canvas overlay from station data ─────────────────────────
// Creates equirectangular projection image -180..180 lon, -90..90 lat
const GRID_W = 360; // 1° per pixel longitude
const GRID_H = 181; // 1° per pixel latitude
const CANVAS_SCALE = 2; // 2x upscale for smooth rendering

function buildMUFCanvas(stations) {
  // Pre-filter valid stations
  const valid = stations.filter((s) => s.mufd > 0 && s.lat != null && s.lon != null);
  if (valid.length < 3) return null;

  const canvas = document.createElement('canvas');
  canvas.width = GRID_W;
  canvas.height = GRID_H;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, GRID_W, GRID_H);

  const imageData = ctx.createImageData(GRID_W, GRID_H);
  const pixels = imageData.data;

  // Step through each grid cell
  // x = 0..359 maps to lon = -180..179
  // y = 0..180 maps to lat = 90..-90 (north to south)
  for (let y = 0; y < GRID_H; y++) {
    const lat = 90 - y;
    for (let x = 0; x < GRID_W; x++) {
      const lon = x - 180;

      const muf = interpolateMUF(lat, lon, valid);
      if (muf == null) continue;

      const color = mufColor(muf);
      if (!color) continue;

      const idx = (y * GRID_W + x) * 4;
      pixels[idx] = color.r;
      pixels[idx + 1] = color.g;
      pixels[idx + 2] = color.b;
      pixels[idx + 3] = 180; // Base alpha (opacity handled by Leaflet)
    }
  }

  ctx.putImageData(imageData, 0, 0);

  // Upscale with smoothing for nicer rendering
  const smooth = document.createElement('canvas');
  smooth.width = GRID_W * CANVAS_SCALE;
  smooth.height = GRID_H * CANVAS_SCALE;
  const sctx = smooth.getContext('2d');
  sctx.imageSmoothingEnabled = true;
  sctx.imageSmoothingQuality = 'high';
  sctx.drawImage(canvas, 0, 0, smooth.width, smooth.height);

  return smooth.toDataURL('image/png');
}

// ── Layer hook ──────────────────────────────────────────────────────
export function useLayer({ map, enabled, opacity }) {
  const [stations, setStations] = useState(null);
  const [loading, setLoading] = useState(false);
  const [fetchTime, setFetchTime] = useState(null);
  const overlaysRef = useRef([]); // Array of L.imageOverlay (3 world copies)
  const controlRef = useRef(null);
  const fetchingRef = useRef(false);
  const intervalRef = useRef(null);

  // ── Fetch ionosonde data ──────────────────────────────────────
  useEffect(() => {
    if (!enabled) return;

    const fetchData = async () => {
      if (fetchingRef.current) return;
      fetchingRef.current = true;
      setLoading(true);
      try {
        const res = await fetch('/api/ionosonde');
        if (res.status === 429) {
          fetchingRef.current = false;
          setLoading(false);
          return;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (json.stations?.length > 0) {
          setStations(json.stations);
          setFetchTime(new Date().toISOString());
        }
      } catch (err) {
        console.error('[MUF Map] Fetch error:', err);
      } finally {
        fetchingRef.current = false;
        setLoading(false);
      }
    };

    fetchData();
    intervalRef.current = setInterval(fetchData, 10 * 60 * 1000); // 10 min
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [enabled]);

  // ── Render overlay on map ─────────────────────────────────────
  useEffect(() => {
    if (!map || typeof L === 'undefined') return;

    // Clear previous overlays
    overlaysRef.current.forEach((ov) => {
      try {
        map.removeLayer(ov);
      } catch (e) {}
    });
    overlaysRef.current = [];

    if (!enabled || !stations || stations.length < 3) return;

    try {
      const dataUrl = buildMUFCanvas(stations);
      if (!dataUrl) return;

      // Create 3 world copies so the overlay repeats when panning
      const newOverlays = [];
      for (const lonOffset of [-360, 0, 360]) {
        const overlay = L.imageOverlay(
          dataUrl,
          [
            [-90, -180 + lonOffset],
            [90, 180 + lonOffset],
          ],
          {
            opacity: opacity,
            zIndex: 200,
            interactive: false,
            className: 'muf-map-overlay',
          },
        );
        overlay.addTo(map);
        newOverlays.push(overlay);
      }
      overlaysRef.current = newOverlays;
    } catch (err) {
      console.error('[MUF Map] Render error:', err);
    }

    return () => {
      overlaysRef.current.forEach((ov) => {
        try {
          map.removeLayer(ov);
        } catch (e) {}
      });
    };
  }, [enabled, stations, map]);

  // ── Update opacity ────────────────────────────────────────────
  useEffect(() => {
    overlaysRef.current.forEach((ov) => {
      try {
        ov.setOpacity(opacity);
      } catch (e) {}
    });
  }, [opacity]);

  // ── Legend / control panel ────────────────────────────────────
  useEffect(() => {
    if (!map || typeof L === 'undefined') return;

    if (controlRef.current) {
      try {
        map.removeControl(controlRef.current);
      } catch (e) {}
      controlRef.current = null;
    }

    if (!enabled) return;

    const stationCount = stations?.length || 0;

    const MUFControl = L.Control.extend({
      options: { position: 'topright' },
      onAdd() {
        const container = L.DomUtil.create('div', 'muf-map-control');
        L.DomEvent.disableClickPropagation(container);
        L.DomEvent.disableScrollPropagation(container);

        container.innerHTML = `
          <div style="
            background: rgba(20, 20, 40, 0.92);
            border: 1px solid rgba(0, 180, 255, 0.4);
            border-radius: 8px;
            padding: 10px 12px;
            font-family: 'JetBrains Mono', monospace;
            font-size: 11px;
            color: #ddd;
            min-width: 170px;
            backdrop-filter: blur(8px);
          ">
            <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px;">
              <span data-drag-handle="true" style="color: #00b4ff; font-family: 'JetBrains Mono', monospace; font-weight: 700; font-size: 13px; cursor: grab; user-select: none;">📡 MUF Map</span>
              <button class="muf-minimize-btn" style="
                background: none; border: none; color: #888; font-size: 10px;
                cursor: pointer; padding: 2px 4px;
              ">▼</button>
            </div>
            <div class="muf-panel-content">
              <div style="
                display: flex; align-items: center; gap: 2px;
                background: rgba(0,0,0,0.3); border-radius: 4px; padding: 6px;
                margin-bottom: 6px;
              ">
                <div style="flex: 1; height: 10px; border-radius: 2px;
                  background: linear-gradient(to right,
                    rgb(60,0,120),
                    rgb(50,40,215),
                    rgb(0,240,240),
                    rgb(30,220,0),
                    rgb(255,255,0),
                    rgb(255,115,0),
                    rgb(255,0,80)
                  );"></div>
              </div>
              <div style="display: flex; justify-content: space-between; margin-bottom: 6px;">
                <span style="color: #888; font-size: 9px;">3 MHz</span>
                <span style="color: #888; font-size: 9px;">14</span>
                <span style="color: #888; font-size: 9px;">28</span>
                <span style="color: #888; font-size: 9px;">40+</span>
              </div>
              <div id="muf-status" style="color: #666; font-size: 9px; text-align: center;">
                ${loading ? 'Loading...' : stationCount > 0 ? `${stationCount} ionosondes` : 'Waiting for data...'}
              </div>
            </div>
          </div>
        `;
        return container;
      },
    });

    controlRef.current = new MUFControl();
    map.addControl(controlRef.current);

    setTimeout(() => {
      const container = controlRef.current?._container;
      if (!container) return;
      addMinimizeToggle(container, 'muf-map-position', {
        contentClassName: 'muf-panel-content',
        buttonClassName: 'muf-minimize-btn',
      });
      makeDraggable(container, 'muf-map-position');
    }, 150);
  }, [enabled, map, stations, loading]);

  // ── Update status text ────────────────────────────────────────
  useEffect(() => {
    const el = document.getElementById('muf-status');
    if (!el || !enabled) return;
    if (loading) {
      el.textContent = 'Loading...';
    } else if (stations?.length) {
      el.textContent = `${stations.length} ionosondes`;
    }
  }, [loading, stations, enabled]);

  // ── Cleanup on disable ────────────────────────────────────────
  useEffect(() => {
    if (!enabled && map) {
      if (controlRef.current) {
        try {
          map.removeControl(controlRef.current);
        } catch (e) {}
        controlRef.current = null;
      }
      overlaysRef.current.forEach((ov) => {
        try {
          map.removeLayer(ov);
        } catch (e) {}
      });
      overlaysRef.current = [];
    }
  }, [enabled, map]);

  return { stations, loading, fetchTime };
}

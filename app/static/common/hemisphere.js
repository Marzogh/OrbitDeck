(() => {
  const VIEWBOX = 240;
  const CENTER = 120;
  const RADIUS = 88;
  let renderCount = 0;

  function clampUnit(value) {
    return Math.max(-1, Math.min(1, value));
  }

  function normalizeDeltaLon(deltaLon) {
    return ((deltaLon + 540) % 360) - 180;
  }

  function nearestPathPoint(items, iso) {
    if (!iso || !items?.length) return null;
    const target = new Date(iso).getTime();
    let best = null;
    for (const item of items) {
      const ts = new Date(item.timestamp).getTime();
      const delta = Math.abs(ts - target);
      if (!best || delta < best.delta) best = { item, delta };
    }
    return best && best.delta <= 120000 ? best.item : null;
  }

  function projectHemispherePoint(latDeg, lonDeg, observerLatDeg, observerLonDeg) {
    const lat = (latDeg * Math.PI) / 180;
    const observerLat = (observerLatDeg * Math.PI) / 180;
    const deltaLon = (normalizeDeltaLon(lonDeg - observerLonDeg) * Math.PI) / 180;
    const sinObserver = Math.sin(observerLat);
    const cosObserver = Math.cos(observerLat);
    const sinLat = Math.sin(lat);
    const cosLat = Math.cos(lat);
    const cosC = clampUnit((sinObserver * sinLat) + (cosObserver * cosLat * Math.cos(deltaLon)));
    if (cosC < 0) return null;
    const c = Math.acos(cosC);
    const rawX = cosLat * Math.sin(deltaLon);
    const rawY = (cosObserver * sinLat) - (sinObserver * cosLat * Math.cos(deltaLon));
    const scale = c < 1e-9 ? 1 : c / Math.max(Math.sin(c), 1e-9);
    const horizonScale = RADIUS / (Math.PI / 2);
    return {
      x: CENTER + (rawX * scale * horizonScale),
      y: CENTER - (rawY * scale * horizonScale),
    };
  }

  function pathDataForPoints(points) {
    if (!points.length) return "";
    return points.map((point, idx) => `${idx === 0 ? "M" : "L"} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(" ");
  }

  function projectVisibleSegments(samples, observer, valueSelector, jumpThreshold = RADIUS * 0.42) {
    const segments = [];
    let current = [];
    let previousProjected = null;
    let previousValue = null;
    for (const sample of samples || []) {
      const value = valueSelector(sample);
      const lat = Number(value?.lat);
      const lon = Number(value?.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        if (current.length > 1) segments.push(current);
        current = [];
        previousProjected = null;
        previousValue = null;
        continue;
      }
      const projected = projectHemispherePoint(lat, lon, observer.lat, observer.lon);
      if (!projected) {
        if (current.length > 1) segments.push(current);
        current = [];
        previousProjected = null;
        previousValue = { lat, lon };
        continue;
      }
      const largeScreenJump = previousProjected
        ? Math.hypot(projected.x - previousProjected.x, projected.y - previousProjected.y) > jumpThreshold
        : false;
      const largeLonJump = previousValue
        ? Math.abs(normalizeDeltaLon(lon - previousValue.lon)) > 120
        : false;
      if ((largeScreenJump || largeLonJump) && current.length > 1) {
        segments.push(current);
        current = [];
      }
      current.push(projected);
      previousProjected = projected;
      previousValue = { lat, lon };
    }
    if (current.length > 1) segments.push(current);
    return segments;
  }

  function nearestPathIndex(pathItems, track) {
    if (!pathItems?.length) return -1;
    const targetMs = new Date(track?.timestamp || Date.now()).getTime();
    let bestIdx = -1;
    let bestDelta = Infinity;
    pathItems.forEach((item, idx) => {
      const ts = new Date(item.timestamp).getTime();
      const delta = Math.abs(ts - targetMs);
      if (delta < bestDelta) {
        bestDelta = delta;
        bestIdx = idx;
      }
    });
    return bestIdx;
  }

  function hemisphereGraticule(observer) {
    const latitudeLines = [-60, -30, 0, 30, 60];
    const longitudeLines = [-150, -120, -90, -60, -30, 0, 30, 60, 90, 120, 150, 180];
    const latitudePaths = latitudeLines.map((lat) => {
      const samples = [];
      for (let lon = -180; lon <= 180; lon += 4) samples.push({ lat, lon });
      const segs = projectVisibleSegments(samples, observer, (sample) => sample);
      return segs.map(pathDataForPoints).filter(Boolean).map((d) => `<path d="${d}" class="hemisphere-grid hemisphere-grid-lat"></path>`).join("");
    }).join("");
    const longitudePaths = longitudeLines.map((lon) => {
      const samples = [];
      for (let lat = -88; lat <= 88; lat += 4) samples.push({ lat, lon });
      const segs = projectVisibleSegments(samples, observer, (sample) => sample);
      return segs.map(pathDataForPoints).filter(Boolean).map((d) => `<path d="${d}" class="hemisphere-grid hemisphere-grid-lon"></path>`).join("");
    }).join("");
    return `${latitudePaths}${longitudePaths}`;
  }

  function hemisphereLandPaths(observer) {
    const rings = Array.isArray(window.TRACKER_HEMISPHERE_LAND) ? window.TRACKER_HEMISPHERE_LAND : [];
    return rings.map((ring) => {
      const segs = projectVisibleSegments(ring, observer, (point) => ({ lat: point[1], lon: point[0] }));
      return segs.map((segment) => {
        if (segment.length < 2) return "";
        return `<path d="${pathDataForPoints(segment)}" class="hemisphere-land"></path>`;
      }).join("");
    }).join("");
  }

  function hemisphereFutureArrow(pathItems, observer, splitIdx) {
    const source = (splitIdx >= 0 ? pathItems.slice(splitIdx) : pathItems) || [];
    if (source.length < 2) return "";
    const visiblePoints = [];
    for (const item of source) {
      const projected = projectHemispherePoint(Number(item.subpoint_lat), Number(item.subpoint_lon), observer.lat, observer.lon);
      if (!projected) continue;
      if (visiblePoints.length) {
        const prev = visiblePoints[visiblePoints.length - 1];
        if (Math.hypot(projected.x - prev.x, projected.y - prev.y) > (RADIUS * 0.42)) visiblePoints.length = 0;
      }
      visiblePoints.push(projected);
      if (visiblePoints.length >= 4) break;
    }
    if (visiblePoints.length < 2) return "";
    const from = visiblePoints[Math.max(0, visiblePoints.length - 2)];
    const to = visiblePoints[visiblePoints.length - 1];
    const angle = Math.atan2(to.y - from.y, to.x - from.x) * 180 / Math.PI;
    return `<g class="hemisphere-arrow" transform="translate(${to.x.toFixed(2)} ${to.y.toFixed(2)}) rotate(${angle.toFixed(2)})"><path d="M -9 -4 L 0 0 L -9 4"></path></g>`;
  }

  function hemisphereTcaMarker(pass, pathItems, observer) {
    const item = nearestPathPoint(pathItems, pass?.tca);
    if (!item) return "";
    const projected = projectHemispherePoint(Number(item.subpoint_lat), Number(item.subpoint_lon), observer.lat, observer.lon);
    if (!projected) return "";
    return `<g class="hemisphere-event"><circle cx="${projected.x.toFixed(2)}" cy="${projected.y.toFixed(2)}" r="4.2"></circle><text x="${(projected.x + 8).toFixed(2)}" y="${(projected.y - 10).toFixed(2)}">TCA</text></g>`;
  }

  function render(options) {
    const {
      pass = null,
      pathItems = [],
      track = null,
      observerLocation = null,
      ariaLabel = "Ground track globe",
      className = "hemisphere-map",
      showTcaLabel = true,
      showDirectionArrow = true,
      showObserverMarker = true,
      emptyText = "Pass path unavailable",
    } = options || {};
    const observer = {
      lat: Number(observerLocation?.lat ?? 0),
      lon: Number(observerLocation?.lon ?? 0),
    };
    const splitIdx = nearestPathIndex(pathItems, track);
    const pastItems = splitIdx >= 0 ? pathItems.slice(0, splitIdx + 1) : [];
    const futureItems = splitIdx >= 0 ? pathItems.slice(splitIdx) : pathItems;
    const pastPaths = projectVisibleSegments(pastItems, observer, (item) => ({ lat: item.subpoint_lat, lon: item.subpoint_lon }))
      .map(pathDataForPoints)
      .filter(Boolean);
    const futurePaths = projectVisibleSegments(futureItems, observer, (item) => ({ lat: item.subpoint_lat, lon: item.subpoint_lon }))
      .map(pathDataForPoints)
      .filter(Boolean);
    const livePoint = track
      ? projectHemispherePoint(Number(track.subpoint_lat), Number(track.subpoint_lon), observer.lat, observer.lon)
      : null;
    const empty = !pastPaths.length && !futurePaths.length
      ? `<text x="${CENTER}" y="${CENTER + 6}" text-anchor="middle" class="hemisphere-empty">${emptyText}</text>`
      : "";
    const id = `hemisphere-${renderCount++}`;
    const liveMarker = livePoint
      ? `
        <circle cx="${livePoint.x.toFixed(2)}" cy="${livePoint.y.toFixed(2)}" r="10.5" class="hemisphere-live-halo"></circle>
        <circle cx="${livePoint.x.toFixed(2)}" cy="${livePoint.y.toFixed(2)}" r="4.8" class="hemisphere-live-dot"></circle>
      `
      : "";
    return `
      <svg viewBox="0 0 ${VIEWBOX} ${VIEWBOX}" class="${className}" aria-label="${ariaLabel}">
        <defs>
          <radialGradient id="${id}-ocean" cx="38%" cy="32%" r="84%">
            <stop offset="0%" stop-color="rgba(84,119,171,0.86)"></stop>
            <stop offset="58%" stop-color="rgba(44,58,97,0.95)"></stop>
            <stop offset="100%" stop-color="rgba(12,18,33,1)"></stop>
          </radialGradient>
          <clipPath id="${id}-clip">
            <circle cx="${CENTER}" cy="${CENTER}" r="${RADIUS}"></circle>
          </clipPath>
        </defs>
        <circle cx="${CENTER}" cy="${CENTER}" r="${RADIUS + 13}" class="hemisphere-atmosphere"></circle>
        <circle cx="${CENTER}" cy="${CENTER}" r="${RADIUS}" class="hemisphere-disc" fill="url(#${id}-ocean)"></circle>
        <g clip-path="url(#${id}-clip)">
          ${hemisphereGraticule(observer)}
          ${hemisphereLandPaths(observer)}
          ${pastPaths.map((d) => `<path d="${d}" class="hemisphere-track hemisphere-track-past"></path>`).join("")}
          ${futurePaths.map((d) => `<path d="${d}" class="hemisphere-track hemisphere-track-future"></path>`).join("")}
          ${showDirectionArrow ? hemisphereFutureArrow(pathItems, observer, splitIdx) : ""}
          ${showTcaLabel ? hemisphereTcaMarker(pass, pathItems, observer) : ""}
          ${liveMarker}
          ${empty}
        </g>
        <circle cx="${CENTER}" cy="${CENTER}" r="${RADIUS}" class="hemisphere-rim"></circle>
        ${showObserverMarker ? `<circle cx="${CENTER}" cy="${CENTER}" r="4.5" class="hemisphere-observer"></circle>` : ""}
      </svg>
    `;
  }

  window.issTrackerHemisphere = {
    render,
    projectPoint: projectHemispherePoint,
  };
})();

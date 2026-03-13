const api = {
  get: async (path) => {
    const res = await fetch(path);
    if (!res.ok) {
      let detail = "";
      try {
        const payload = await res.json();
        detail = payload?.detail ? `: ${payload.detail}` : "";
      } catch {}
      throw new Error(`GET ${path} failed: ${res.status}${detail}`);
    }
    return res.json();
  },
  post: async (path, body) => {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      let detail = "";
      try {
        const payload = await res.json();
        detail = payload?.detail ? `: ${payload.detail}` : "";
      } catch {}
      throw new Error(`POST ${path} failed: ${res.status}${detail}`);
    }
    return res.json();
  },
};

function fmtUtc(iso) {
  const d = new Date(iso);
  return d.toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

function byId(id) {
  return document.getElementById(id);
}

async function setBrowserLocation() {
  if (!navigator.geolocation) {
    throw new Error("Browser geolocation not supported");
  }
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const payload = {
          browser_location: {
            lat: Number(pos.coords.latitude.toFixed(6)),
            lon: Number(pos.coords.longitude.toFixed(6)),
            alt_m: Number((pos.coords.altitude || 0).toFixed(1)),
          },
        };
        try {
          await api.post("/api/v1/location", payload);
          resolve(payload.browser_location);
        } catch (err) {
          reject(err);
        }
      },
      (err) => reject(err),
      { enableHighAccuracy: true, maximumAge: 15000, timeout: 10000 }
    );
  });
}

window.issTracker = { api, fmtUtc, byId, setBrowserLocation };

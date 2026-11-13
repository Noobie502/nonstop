(() => {
  "use strict";
  const HUBS = ["BKK", "SIN", "DXB", "LHR", "FRA", "IST", "ATL", "LAX", "SYD", "HND"];
  const AIRLINE_PICKS = ["TG", "SQ", "EK", "QF", "LH", "FR", "WN", "AK"];
  const AIRCRAFT_PICKS = ["Airbus A380", "Boeing 747", "Boeing 787 Dreamliner", "Airbus A350", "Airbus A220", "COMAC C919"];
  const VER = 10;
  const R = 6371;
  const COPIES = [-360, 0, 360];
  const KEY = (s, d) => s * 10000 + d;
  const rad = (d) => (d * Math.PI) / 180;
  const deg = (r) => (r * 180) / Math.PI;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const isMobile = () => window.matchMedia("(max-width: 760px)").matches;

  // ---------- settings (per browser) ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem("nonstop:" + k); return v === null ? d : v; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem("nonstop:" + k, v); } catch (e) { /* private mode */ } },
  };
  const guessMiles = /^en-(US|GB|LR|MM)$/i.test(navigator.language || "");
  const guess12h = /^en-(US|CA|AU|NZ|PH|IN)$/i.test(navigator.language || "");
  let UNITS = store.get("units", guessMiles ? "mi" : "km");
  let CLOCK = store.get("clock", guess12h ? "12" : "24");
  const fmtDist = (km) => UNITS === "mi" ? `${Math.round(km * 0.621371).toLocaleString()} mi` : `${Math.round(km).toLocaleString()} km`;
  const fmtTime = (m) => {
    const h = Math.floor(m / 60), mm = String(m % 60).padStart(2, "0");
    if (CLOCK === "12") return `${h % 12 || 12}:${mm} ${h < 12 ? "am" : "pm"}`;
    return `${String(h).padStart(2, "0")}:${mm}`;
  };
  const fmtDur = (m) => (m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`);
  const plural = (n, one, many = one + "s") => `${n.toLocaleString()} ${n === 1 ? one : many}`;

  // screen-reader announcements
  let liveTimer = null;
  function announce(msg) {
    clearTimeout(liveTimer);
    liveTimer = setTimeout(() => { $("live").textContent = msg; }, 350);
  }

  // ---------- data ----------
  let A = [], AL = [], ROUTES = [], META = {}, TYPES = null;
  const byCode = new Map();       // IATA -> airport index
  const pairMap = new Map();      // KEY(s, d) -> { min, als }
  const detailCache = new Map();  // IATA -> Promise<{ det, types }>
  let alPairs = [];               // airline -> [[s, d], ...]
  let AC = null, acLoad = null;   // aircraft families

  // ---------- state ----------
  let view = null;        // { mode: "airport", ... } | { mode: "network", kind, id, ... }
  let section = "intro";  // which panel section is showing
  let routeOpen = null;   // { s, d, prev }
  let routeLines = new Map(); // KEY -> polyline for the current drawing
  let hoverKey = null, selectedKey = null;
  let depth = 0;          // how many in-app history entries we pushed

  // ---------- map ----------
  const map = L.map("map", {
    worldCopyJump: false, minZoom: 2, maxZoom: 9, zoomSnap: 0.5,
    maxBounds: [[-85, -540], [85, 540]], maxBoundsViscosity: 0.8,
    zoomAnimation: !REDUCED, fadeAnimation: !REDUCED, markerZoomAnimation: !REDUCED,
  }).setView([25, 20], 2);
  map.attributionControl.setPrefix('<a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>');
  map.createPane("land").style.zIndex = 200;
  const landRenderer = L.canvas({ pane: "land", padding: 0.5 });
  // one canvas for dots and routes, so the top layer never swallows clicks meant for airports
  const canvas = L.canvas({ padding: 0.5, tolerance: 6 });
  const baseLayer = L.layerGroup().addTo(map);
  const routeLayer = L.layerGroup().addTo(map);
  const focusLayer = L.layerGroup().addTo(map);
  const LINE = { color: "#ffc164", weight: 1.3 };
  const LINE_HI = { color: "#6fd8ff", weight: 3, opacity: 1 };

  function fitTo(points, maxZoom = 6) {
    if (!points.length) return;
    if (points.length === 1) {
      REDUCED ? map.setView(points[0], 5) : map.flyTo(points[0], 5, { duration: 0.8 });
      return;
    }
    const opts = { padding: [40, 40], maxZoom };
    REDUCED ? map.fitBounds(points, opts) : map.flyToBounds(points, { ...opts, duration: 0.8 });
  }

  // ---------- geo ----------
  function distKm(a, b) {
    const [la1, lo1, la2, lo2] = [rad(a[4]), rad(a[5]), rad(b[4]), rad(b[5])];
    const h = Math.sin((la2 - la1) / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin((lo2 - lo1) / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  // great-circle points from a to b; longitudes unwrapped from startLon so lines never jump across the map
  function arc(a, b, startLon = a[5]) {
    const la1 = rad(a[4]), lo1 = rad(a[5]), la2 = rad(b[4]), lo2 = rad(b[5]);
    const d = 2 * Math.asin(Math.sqrt(Math.sin((la2 - la1) / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin((lo2 - lo1) / 2) ** 2));
    const n = Math.max(2, Math.ceil(deg(d) / 2));
    const pts = [];
    let prev = startLon;
    for (let i = 0; i <= n; i++) {
      const f = i / n;
      let lat = a[4], lon = a[5];
      if (d > 1e-9) {
        const s1 = Math.sin((1 - f) * d) / Math.sin(d), s2 = Math.sin(f * d) / Math.sin(d);
        const x = s1 * Math.cos(la1) * Math.cos(lo1) + s2 * Math.cos(la2) * Math.cos(lo2);
        const y = s1 * Math.cos(la1) * Math.sin(lo1) + s2 * Math.cos(la2) * Math.sin(lo2);
        const z = s1 * Math.sin(la1) + s2 * Math.sin(la2);
        lat = deg(Math.atan2(z, Math.hypot(x, y)));
        lon = deg(Math.atan2(y, x));
      }
      while (lon - prev > 180) lon -= 360;
      while (lon - prev < -180) lon += 360;
      prev = lon;
      pts.push([lat, lon]);
    }
    return pts;
  }
  const estDur = (km) => Math.round((km / 820 + 0.5) * 60 / 5) * 5;

  // ---------- load ----------
  fetch("data/world.json?v=2").then((r) => r.json()).then((world) => {
    COPIES.forEach((off) => L.geoJSON(world, {
      renderer: landRenderer, interactive: false, pane: "land",
      coordsToLatLng: (c) => L.latLng(c[1], c[0] + off),
      style: { fillColor: "#18222c", fillOpacity: 1, stroke: false },
    }).addTo(map));
  }).catch(() => {});

  fetch(`data/network.json?v=${VER}`).then((r) => r.json()).then((data) => {
    A = data.airports; AL = data.airlines; ROUTES = data.routes; META = data.meta || {};
    A.forEach((a, i) => byCode.set(a[0], i));
    alPairs = AL.map(() => []);
    ROUTES.forEach((list, s) => list.forEach(([d, min, ...als]) => {
      pairMap.set(KEY(s, d), { min, als });
      als.forEach((al) => alPairs[al].push([s, d]));
    }));
    drawBase();
    buildIntro();
    showMeta();
    $("loading").remove();
    depth = (history.state && history.state.d) || 0;
    render(location.hash.slice(1), false);
  }).catch(() => { $("loading").textContent = "Sorry, the route data couldn't load. Please refresh the page."; });

  function drawBase() {
    // busiest airports drawn last, so they sit on top where dots overlap at world zoom
    const order = A.map((_, i) => i).sort((x, y) => ROUTES[x].length - ROUTES[y].length);
    order.forEach((i) => {
      const a = A[i], n = ROUTES[i].length;
      COPIES.forEach((off) => {
        L.circleMarker([a[4], a[5] + off], {
          renderer: canvas, radius: n > 100 ? 3 : n > 20 ? 2.2 : 1.6,
          stroke: false, fillColor: "#7d8fa1", fillOpacity: 0.65,
        }).bindTooltip(`${esc(a[2])} (${a[0]})`, { direction: "top", offset: [0, -4] })
          .on("click", () => go(a[0]))
          .addTo(baseLayer);
      });
    });
  }
  const dimBase = (o) => baseLayer.eachLayer((m) => m.setStyle({ fillOpacity: o }));

  function showMeta() {
    const days = META.observedDays || [];
    const fmt = (s) => { try { return new Date(s + "T00:00:00Z").toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: "UTC" }); } catch (e) { return s; } };
    $("data-date").textContent = `Routes updated ${META.built ? fmt(META.built) : "weekly"}.` +
      (days.length ? ` Flights tracked ${fmt(days[0])} – ${fmt(days[days.length - 1])}.` : "");
  }

  // ---------- aircraft families ----------
  const shortName = (n) => n.replace(/^(Airbus|Boeing|Embraer|Bombardier|McDonnell Douglas|De Havilland|COMAC|Sukhoi|BAe) /, "").replace(" Dreamliner", "").replace(" family", "");
  const famSlug = (f) => AC.names[f].toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  function loadAircraft() {
    if (!acLoad) acLoad = fetch(`data/aircraft.json?v=${VER}`).then((r) => r.json()).then((d) => {
      AC = { names: d.families.map((f) => f[0]), routes: d.families.map((f) => f[1]), pairs: [], byOrigin: new Map() };
      d.pairs.forEach((flat, f) => {
        const list = [];
        for (let k = 0; k < flat.length; k += 3) {
          const s = flat[k], dd = flat[k + 1], al = flat[k + 2];
          list.push([s, dd, al]);
          let m = AC.byOrigin.get(s);
          if (!m) AC.byOrigin.set(s, (m = new Map()));
          let set = m.get(f);
          if (!set) m.set(f, (set = []));
          set.push([dd, al]);
        }
        AC.pairs.push(list);
      });
      return AC;
    }).catch(() => { acLoad = null; return null; });
    return acLoad;
  }
  function findFamily(slug) {
    const s = decodeURIComponent(slug).toLowerCase();
    const i = AC.names.findIndex((_, f) => famSlug(f) === s);
    return i >= 0 ? i : AC.names.findIndex((n) => n.toLowerCase().replace(/[^a-z0-9]/g, "").includes(s.replace(/[^a-z0-9]/g, "")));
  }

  // ---------- airlines ----------
  function findAirline(code) {
    const c = decodeURIComponent(code).toLowerCase();
    const hits = AL.map((a, i) => i).filter((i) => AL[i][1].toLowerCase() === c || AL[i][0].toLowerCase() === c);
    return hits.sort((x, y) => alPairs[y].length - alPairs[x].length)[0];
  }
  const alKey = (i) => encodeURIComponent(AL[i][1] || AL[i][0]);

  // ---------- history: every view has a URL, browser Back works ----------
  function go(hash) {
    depth += 1;
    history.pushState({ d: depth }, "", "#" + hash);
    render(hash, true);
  }
  function replaceHash(hash) {
    history.replaceState({ d: depth }, "", hash ? "#" + hash : location.pathname + location.search);
  }
  function goBack() {
    if (depth > 0) { history.back(); return; }
    if (routeOpen) { const o = A[routeOpen.s][0]; replaceHash(o); render(o, true); return; }
    replaceHash("");
    render("", true);
  }
  window.addEventListener("popstate", (e) => {
    depth = (e.state && e.state.d) || 0;
    render(location.hash.slice(1), true);
  });
  $("home").addEventListener("click", (e) => { e.preventDefault(); go(""); });

  function render(h, focus) {
    if (!A.length) return;
    // aircraft links need the aircraft index first
    if ((h.startsWith("aircraft/") || h.includes("/ac:")) && !AC) {
      loadAircraft().then((ac) => render(ac ? h : h.replace(/\/ac:[^/]*/, ""), focus));
      return;
    }
    if (!h) { showIntro(focus); return; }

    if (h.startsWith("route/")) {
      const [, a, b] = h.split("/");
      const s = byCode.get((a || "").toUpperCase()), d = byCode.get((b || "").toUpperCase());
      if (s === undefined || d === undefined) { showIntro(focus); return; }
      const drawnHere = view && ((view.mode === "airport" && view.i === s) || (view.mode === "network" && routeLines.has(KEY(s, d))));
      if (!drawnHere) selectAirport(s, null, null, false, false);
      openRoute(s, d, focus);
      return;
    }

    closeRoute(false);
    if (h.startsWith("airline/")) {
      const i = findAirline(h.slice(8));
      if (i === undefined) { showIntro(focus); return; }
      if (view && view.mode === "network" && view.kind === "airline" && view.id === i) { showSection("network", focus); refocusRow(); return; }
      selectAirline(i, focus);
      return;
    }
    if (h.startsWith("aircraft/")) {
      const f = findFamily(h.slice(9));
      if (f < 0) { showIntro(focus); return; }
      if (view && view.mode === "network" && view.kind === "aircraft" && view.id === f) { showSection("network", focus); refocusRow(); return; }
      selectAircraft(f, focus);
      return;
    }
    const [code, ...rest] = h.split("/");
    const i = byCode.get(code.toUpperCase());
    if (i === undefined) { showIntro(focus); return; }
    const alPart = rest.find((p) => p && !p.startsWith("ac:"));
    const acPart = rest.find((p) => p.startsWith("ac:"));
    const al = alPart ? findAirline(alPart) ?? null : null;
    const fam = acPart && AC ? findFamily(acPart.slice(3)) : null;
    const famN = fam != null && fam >= 0 ? fam : null;
    if (view && view.mode === "airport" && view.i === i && curAirline() === al && view.family === famN) {
      showSection("detail", focus); refocusRow(); return;
    }
    selectAirport(i, al, famN, true, focus);
  }

  // ---------- panel sections ----------
  function showSection(name, focus = true) {
    section = name;
    document.body.dataset.section = name;   // shows the mobile "Back to world map" button away from the start screen
    ["intro", "detail", "network", "route"].forEach((s) => { $(s).hidden = s !== name; });
    if (focus) {
      const h = $(name).querySelector("h2");
      if (h) h.focus({ preventScroll: true });
    }
  }
  let lastRowCode = null;
  function refocusRow() {
    if (!lastRowCode) return;
    const btn = $(section === "network" ? "a-list" : "list").querySelector(`[data-code="${lastRowCode}"]`);
    if (btn) { btn.focus({ preventScroll: false }); btn.scrollIntoView({ block: "nearest" }); }
  }

  function showIntro(focus) {
    closeRoute(false);
    view = null;
    routeLayer.clearLayers(); routeLines = new Map();
    dimBase(0.65);
    document.title = "Where to fly direct: every nonstop flight on a map";
    showSection("intro", focus);
    if (focus) $("q").focus();
    REDUCED ? map.setView([25, 20], 2) : map.flyTo([25, 20], 2, { duration: 0.8 });
  }

  function buildIntro() {
    const hubs = $("hubs");
    HUBS.filter((c) => byCode.has(c)).forEach((c) => {
      const a = A[byCode.get(c)];
      const b = document.createElement("button");
      b.type = "button";
      b.innerHTML = `${esc(a[2])} <small>${c}</small>`;
      b.setAttribute("aria-label", `${a[2]} (${c})`);
      b.onclick = () => go(c);
      hubs.appendChild(b);
    });
    const als = $("airline-chips");
    AIRLINE_PICKS.forEach((code) => {
      const i = findAirline(code);
      if (i === undefined) return;
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = AL[i][0].replace(/ (Airlines|Airways|Air Lines|International)$/i, "");
      b.setAttribute("aria-label", AL[i][0]);
      b.onclick = () => go("airline/" + alKey(i));
      als.appendChild(b);
    });
    loadAircraft().then((ac) => {
      if (!ac) return;
      const box = $("aircraft-chips");
      AIRCRAFT_PICKS.forEach((n) => {
        const f = ac.names.indexOf(n);
        if (f < 0) return;
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = shortName(n);
        b.setAttribute("aria-label", n);
        b.onclick = () => go("aircraft/" + famSlug(f));
        box.appendChild(b);
      });
    });
    $("random").onclick = () => {
      const big = A.map((_, i) => i).filter((i) => ROUTES[i].length >= 15);
      go(A[big[Math.floor(Math.random() * big.length)]][0]);
    };
  }

  // ---------- airport view ----------
  const curAirline = () => ($("al-filter").value === "" ? null : +$("al-filter").value);
  function airportHash() {
    const al = curAirline();
    return view.o[0] + (al != null ? "/" + alKey(al) : "") + (view.family != null && AC ? "/ac:" + famSlug(view.family) : "");
  }

  function selectAirport(i, airline = null, family = null, fly = true, focus = true) {
    const o = A[i];
    const dests = ROUTES[i].map(([d, min, ...als]) => ({ i: d, a: A[d], km: Math.round(distKm(o, A[d])), min, als }));
    view = { mode: "airport", i, o, dests, family };
    lastRowCode = null;
    document.title = `Nonstop flights from ${o[2]} (${o[0]}) · Where to fly direct`;
    $("o-code").textContent = o[0];
    $("o-title").textContent = `${o[2]} (${o[0]})`;
    $("o-sub").textContent = `${o[1]} · ${o[3]}`;

    const counts = new Map();
    dests.forEach((d) => d.als.forEach((al) => counts.set(al, (counts.get(al) || 0) + 1)));
    const sel = $("al-filter");
    sel.innerHTML = `<option value="">All airlines (${counts.size})</option>` +
      [...counts].sort((x, y) => y[1] - x[1])
        .map(([al, n]) => `<option value="${al}">${esc(AL[al][0])} · ${plural(n, "destination")}</option>`).join("");
    sel.value = airline != null && counts.has(airline) ? String(airline) : "";

    const far = dests.length ? Math.max(...dests.map((d) => d.km)) : 0;
    const slider = $("dist");
    slider.max = Math.max(500, Math.ceil(far / 250) * 250);
    slider.value = slider.max;
    $("intl").checked = false;
    $("dest-q").value = "";

    const acSel = $("ac-filter");
    acSel.innerHTML = `<option value="">Loading…</option>`;
    acSel.disabled = true;
    $("filters").open = !isMobile() || airline != null || family != null;

    showSection("detail", focus);
    renderAirport(fly);
    loadAircraft().then((ac) => {
      if (!view || view.mode !== "airport" || view.i !== i) return;
      if (!ac) { acSel.innerHTML = `<option value="">Not available</option>`; return; }
      const m = ac.byOrigin.get(i) || new Map();
      const fams = [...m].map(([f, list]) => [f, new Set(list.map((x) => x[0])).size]).sort((x, y) => y[1] - x[1]);
      acSel.innerHTML = `<option value="">All aircraft</option>` +
        fams.map(([f, n]) => `<option value="${f}">${esc(ac.names[f])} · ${plural(n, "destination")}</option>`).join("");
      acSel.disabled = !fams.length;
      if (!fams.length) acSel.innerHTML = `<option value="">No aircraft data for this airport</option>`;
      if (view.family != null && m.has(view.family)) acSel.value = String(view.family);
      else if (view.family != null) { view.family = null; renderAirport(false); }
    });
  }

  function activeFilters() {
    let n = 0;
    if (curAirline() != null) n++;
    if (view.family != null) n++;
    if (+$("dist").value < +$("dist").max) n++;
    if ($("intl").checked) n++;
    return n;
  }

  function renderAirport(fly) {
    const { o, dests, i } = view;
    const maxKm = +$("dist").value, intl = $("intl").checked;
    const alF = curAirline(), fam = view.family;
    const q = $("dest-q").value.trim().toLowerCase();
    const atMax = maxKm >= +$("dist").max;
    $("dist-out").textContent = atMax ? "no limit" : fmtDist(maxKm);
    $("dist").setAttribute("aria-valuetext", atMax ? "No limit" : fmtDist(maxKm));

    let famDest = null;
    if (fam != null && AC) {
      famDest = new Set();
      ((AC.byOrigin.get(i) || new Map()).get(fam) || []).forEach(([d, al]) => { if (alF == null || al === alF) famDest.add(d); });
    }
    const shown = dests.filter((d) =>
      d.km <= maxKm && (!intl || d.a[3] !== o[3]) && (alF == null || d.als.includes(alF)) && (!famDest || famDest.has(d.i)) &&
      (!q || d.a[0].toLowerCase() === q || d.a[2].toLowerCase().includes(q) || d.a[3].toLowerCase().includes(q) || d.a[1].toLowerCase().includes(q)));
    const sort = $("sort").value;
    shown.sort(sort === "name" ? (x, y) => x.a[2].localeCompare(y.a[2])
      : sort === "far" ? (x, y) => y.km - x.km
        : sort === "airlines" ? (x, y) => y.als.length - x.als.length || x.km - y.km
          : (x, y) => x.km - y.km);

    const countries = new Set(shown.map((d) => d.a[3])).size;
    $("s-dest").textContent = shown.length.toLocaleString();
    $("s-countries").textContent = countries;
    $("s-far").textContent = shown.length ? fmtDist(Math.max(...shown.map((d) => d.km))) : "–";

    // filter status
    const nf = activeFilters();
    $("f-count").hidden = !nf;
    $("f-count").textContent = `${nf} on`;
    $("reset").hidden = !nf && !q;
    const net = $("al-network");
    if (alF != null) { net.hidden = false; net.textContent = `See all ${AL[alF][0]} routes`; }
    else if (fam != null && AC) { net.hidden = false; net.textContent = `See everywhere the ${AC.names[fam]} flies`; }
    else net.hidden = true;

    // map
    routeLayer.clearLayers(); routeLines = new Map(); hoverKey = null;
    dimBase(0.3);
    const bounds = [[o[4], o[5]]];
    shown.forEach((d) => {
      const pts = arc(o, d.a);
      const end = pts[pts.length - 1];
      const k = KEY(i, d.i);
      const line = routeLine(pts, i, d.i, 0.5);
      routeLines.set(k, line);
      L.circleMarker(end, { renderer: canvas, radius: 4, color: "#0b1015", weight: 1, fillColor: "#6fd8ff", fillOpacity: 0.95 })
        .bindTooltip(`${esc(d.a[2])} (${d.a[0]}) · ${fmtDist(d.km)}`, { direction: "top", offset: [0, -5] })
        .on("click", () => go(`route/${o[0]}/${d.a[0]}`))
        .on("mouseover", () => hover(k)).on("mouseout", () => hover(null))
        .addTo(routeLayer);
      bounds.push(end);
    });
    L.circleMarker([o[4], o[5]], { renderer: canvas, radius: 7, color: "#0b1015", weight: 2, fillColor: "#ffc164", fillOpacity: 1, interactive: false })
      .addTo(routeLayer);
    if (fly) fitTo(bounds);

    // list
    const parts = [`<b>${plural(shown.length, "destination")}</b> in ${plural(countries, "country", "countries")}`];
    if (alF != null) parts.push(`on ${esc(AL[alF][0])}`);
    if (fam != null && AC) parts.push(`on the ${esc(AC.names[fam])}`);
    $("summary").innerHTML = parts.join(" ");
    announce(`${shown.length} destinations from ${o[2]}${nf || q ? " match your filters" : ""}.`);

    const list = $("list");
    list.innerHTML = "";
    if (!shown.length) {
      list.innerHTML = dests.length
        ? `<li class="empty">No nonstop flights match. Try clearing the filters.</li>`
        : `<li class="empty">No departures are listed from this airport. Flights arrive here, but the route data doesn't include any leaving.</li>`;
      return;
    }
    const frag = document.createDocumentFragment();
    shown.forEach((d) => {
      const k = KEY(i, d.i);
      const li = document.createElement("li");
      const b = document.createElement("button");
      b.type = "button";
      b.className = "row";
      b.dataset.code = d.a[0];
      b.dataset.key = k;
      const nAl = d.als.length;
      b.innerHTML = `<span class="d" aria-hidden="true">${d.a[0]}</span>
        <span class="city"><span>${esc(d.a[2])}</span><small>${esc(d.a[3])} · ${plural(nAl, "airline")}</small></span>
        <span class="num">${fmtDist(d.km)}<small>${d.min ? fmtDur(d.min) : "~" + fmtDur(estDur(d.km))}</small></span>`;
      b.setAttribute("aria-label", `${d.a[2]}, ${d.a[3]}. ${fmtDist(d.km)}, about ${fmtDur(d.min || estDur(d.km))}. ${plural(nAl, "airline")}.`);
      b.onclick = () => { lastRowCode = d.a[0]; go(`route/${o[0]}/${d.a[0]}`); };
      b.onmouseenter = b.onfocus = () => hover(k);
      b.onmouseleave = b.onblur = () => hover(null);
      li.appendChild(b);
      frag.appendChild(li);
    });
    list.appendChild(frag);
  }

  // filter controls: re-render and keep the URL in step (without adding history entries)
  const onFilter = (fly) => () => { if (!view || view.mode !== "airport") return; renderAirport(fly); replaceHash(airportHash()); };
  $("dist").addEventListener("input", onFilter(false));
  $("intl").addEventListener("change", onFilter(false));
  $("al-filter").addEventListener("change", onFilter(true));
  $("ac-filter").addEventListener("change", () => {
    const v = $("ac-filter").value;
    view.family = v === "" ? null : +v;
    onFilter(true)();
  });
  $("sort").addEventListener("change", onFilter(false));
  $("dest-q").addEventListener("input", onFilter(false));
  $("reset").addEventListener("click", () => {
    $("al-filter").value = ""; $("ac-filter").value = ""; view.family = null;
    $("dist").value = $("dist").max; $("intl").checked = false; $("dest-q").value = "";
    onFilter(true)();
    $("dest-q").focus();
  });
  $("al-network").addEventListener("click", () => {
    const al = curAirline();
    if (al != null) go("airline/" + alKey(al));
    else if (view.family != null && AC) go("aircraft/" + famSlug(view.family));
  });

  // ---------- network view: an airline's or an aircraft's routes ----------
  function selectAirline(al, focus = true) {
    const a = AL[al];
    showNetwork({
      kind: "airline", id: al, badge: a[1] || "✈", badgeClass: "al", title: a[0],
      sub: a[2] ? `Airline · ${a[2]}` : "Airline",
      pairs: alPairs[al], focusAl: al,
      openHash: (i) => `${A[i][0]}/${alKey(al)}`,
      tip: `Choose an airport to see where ${a[0]} flies nonstop from there.`,
    }, focus);
  }
  function selectAircraft(f, focus = true) {
    showNetwork({
      kind: "aircraft", id: f, badge: shortName(AC.names[f]), badgeClass: "ac", title: AC.names[f],
      sub: `Aircraft · routes it flew in the last ${(META.observedDays || []).length || 7} days`,
      pairs: AC.pairs[f].map(([s, d]) => [s, d]), focusAl: null,
      openHash: (i) => `${A[i][0]}/ac:${famSlug(f)}`,
      tip: `Choose an airport to see where you can fly from there on the ${AC.names[f]}.`,
    }, focus);
  }

  function showNetwork(cfg, focus) {
    const directed = new Map();
    cfg.pairs.forEach(([s, d]) => directed.set(KEY(s, d), [s, d]));
    const lines = new Map();
    directed.forEach(([s, d]) => { const k = s < d ? KEY(s, d) : KEY(d, s); if (!lines.has(k)) lines.set(k, [s, d]); });
    const perAirport = new Map();
    directed.forEach(([s]) => perAirport.set(s, (perAirport.get(s) || 0) + 1));
    const served = new Set();
    directed.forEach(([s, d]) => { served.add(s); served.add(d); });
    const airports = [...perAirport].sort((x, y) => y[1] - x[1]);
    view = { mode: "network", ...cfg };
    lastRowCode = null;
    document.title = `${cfg.title} route map · Where to fly direct`;

    const badge = $("a-code");
    badge.textContent = cfg.badge;
    badge.className = "code " + cfg.badgeClass;
    $("a-title").textContent = cfg.title;
    $("a-sub").textContent = cfg.sub;
    $("a-routes").textContent = lines.size.toLocaleString();
    $("a-airports").textContent = served.size.toLocaleString();
    $("a-countries").textContent = new Set([...served].map((i) => A[i][3])).size;
    $("a-tip").textContent = cfg.tip;
    showSection("network", focus);
    announce(`${cfg.title}: ${lines.size} routes between ${served.size} airports.`);

    routeLayer.clearLayers(); routeLines = new Map(); hoverKey = null;
    dimBase(0.2);
    const hub = airports.length ? A[airports[0][0]] : null;
    const shift = (lon) => { if (!hub) return lon; while (lon - hub[5] > 180) lon -= 360; while (lon - hub[5] < -180) lon += 360; return lon; };
    lines.forEach(([s, d]) => {
      const line = routeLine(arc(A[s], A[d], shift(A[s][5])), s, d, 0.35);
      routeLines.set(KEY(s, d), line);
      routeLines.set(KEY(d, s), line);
    });
    const pts = [];
    const maxN = airports.length ? airports[0][1] : 1;
    airports.slice().reverse().forEach(([i, n]) => { // biggest last = on top
      const ap = A[i];
      const ll = [ap[4], shift(ap[5])];
      pts.push(ll);
      L.circleMarker(ll, {
        renderer: canvas, radius: 3 + 6 * Math.sqrt(n / maxN), color: "#0b1015", weight: 1,
        fillColor: n === maxN ? "#ffc164" : "#6fd8ff", fillOpacity: 0.95,
      }).bindTooltip(`${esc(ap[2])} (${ap[0]}) · ${plural(n, "route")}`, { direction: "top", offset: [0, -5] })
        .on("click", () => go(cfg.openHash(i)))
        .addTo(routeLayer);
    });
    fitTo(pts);

    const list = $("a-list");
    list.innerHTML = "";
    const frag = document.createDocumentFragment();
    airports.forEach(([i, n]) => {
      const li = document.createElement("li");
      const b = document.createElement("button");
      b.type = "button";
      b.className = "row";
      b.dataset.code = A[i][0];
      b.innerHTML = `<span class="d" aria-hidden="true">${A[i][0]}</span>
        <span class="city"><span>${esc(A[i][2])}</span><small>${esc(A[i][3])}</small></span>
        <span class="num">${n}<small>${n === 1 ? "route" : "routes"}</small></span>`;
      b.setAttribute("aria-label", `${A[i][2]} (${A[i][0]}), ${A[i][3]}: ${plural(n, "route")}`);
      b.onclick = () => { lastRowCode = A[i][0]; go(cfg.openHash(i)); };
      li.appendChild(b);
      frag.appendChild(li);
    });
    list.appendChild(frag);
  }

  // ---------- shared drawing ----------
  function routeLine(pts, s, d, opacity) {
    const line = L.polyline(pts, { renderer: canvas, ...LINE, opacity })
      .bindTooltip(`${esc(A[s][2])} → ${esc(A[d][2])}`, { sticky: true, direction: "top" })
      .on("click", () => go(`route/${A[s][0]}/${A[d][0]}`))
      .addTo(routeLayer);
    line.options.baseOpacity = opacity;
    line.bringToBack(); // airport dots stay on top and clickable
    return line;
  }
  function styleLine(k, on) {
    const l = routeLines.get(k);
    if (!l) return;
    if (on) { l.setStyle(LINE_HI); l.bringToFront(); }
    else { l.setStyle({ ...LINE, opacity: l.options.baseOpacity }); l.bringToBack(); }
  }
  function hover(k) {
    if (hoverKey != null && hoverKey !== selectedKey) styleLine(hoverKey, false);
    document.querySelectorAll(".row.hl").forEach((r) => r.classList.remove("hl"));
    hoverKey = k;
    if (k != null) {
      styleLine(k, true);
      const r = document.querySelector(`.row[data-key="${k}"]`);
      if (r) r.classList.add("hl");
    }
  }

  // ---------- route details (in the panel, readable by everyone) ----------
  function loadTypes() {
    if (!TYPES) TYPES = fetch(`data/types.json?v=${VER}`).then((r) => r.json());
    return TYPES;
  }
  function loadDetail(code) {
    if (!detailCache.has(code)) {
      detailCache.set(code, Promise.all([fetch(`data/detail/${code}.json?v=${VER}`).then((r) => r.json()), loadTypes()])
        .then(([det, types]) => ({ det, types }))
        .catch(() => { detailCache.delete(code); return null; }));
    }
    return detailCache.get(code);
  }

  function openRoute(s, d, focus) {
    const prev = routeOpen ? routeOpen.prev : (section === "route" ? "detail" : section);
    if (routeOpen) unhighlightRoute();
    routeOpen = { s, d, prev: prev === "intro" ? "detail" : prev };
    selectedKey = KEY(s, d);
    styleLine(selectedKey, true);
    const o = A[s], t = A[d];
    const pts = arc(o, t);
    if (!routeLines.has(selectedKey)) L.polyline(pts, { renderer: canvas, ...LINE_HI, interactive: false }).addTo(focusLayer);
    L.circleMarker(pts[0], { renderer: canvas, radius: 7, color: "#0b1015", weight: 2, fillColor: "#ffc164", fillOpacity: 1, interactive: false }).addTo(focusLayer);
    L.circleMarker(pts[pts.length - 1], { renderer: canvas, radius: 7, color: "#0b1015", weight: 2, fillColor: "#6fd8ff", fillOpacity: 1, interactive: false }).addTo(focusLayer);
    fitTo([pts[0], pts[pts.length - 1], pts[Math.floor(pts.length / 2)]], 7);
    document.title = `${o[2]} to ${t[2]} nonstop · Where to fly direct`;
    fillRoute();
    showSection("route", focus);
    if (isMobile() && focus) setView("list");
  }

  function fillRoute() {
    const { s, d } = routeOpen;
    const o = A[s], t = A[d];
    const info = pairMap.get(KEY(s, d)) || { min: 0, als: [] };
    const km = Math.round(distKm(o, t));
    const back = pairMap.has(KEY(d, s));
    const days = (META.observedDays || []).length;
    // Outbound links go through /go/… on this site, which forwards to Google Flights.
    // Each visit there is counted as a page view, so analytics shows clicks per route (works on the free plan).
    const goPrices = `/go/prices/${o[0]}-${t[0]}`;
    const goSchedule = (a) => `/go/schedule/${o[0]}-${t[0]}/${encodeURIComponent(a[1] || "XX")}?al=${encodeURIComponent(a[0])}`;
    const focusAl = view && view.mode === "network" && view.kind === "airline" ? view.id : (view && view.mode === "airport" ? curAirline() : null);
    const fromAirport = view && view.mode === "airport" && view.i === s;
    $("r-back").textContent = fromAirport ? `← All flights from ${o[2]}` : view && view.mode === "network" ? `← Back to ${view.title}` : "← Back";

    $("r-body").innerHTML = `
      <div class="r-head">
        <span class="codes" aria-hidden="true">${o[0]} → ${t[0]}</span>
        <h2 id="r-title" tabindex="-1">${esc(o[2])} to ${esc(t[2])}</h2>
        <p class="o-sub">${esc(o[1])} → ${esc(t[1])}, ${esc(t[3])}</p>
      </div>
      <dl class="facts">
        <div><dt>Distance</dt><dd>${fmtDist(km)}</dd></div>
        <div><dt>Flight time</dt><dd>${info.min ? fmtDur(info.min) : "about " + fmtDur(estDur(km))}</dd></div>
        <div><dt>Flights back</dt><dd>${back ? "Yes, nonstop" : "Not nonstop"}</dd></div>
      </dl>
      <div class="r-actions">
        <a class="btn primary" href="${goPrices}" target="_blank" rel="noopener nofollow">Check prices &amp; times<span class="sr"> on Google Flights (opens in a new tab)</span> ↗</a>
        <button type="button" class="btn secondary" id="explore">Flights from ${esc(t[2])} →</button>
      </div>
      <h3>Airlines on this route (${info.als.length})</h3>
      <p class="r-note">Times are when the plane actually took off (local time), from planes tracked in the last ${days || 7} days. The timetable departure is usually 20–40 minutes earlier, or more if the flight often runs late.</p>
      <div id="r-airlines"><p class="r-note" role="status">Loading flights…</p></div>`;
    $("explore").onclick = () => go(t[0]);

    loadDetail(o[0]).then((res) => {
      if (!routeOpen || routeOpen.s !== s || routeOpen.d !== d) return;
      const box = $("r-airlines");
      const rows = (res && res.det[t[0]] ? res.det[t[0]] : info.als.map((al) => [al, 0, []])).slice();
      const types = res ? res.types : [];
      rows.sort((x, y) => (y[0] === focusAl) - (x[0] === focusAl) || (x[1] === 1 ? 0 : 1) - (y[1] === 1 ? 0 : 1) || AL[x[0]][0].localeCompare(AL[y[0]][0]));
      const often = (n) => (n >= days && days >= 7 ? "Daily" : `${n} of ${days} days`);
      box.innerHTML = rows.map(([al, src, data]) => {
        const a = AL[al];
        let body;
        if (src === 1) {
          body = `<table class="fl">
            <caption class="sr">${esc(a[0])} flights from ${esc(o[2])} to ${esc(t[2])} seen in the last ${days} days</caption>
            <thead><tr><th scope="col">Flight</th><th scope="col">Takes off</th><th scope="col">Aircraft</th><th scope="col">How often</th></tr></thead>
            <tbody>${data.map(([label, min, n, tys]) => `<tr>
              <th scope="row" class="fn">${label.endsWith("*") ? `${esc(label.slice(0, -1))}<small>call sign</small>` : esc(label)}</th>
              <td class="tm">${min >= 0 ? fmtTime(min) : "–"}</td>
              <td>${tys.map((x) => esc(types[x])).join(", ") || "–"}</td>
              <td class="often">${often(n)}</td></tr>`).join("")}</tbody></table>
            ${data.some(([label]) => label.endsWith("*")) ? `<p class="fl-note">A call sign is the name pilots use on the radio; the flight number on your ticket is different.</p>` : ""}`;
        } else if (src === 2) {
          body = `<p><span class="tag">2014 records</span> Not tracked this week. Aircraft used to be: ${data.map((x) => esc(types[x])).join(", ")}.</p>`;
        } else {
          body = `<p>No flights tracked this week. It may be seasonal, or flown where there are few receivers.</p>`;
        }
        return `<section class="al-card${al === focusAl ? " focus" : ""}" aria-label="${esc(a[0])}">
          <h4>${a[1] ? `<span class="al-code" aria-hidden="true">${esc(a[1])}</span>` : ""}${esc(a[0])}</h4>
          ${body}
          <a class="sched" href="${goSchedule(a)}" target="_blank" rel="noopener nofollow">${esc(a[0])} schedule<span class="sr"> on Google Flights (opens in a new tab)</span> ↗</a>
        </section>`;
      }).join("") || `<p class="r-note">No airline information for this route.</p>`;
    });
  }

  function unhighlightRoute() {
    focusLayer.clearLayers();
    if (selectedKey != null) { const k = selectedKey; selectedKey = null; styleLine(k, false); }
  }
  function closeRoute(focus) {
    if (!routeOpen) return;
    const { prev, d } = routeOpen;
    unhighlightRoute();
    routeOpen = null;
    if (view && view.mode === "airport") lastRowCode = A[d][0];
    showSection(prev, false);
    if (focus !== false) refocusRow();
  }

  document.querySelectorAll(".back").forEach((b) => b.addEventListener("click", goBack));
  document.querySelectorAll(".exit").forEach((b) => b.addEventListener("click", () => {
    go("");
    if (isMobile()) setView("map");
  }));
  // phones: the same "go to the world map" button, floating on the map itself
  $("map-home").addEventListener("click", () => { go(""); setView("map"); });

  // Report an issue: open a GitHub issue pre-filled with what the person was looking at
  function reportUrl() {
    const days = META.observedDays || [];
    const body = [
      "**What looks wrong?**", "", "(Describe the problem here: a missing route, a wrong time or aircraft, something that doesn't work…)", "",
      "---", `**Page:** ${location.href}`, `**Showing:** ${document.title}`,
      `**Data:** routes ${META.built || "?"}, flights ${days[0] || "?"} to ${days[days.length - 1] || "?"}`,
      `**Browser:** ${navigator.userAgent}`,
    ].join("\n");
    const title = `Issue: ${document.title.replace(/ · Where to fly direct$/, "")}`;
    return `https://github.com/Noobie502/nonstop/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
  }
  const report = $("report");
  ["pointerdown", "focus", "click"].forEach((ev) => report.addEventListener(ev, () => { report.href = reportUrl(); }));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && section !== "intro" && !e.target.closest("#suggest, #q, .settings, select")) goBack();
  });

  // ---------- mobile list/map switch ----------
  function setView(v) {
    document.body.dataset.view = v;
    $("show-list").setAttribute("aria-pressed", String(v === "list"));
    $("show-map").setAttribute("aria-pressed", String(v === "map"));
    if (v === "map") setTimeout(() => map.invalidateSize(), 0);
  }
  $("show-list").addEventListener("click", () => setView("list"));
  $("show-map").addEventListener("click", () => setView("map"));
  window.matchMedia("(max-width: 760px)").addEventListener("change", (e) => { if (!e.matches) setView("list"); map.invalidateSize(); });

  // ---------- settings ----------
  document.querySelectorAll('input[name="units"]').forEach((r) => {
    r.checked = r.value === UNITS;
    r.addEventListener("change", () => { UNITS = r.value; store.set("units", UNITS); rerender(); });
  });
  document.querySelectorAll('input[name="clock"]').forEach((r) => {
    r.checked = r.value === CLOCK;
    r.addEventListener("change", () => { CLOCK = r.value; store.set("clock", CLOCK); rerender(); });
  });
  function rerender() {
    if (view && view.mode === "airport") renderAirport(false);
    if (routeOpen) fillRoute();
  }
  document.addEventListener("click", (e) => { const s = $("settings"); if (s.open && !s.contains(e.target)) s.open = false; });
  $("settings").addEventListener("keydown", (e) => { if (e.key === "Escape") { $("settings").open = false; $("settings").querySelector("summary").focus(); } });

  // ---------- search: airports, airlines and aircraft (ARIA combobox) ----------
  const q = $("q"), sug = $("suggest");
  let results = [], active = -1;
  function closeSuggest() { sug.hidden = true; q.setAttribute("aria-expanded", "false"); q.removeAttribute("aria-activedescendant"); }
  q.addEventListener("focus", loadAircraft);
  q.addEventListener("input", () => {
    const s = q.value.trim().toLowerCase();
    if (s.length < 2) { closeSuggest(); return; }
    const scored = [];
    A.forEach((a, i) => {
      const code = a[0].toLowerCase(), name = a[1].toLowerCase(), city = a[2].toLowerCase(), ctry = a[3].toLowerCase();
      let sc = 0;
      if (code === s) sc = 100;
      else if (city.startsWith(s)) sc = 60;
      else if (code.startsWith(s)) sc = 50;
      else if (name.includes(s) || city.includes(s)) sc = 30;
      else if (ctry.startsWith(s)) sc = 10;
      if (sc) scored.push([sc + Math.min(ROUTES[i].length, 300) / 30, "ap", i]);
    });
    AL.forEach((a, i) => {
      const name = a[0].toLowerCase(), code = (a[1] || "").toLowerCase();
      let sc = 0;
      if (code && code === s) sc = 95;
      else if (name.startsWith(s)) sc = 70;
      else if (name.split(/\s+/).some((w) => w.startsWith(s))) sc = 45;
      else if (name.includes(s)) sc = 25;
      if (sc && alPairs[i].length) scored.push([sc + Math.min(alPairs[i].length, 600) / 60, "al", i]);
    });
    if (AC) {
      const sq = s.replace(/[^a-z0-9]/g, "");
      AC.names.forEach((n, f) => {
        const nn = n.toLowerCase(), compact = nn.replace(/[^a-z0-9]/g, "");
        let sc = 0;
        if (compact.includes(sq) && sq.length >= 3) sc = /\d/.test(sq) ? 90 : 40;
        else if (nn.split(/[\s/]+/).some((w) => w.startsWith(s))) sc = 35;
        if (sc) scored.push([sc + Math.min(AC.routes[f], 3000) / 300, "ac", f]);
      });
    }
    results = scored.sort((x, y) => y[0] - x[0]).slice(0, 10);
    active = -1;
    drawSuggest();
    announce(results.length ? `${results.length} results. Use the arrow keys to choose.` : "No results.");
  });
  function drawSuggest() {
    sug.innerHTML = results.map(([, kind, i], k) => {
      let label, sub, meta;
      if (kind === "ap") { const a = A[i]; label = `${esc(a[2])} (${a[0]})`; sub = `${esc(a[1])}, ${esc(a[3])}`; meta = plural(ROUTES[i].length, "route"); }
      else if (kind === "al") { const a = AL[i]; label = esc(a[0]); sub = a[2] ? esc(a[2]) : ""; meta = plural(alPairs[i].length, "route"); }
      else { label = esc(AC.names[i]); sub = "Flown in the last week"; meta = plural(AC.routes[i], "route"); }
      const kindName = { ap: "Airport", al: "Airline", ac: "Aircraft" }[kind];
      return `<li role="option" id="opt-${k}" data-k="${k}" aria-selected="${k === active}">
        <span class="kind ${kind}">${kindName}</span><span class="n">${label}${sub ? `<small>${sub}</small>` : ""}</span><span class="m">${meta}</span></li>`;
    }).join("") || `<li class="none" role="option" aria-disabled="true">Nothing found. Try a city, airport code or airline.</li>`;
    sug.hidden = false;
    q.setAttribute("aria-expanded", "true");
    if (active >= 0) {
      q.setAttribute("aria-activedescendant", "opt-" + active);
      const el = $("opt-" + active);
      if (el) el.scrollIntoView({ block: "nearest" });
    } else q.removeAttribute("aria-activedescendant");
  }
  function pick(k) {
    const [, kind, i] = results[k];
    closeSuggest();
    q.value = "";
    if (kind === "ap") go(A[i][0]);
    else if (kind === "al") go("airline/" + alKey(i));
    else go("aircraft/" + famSlug(i));
  }
  sug.addEventListener("mousedown", (e) => {
    const li = e.target.closest("li[data-k]");
    if (li) { e.preventDefault(); pick(+li.dataset.k); }
  });
  q.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { if (!sug.hidden) { closeSuggest(); e.stopPropagation(); } else q.value = ""; return; }
    if (sug.hidden || !results.length) return;
    if (e.key === "ArrowDown") { active = (active + 1) % results.length; drawSuggest(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { active = active <= 0 ? results.length - 1 : active - 1; drawSuggest(); e.preventDefault(); }
    else if (e.key === "Enter") { e.preventDefault(); pick(active >= 0 ? active : 0); }
  });
  q.addEventListener("blur", () => setTimeout(closeSuggest, 150));
})();

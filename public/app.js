(() => {
  "use strict";
  const HUBS = ["FRA", "ATL", "DXB", "SIN", "BKK", "LHR", "IST", "LAX", "SYD", "GRU"];
  const AIRLINE_PICKS = ["Emirates", "Ryanair", "Singapore Airlines", "Southwest Airlines", "Qantas", "AirAsia"];
  const R = 6371;
  const COPIES = [-360, 0, 360];
  const rad = (d) => (d * Math.PI) / 180;
  const deg = (r) => (r * 180) / Math.PI;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  // network data
  let A = [], AL = [], PL = [], ROUTES = [];
  const byCode = new Map();     // IATA -> airport index
  const pairMap = new Map();    // s*10000+d -> [[airline, codeshare, ...planes], ...]
  let alPairs = [];             // airline -> [[s, d], ...] (directed)
  let alAirportCount = [];      // airline -> number of airports served
  let view = null;              // { mode: "airport"|"airline", ... }
  let highlighted = null;

  // ---------- map ----------
  const map = L.map("map", {
    worldCopyJump: false, minZoom: 2, maxZoom: 9, zoomSnap: 0.5,
    maxBounds: [[-85, -540], [85, 540]], maxBoundsViscosity: 0.8,
  }).setView([25, 20], 2);
  map.attributionControl.setPrefix('<a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>');
  map.createPane("land").style.zIndex = 200;
  const landRenderer = L.canvas({ pane: "land", padding: 0.5 });
  const dotRenderer = L.canvas({ padding: 0.5, tolerance: 3 });
  const routeRenderer = L.canvas({ padding: 0.5, tolerance: 6 });
  const baseLayer = L.layerGroup().addTo(map);
  const routeLayer = L.layerGroup().addTo(map);

  // ---------- geo ----------
  function distKm(a, b) {
    const [la1, lo1, la2, lo2] = [rad(a[4]), rad(a[5]), rad(b[4]), rad(b[5])];
    const h = Math.sin((la2 - la1) / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin((lo2 - lo1) / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  // Great-circle points from a to b; longitudes unwrapped from startLon so lines never jump across the map.
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
  const blockTime = (km) => {
    const hrs = km / 820 + 0.5; // ~820 km/h cruise + taxi/climb/descent
    let h = Math.floor(hrs), m = Math.round(((hrs - h) * 60) / 5) * 5;
    if (m === 60) { h++; m = 0; }
    return `${h}h ${String(m).padStart(2, "0")}m`;
  };

  // ---------- load ----------
  fetch("data/world.json").then((r) => r.json()).then((world) => {
    COPIES.forEach((off) => L.geoJSON(world, {
      renderer: landRenderer, interactive: false, pane: "land",
      coordsToLatLng: (c) => L.latLng(c[1], c[0] + off),
      style: { fillColor: "#18222c", fillOpacity: 1, stroke: false },
    }).addTo(map));
  }).catch(() => {});

  fetch("data/network.json").then((r) => r.json()).then((data) => {
    A = data.airports; AL = data.airlines; PL = data.planes; ROUTES = data.routes;
    A.forEach((a, i) => byCode.set(a[0], i));
    alPairs = AL.map(() => []);
    const served = AL.map(() => new Set());
    ROUTES.forEach((list, s) => list.forEach(([d, ...als]) => {
      pairMap.set(s * 10000 + d, als);
      als.forEach(([al]) => { alPairs[al].push([s, d]); served[al].add(s); served[al].add(d); });
    }));
    alAirportCount = served.map((s) => s.size);
    drawBase();
    buildIntro();
    $("loading").remove();
    if (!fromHash()) map.setView([25, 20], 2);
  }).catch(() => { $("loading").textContent = "Couldn't load route data. Try refreshing."; });

  function drawBase() {
    A.forEach((a, i) => {
      const n = ROUTES[i].length;
      COPIES.forEach((off) => {
        const m = L.circleMarker([a[4], a[5] + off], {
          renderer: dotRenderer, radius: n > 100 ? 2.6 : n > 20 ? 1.8 : 1.3,
          stroke: false, fillColor: "#6b7c8e", fillOpacity: 0.6,
        });
        m.bindTooltip(`${a[0]} · ${esc(a[2])}`, { direction: "top", offset: [0, -4] });
        m.on("click", () => selectAirport(i));
        m.addTo(baseLayer);
      });
    });
  }
  const dimBase = (o) => baseLayer.eachLayer((m) => m.setStyle({ fillOpacity: o }));

  function buildIntro() {
    const hubs = $("hubs");
    HUBS.filter((c) => byCode.has(c)).forEach((c) => {
      const b = document.createElement("button");
      b.textContent = c;
      b.title = A[byCode.get(c)][2];
      b.onclick = () => selectAirport(byCode.get(c));
      hubs.appendChild(b);
    });
    const als = $("airline-chips");
    AIRLINE_PICKS.forEach((name) => {
      const i = AL.findIndex((a) => a[0] === name);
      if (i < 0) return;
      const b = document.createElement("button");
      b.textContent = AL[i][1] || name;
      b.title = name;
      b.onclick = () => selectAirline(i);
      als.appendChild(b);
    });
    $("random").onclick = () => {
      const big = A.map((_, i) => i).filter((i) => ROUTES[i].length >= 15);
      selectAirport(big[Math.floor(Math.random() * big.length)]);
    };
  }

  // ---------- URL ----------
  function setHash(h) { history.replaceState(null, "", "#" + h); }
  function findAirline(code) {
    const c = decodeURIComponent(code).toLowerCase();
    const hits = AL.map((a, i) => i).filter((i) => AL[i][1].toLowerCase() === c || AL[i][0].toLowerCase() === c);
    return hits.sort((x, y) => alPairs[y].length - alPairs[x].length)[0];
  }
  const alKey = (i) => encodeURIComponent(AL[i][1] || AL[i][0]);
  function fromHash() {
    const h = location.hash.slice(1);
    if (!h) return false;
    if (h.startsWith("airline/")) {
      const i = findAirline(h.slice(8));
      if (i !== undefined) { selectAirline(i); return true; }
      return false;
    }
    const [code, al] = h.split("/");
    const i = byCode.get(code.toUpperCase());
    if (i === undefined) return false;
    selectAirport(i, al ? findAirline(al) : null);
    return true;
  }
  window.addEventListener("hashchange", fromHash);

  // ---------- airport view ----------
  function selectAirport(i, airline = null) {
    const o = A[i];
    const dests = ROUTES[i].map(([d, ...als]) => ({ i: d, a: A[d], km: Math.round(distKm(o, A[d])), als }))
      .sort((x, y) => x.km - y.km);
    view = { mode: "airport", i, o, dests };
    document.title = `${o[0]} nonstop — where can I fly direct?`;
    showSection("detail");
    $("o-code").textContent = o[0];
    $("o-name").textContent = o[1];
    $("o-place").textContent = `${o[2]}, ${o[3]}`;

    // airline filter options, busiest first
    const counts = new Map();
    dests.forEach((d) => d.als.forEach(([al]) => counts.set(al, (counts.get(al) || 0) + 1)));
    const sel = $("al-filter");
    sel.innerHTML = `<option value="">All airlines (${counts.size})</option>` +
      [...counts].sort((x, y) => y[1] - x[1])
        .map(([al, n]) => `<option value="${al}">${esc(AL[al][0])}${AL[al][1] ? " (" + esc(AL[al][1]) + ")" : ""} · ${n}</option>`).join("");
    sel.value = airline != null && counts.has(airline) ? String(airline) : "";

    const far = dests.length ? Math.max(...dests.map((d) => d.km)) : 0;
    const slider = $("dist");
    slider.max = Math.max(500, Math.ceil(far / 250) * 250);
    slider.value = slider.max;
    $("intl").checked = false;
    renderAirport(true);
  }

  function renderAirport(fly) {
    const { o, dests, i } = view;
    const maxKm = +$("dist").value, intl = $("intl").checked;
    const alF = $("al-filter").value === "" ? null : +$("al-filter").value;
    $("dist-out").textContent = `${maxKm.toLocaleString()} km`;
    setHash(o[0] + (alF != null ? "/" + alKey(alF) : ""));
    const shown = dests.filter((d) => d.km <= maxKm && (!intl || d.a[3] !== o[3]) && (alF == null || d.als.some(([al]) => al === alF)));

    $("s-dest").textContent = shown.length;
    $("s-countries").textContent = new Set(shown.map((d) => d.a[3])).size;
    $("s-far").textContent = shown.length ? Math.max(...shown.map((d) => d.km)).toLocaleString() : 0;

    routeLayer.clearLayers();
    highlighted = null;
    dimBase(0.3);
    const bounds = [[o[4], o[5]]];
    shown.forEach((d) => {
      const pts = arc(o, d.a);
      const end = pts[pts.length - 1];
      d.line = routeLine(pts, i, d.i, alF).on("mouseover", () => highlight(d)).on("mouseout", () => highlight(null));
      d.dot = L.circleMarker(end, { renderer: routeRenderer, radius: 3.5, color: "#0b0f14", weight: 1, fillColor: "#5fd3ff", fillOpacity: 0.95 })
        .bindPopup(() => routePopup(i, d.i, alF), { maxWidth: 340, autoPanPadding: [20, 20] })
        .bindTooltip(`${d.a[0]} · ${esc(d.a[2])}`, { direction: "top", offset: [0, -5] })
        .on("mouseover", () => highlight(d)).on("mouseout", () => highlight(null))
        .addTo(routeLayer);
      bounds.push(end);
    });
    originDot(o);
    if (fly) flyTo(bounds, o);

    const list = $("list");
    list.innerHTML = "";
    const frag = document.createDocumentFragment();
    shown.forEach((d) => {
      const li = document.createElement("li");
      li.innerHTML = `<span class="d">${d.a[0]}</span><span class="city"><div>${esc(d.a[2])}</div><small>${esc(d.a[3])} · ${d.als.length} airline${d.als.length > 1 ? "s" : ""}</small></span><span class="km">${d.km.toLocaleString()}</span>`;
      li.onmouseenter = () => highlight(d);
      li.onmouseleave = () => highlight(null);
      li.onclick = () => { map.panTo(d.dot.getLatLng()); d.dot.openPopup(); };
      d.li = li;
      frag.appendChild(li);
    });
    list.appendChild(frag);
    if (!shown.length) list.innerHTML = `<li class="empty">No nonstop routes match these filters.</li>`;
  }

  // ---------- airline view ----------
  function selectAirline(al) {
    const a = AL[al];
    const pairs = alPairs[al];
    // collapse directions into one line per airport pair
    const seen = new Map();
    pairs.forEach(([s, d]) => {
      const k = s < d ? s * 10000 + d : d * 10000 + s;
      if (!seen.has(k)) seen.set(k, [s, d]);
    });
    const perAirport = new Map();
    pairs.forEach(([s]) => perAirport.set(s, (perAirport.get(s) || 0) + 1));
    const airports = [...perAirport].sort((x, y) => y[1] - x[1]);
    view = { mode: "airline", al };
    setHash("airline/" + alKey(al));
    document.title = `${a[0]} route map — Nonstop`;
    showSection("airline");

    $("a-code").textContent = a[1] || "—";
    $("a-name").textContent = a[0];
    $("a-place").textContent = a[2] || "";
    $("a-routes").textContent = seen.size.toLocaleString();
    $("a-airports").textContent = alAirportCount[al];
    $("a-countries").textContent = new Set(airports.map(([i]) => A[i][3])).size;

    routeLayer.clearLayers();
    highlighted = null;
    dimBase(0.2);
    // center the drawing on the airline's busiest airport so lines unwrap around it
    const hub = airports.length ? A[airports[0][0]] : null;
    const pts = [];
    const shift = (lon) => { if (!hub) return lon; while (lon - hub[5] > 180) lon -= 360; while (lon - hub[5] < -180) lon += 360; return lon; };
    seen.forEach(([s, d]) => {
      const line = arc(A[s], A[d], shift(A[s][5]));
      routeLine(line, s, d, al, 0.35);
    });
    const maxN = airports.length ? airports[0][1] : 1;
    airports.forEach(([i, n]) => {
      const ap = A[i];
      const ll = [ap[4], shift(ap[5])];
      pts.push(ll);
      L.circleMarker(ll, {
        renderer: routeRenderer, radius: 2.5 + 6 * Math.sqrt(n / maxN), color: "#0b0f14", weight: 1,
        fillColor: n === maxN ? "#ffb84d" : "#5fd3ff", fillOpacity: 0.95,
      }).bindTooltip(`${ap[0]} · ${esc(ap[2])} · ${n} route${n > 1 ? "s" : ""}`, { direction: "top", offset: [0, -5] })
        .on("click", () => selectAirport(i, al))
        .addTo(routeLayer);
    });
    if (pts.length) map.flyToBounds(pts, { padding: [40, 40], maxZoom: 6, duration: 0.8 });

    const list = $("a-list");
    list.innerHTML = "";
    const frag = document.createDocumentFragment();
    airports.forEach(([i, n]) => {
      const li = document.createElement("li");
      li.innerHTML = `<span class="d">${A[i][0]}</span><span class="city"><div>${esc(A[i][2])}</div><small>${esc(A[i][3])}</small></span><span class="km">${n}</span>`;
      li.title = `See ${a[0]}'s routes from ${A[i][0]}`;
      li.onclick = () => selectAirport(i, al);
      frag.appendChild(li);
    });
    list.appendChild(frag);
  }

  // ---------- shared drawing ----------
  function routeLine(pts, s, d, focusAl, opacity = 0.45) {
    return L.polyline(pts, { renderer: routeRenderer, color: "#ffb84d", weight: 1.2, opacity })
      .bindPopup(() => routePopup(s, d, focusAl), { maxWidth: 340, autoPanPadding: [20, 20] })
      .bindTooltip(`${A[s][0]} → ${A[d][0]}`, { sticky: true, direction: "top" })
      .addTo(routeLayer);
  }
  function originDot(o) {
    L.circleMarker([o[4], o[5]], { renderer: routeRenderer, radius: 7, color: "#0b0f14", weight: 2, fillColor: "#ffb84d", fillOpacity: 1 })
      .bindTooltip(`${o[0]} · ${esc(o[2])}`, { direction: "top", offset: [0, -7] }).addTo(routeLayer);
  }
  function flyTo(bounds, o) {
    if (bounds.length > 1) map.flyToBounds(bounds, { padding: [40, 40], maxZoom: 6, duration: 0.8 });
    else map.flyTo([o[4], o[5]], 5, { duration: 0.8 });
  }
  function highlight(d) {
    if (highlighted) {
      highlighted.line.setStyle({ color: "#ffb84d", weight: 1.2, opacity: 0.45 });
      highlighted.li && highlighted.li.classList.remove("hl");
    }
    highlighted = d;
    if (d) {
      d.line.setStyle({ color: "#5fd3ff", weight: 2.6, opacity: 1 }).bringToFront();
      d.li && d.li.classList.add("hl");
    }
  }

  // ---------- route popup: airlines, aircraft, schedules ----------
  function routePopup(s, d, focusAl) {
    const o = A[s], t = A[d];
    const als = (pairMap.get(s * 10000 + d) || []).slice()
      .sort((x, y) => (y[0] === focusAl) - (x[0] === focusAl) || x[1] - y[1] || AL[x[0]][0].localeCompare(AL[y[0]][0]));
    const km = Math.round(distKm(o, t));
    const back = pairMap.has(d * 10000 + s);
    const gf = (extra = "") => `https://www.google.com/travel/flights?q=${encodeURIComponent(`Flights from ${o[0]} to ${t[0]}${extra}`)}`;

    const rows = als.map(([al, cs, ...planes]) => {
      const a = AL[al];
      const types = planes.map((p) => PL[p][1] || PL[p][0]);
      return `<div class="al-row${al === focusAl ? " focus" : ""}">
        <div class="al-top">
          <span class="al-code">${esc(a[1] || "··")}</span>
          <span class="al-name">${esc(a[0])}</span>
          ${cs ? '<span class="tag" title="Sold under this airline\'s code, flown by a partner">codeshare</span>' : ""}
          <a class="al-sched" href="${gf(" on " + a[0])}" target="_blank" rel="noopener" title="Live schedules on Google Flights">times ↗</a>
        </div>
        <div class="al-planes">${types.length ? types.map(esc).join(" · ") : "Aircraft not listed"}</div>
      </div>`;
    }).join("");

    const div = document.createElement("div");
    div.className = "route-pop";
    div.innerHTML = `
      <div class="rp-head"><b>${o[0]}</b><span class="rp-arrow">✈</span><b>${t[0]}</b></div>
      <div class="rp-sub">${esc(o[2])} → ${esc(t[2])}, ${esc(t[3])}</div>
      <div class="rp-meta">${km.toLocaleString()} km · ~${blockTime(km)} · ${back ? "return route ✓" : "one-way in data"}</div>
      <div class="rp-label">Who flies it · on what</div>
      <div class="rp-list">${rows || '<div class="al-planes">No airline data</div>'}</div>
      <div class="rp-foot">
        <a href="${gf()}" target="_blank" rel="noopener">Departure times on Google Flights ↗</a>
        <span>Timetables aren't in the open data, so times come from Google Flights.</span>
      </div>`;
    const btn = document.createElement("button");
    btn.className = "pop-btn";
    btn.textContent = `Fly from ${t[0]} →`;
    btn.onclick = () => { map.closePopup(); selectAirport(d); };
    div.querySelector(".rp-head").appendChild(btn);
    return div;
  }

  // ---------- panel sections ----------
  function showSection(name) {
    $("intro").hidden = name !== "intro";
    $("detail").hidden = name !== "detail";
    $("airline").hidden = name !== "airline";
    $("q").value = "";
  }
  document.querySelectorAll(".back").forEach((b) => b.addEventListener("click", () => {
    if (view && view.mode === "airport" && $("al-filter").value !== "") selectAirline(+$("al-filter").value);
    else { view = null; routeLayer.clearLayers(); dimBase(0.6); showSection("intro"); setHash(""); map.flyTo([25, 20], 2, { duration: 0.8 }); }
  }));
  $("dist").addEventListener("input", () => renderAirport(false));
  $("intl").addEventListener("change", () => renderAirport(false));
  $("al-filter").addEventListener("change", () => renderAirport(true));
  $("al-network").addEventListener("click", () => { const v = $("al-filter").value; if (v !== "") selectAirline(+v); });

  // ---------- search: airports + airlines ----------
  const q = $("q"), sug = $("suggest");
  let results = [], active = 0;
  q.addEventListener("input", () => {
    const s = q.value.trim().toLowerCase();
    if (s.length < 2) { sug.hidden = true; return; }
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
      if (sc) scored.push([sc + Math.min(alPairs[i].length, 600) / 60, "al", i]);
    });
    results = scored.sort((x, y) => y[0] - x[0]).slice(0, 12);
    active = 0;
    drawSuggest();
  });
  function drawSuggest() {
    sug.innerHTML = results.map(([, kind, i], k) => {
      if (kind === "ap") {
        const a = A[i];
        return `<li role="option" data-k="${k}" aria-selected="${k === active}"><span class="c">${a[0]}</span><span class="n">${esc(a[2])} <span class="dim">· ${esc(a[1])}</span></span><span class="m">${ROUTES[i].length} routes</span></li>`;
      }
      const a = AL[i];
      return `<li role="option" data-k="${k}" aria-selected="${k === active}"><span class="c al">${esc(a[1] || "✈")}</span><span class="n">${esc(a[0])} <span class="dim">· airline</span></span><span class="m">${alPairs[i].length} routes</span></li>`;
    }).join("") || `<li class="dim">Nothing found</li>`;
    sug.hidden = false;
  }
  function pick(k) {
    const [, kind, i] = results[k];
    sug.hidden = true;
    q.blur();
    kind === "ap" ? selectAirport(i) : selectAirline(i);
  }
  sug.addEventListener("mousedown", (e) => {
    const li = e.target.closest("li[data-k]");
    if (li) { e.preventDefault(); pick(+li.dataset.k); }
  });
  q.addEventListener("keydown", (e) => {
    if (sug.hidden || !results.length) return;
    if (e.key === "ArrowDown") { active = (active + 1) % results.length; drawSuggest(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { active = (active - 1 + results.length) % results.length; drawSuggest(); e.preventDefault(); }
    else if (e.key === "Enter") pick(active);
    else if (e.key === "Escape") sug.hidden = true;
  });
  q.addEventListener("blur", () => setTimeout(() => (sug.hidden = true), 150));
})();

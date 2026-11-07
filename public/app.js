(() => {
  "use strict";
  const HUBS = ["FRA", "ATL", "DXB", "SIN", "BKK", "LHR", "IST", "LAX", "SYD", "GRU"];
  const R = 6371;
  const rad = (d) => (d * Math.PI) / 180;
  const deg = (r) => (r * 180) / Math.PI;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  let A = [], AL = [], ROUTES = [], byCode = new Map();
  let current = null, highlighted = null;

  // ---------- map ----------
  const map = L.map("map", { worldCopyJump: true, zoomControl: true, minZoom: 2, preferCanvas: true }).setView([25, 20], 2);
  L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png", {
    subdomains: "abcd", maxZoom: 10,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
  }).addTo(map);
  const canvas = L.canvas({ padding: 0.5 });
  const baseLayer = L.layerGroup().addTo(map);
  const routeLayer = L.layerGroup().addTo(map);

  // ---------- geo ----------
  function distKm(a, b) {
    const [la1, lo1, la2, lo2] = [rad(a[4]), rad(a[5]), rad(b[4]), rad(b[5])];
    const h = Math.sin((la2 - la1) / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin((lo2 - lo1) / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  // Great-circle points from a to b, longitudes unwrapped so the line never jumps across the map.
  function arc(a, b, baseLon) {
    const la1 = rad(a[4]), lo1 = rad(a[5]), la2 = rad(b[4]), lo2 = rad(b[5]);
    const d = 2 * Math.asin(Math.sqrt(Math.sin((la2 - la1) / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin((lo2 - lo1) / 2) ** 2));
    const n = Math.max(2, Math.ceil(deg(d) / 2));
    const pts = [];
    let prev = baseLon;
    for (let i = 0; i <= n; i++) {
      const f = i / n;
      let lat, lon;
      if (d < 1e-9) { lat = a[4]; lon = a[5]; }
      else {
        const A1 = Math.sin((1 - f) * d) / Math.sin(d), B1 = Math.sin(f * d) / Math.sin(d);
        const x = A1 * Math.cos(la1) * Math.cos(lo1) + B1 * Math.cos(la2) * Math.cos(lo2);
        const y = A1 * Math.cos(la1) * Math.sin(lo1) + B1 * Math.cos(la2) * Math.sin(lo2);
        const z = A1 * Math.sin(la1) + B1 * Math.sin(la2);
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

  // ---------- data ----------
  fetch("data/network.json")
    .then((r) => r.json())
    .then((data) => {
      A = data.airports; AL = data.airlines; ROUTES = data.routes;
      A.forEach((a, i) => byCode.set(a[0], i));
      drawBase();
      buildHubs();
      $("loading").remove();
      const start = location.hash.slice(1).toUpperCase();
      if (byCode.has(start)) select(byCode.get(start), false);
    })
    .catch(() => { $("loading").textContent = "Couldn't load route data. Try refreshing."; });

  function drawBase() {
    A.forEach((a, i) => {
      const n = ROUTES[i].length;
      const m = L.circleMarker([a[4], a[5]], {
        renderer: canvas, radius: n > 100 ? 2.6 : n > 20 ? 1.8 : 1.2,
        stroke: false, fillColor: "#5b6b7c", fillOpacity: 0.55,
      });
      m.bindTooltip(`${a[0]} · ${esc(a[2])}`, { direction: "top", offset: [0, -4] });
      m.on("click", () => select(i));
      m.addTo(baseLayer);
    });
  }

  function buildHubs() {
    const box = $("hubs");
    HUBS.filter((c) => byCode.has(c)).forEach((c) => {
      const b = document.createElement("button");
      b.textContent = c;
      b.title = A[byCode.get(c)][2];
      b.onclick = () => select(byCode.get(c));
      box.appendChild(b);
    });
    $("random").onclick = () => {
      const big = A.map((_, i) => i).filter((i) => ROUTES[i].length >= 15);
      select(big[Math.floor(Math.random() * big.length)]);
    };
  }

  // ---------- selection ----------
  function select(i, fly = true) {
    current = i;
    const o = A[i];
    history.replaceState(null, "", "#" + o[0]);
    document.title = `${o[0]} nonstop — where can I fly direct?`;
    $("intro").hidden = true;
    $("detail").hidden = false;
    $("q").value = "";
    $("o-code").textContent = o[0];
    $("o-name").textContent = o[1];
    $("o-place").textContent = `${o[2]}, ${o[3]}`;

    const dests = ROUTES[i].map(([d, ...als]) => ({ i: d, a: A[d], km: Math.round(distKm(o, A[d])), als }))
      .sort((x, y) => x.km - y.km);
    current = { i, o, dests };

    const far = dests.length ? Math.max(...dests.map((d) => d.km)) : 0;
    const slider = $("dist");
    slider.max = Math.max(500, Math.ceil(far / 250) * 250);
    slider.value = slider.max;
    $("intl").checked = false;
    render(fly);
  }

  function render(fly) {
    const { o, dests } = current;
    const maxKm = +$("dist").value, intl = $("intl").checked;
    $("dist-out").textContent = `${(+maxKm).toLocaleString()} km`;
    const shown = dests.filter((d) => d.km <= maxKm && (!intl || d.a[3] !== o[3]));

    $("s-dest").textContent = shown.length;
    $("s-countries").textContent = new Set(shown.map((d) => d.a[3])).size;
    $("s-far").textContent = shown.length ? Math.max(...shown.map((d) => d.km)).toLocaleString() : 0;

    routeLayer.clearLayers();
    baseLayer.eachLayer((m) => m.setStyle({ fillOpacity: 0.25 }));
    const bounds = [[o[4], o[5]]];

    shown.forEach((d) => {
      const pts = arc(o, d.a, o[5]);
      const end = pts[pts.length - 1];
      d.line = L.polyline(pts, { color: "#ffb84d", weight: 1.1, opacity: 0.45, interactive: false }).addTo(routeLayer);
      d.dot = L.circleMarker(end, { radius: 3.5, color: "#0b0f14", weight: 1, fillColor: "#5fd3ff", fillOpacity: 0.95 })
        .bindPopup(() => popupHtml(d))
        .bindTooltip(`${d.a[0]} · ${esc(d.a[2])}`, { direction: "top", offset: [0, -5] })
        .on("mouseover", () => highlight(d)).on("mouseout", () => highlight(null))
        .addTo(routeLayer);
      bounds.push(end);
    });

    L.circleMarker([o[4], o[5]], { radius: 7, color: "#0b0f14", weight: 2, fillColor: "#ffb84d", fillOpacity: 1 })
      .bindTooltip(`${o[0]} · ${esc(o[2])}`, { direction: "top", offset: [0, -7] }).addTo(routeLayer);

    if (fly !== false) {
      if (bounds.length > 1) map.flyToBounds(bounds, { padding: [40, 40], maxZoom: 6, duration: 0.8 });
      else map.flyTo([o[4], o[5]], 5, { duration: 0.8 });
    }

    const list = $("list");
    list.innerHTML = "";
    const frag = document.createDocumentFragment();
    shown.forEach((d) => {
      const li = document.createElement("li");
      li.innerHTML = `<span class="d">${d.a[0]}</span><span class="city"><div>${esc(d.a[2])}</div><small>${esc(d.a[3])}</small></span><span class="km">${d.km.toLocaleString()}</span>`;
      li.onmouseenter = () => highlight(d);
      li.onmouseleave = () => highlight(null);
      li.onclick = () => { map.panTo(d.dot.getLatLng()); d.dot.openPopup(); };
      d.li = li;
      frag.appendChild(li);
    });
    list.appendChild(frag);
    if (!shown.length) list.innerHTML = `<li style="display:block;color:var(--muted)">No nonstop routes match these filters.</li>`;
  }

  function highlight(d) {
    if (highlighted) {
      highlighted.line.setStyle({ color: "#ffb84d", weight: 1.1, opacity: 0.45 });
      highlighted.li && highlighted.li.classList.remove("hl");
    }
    highlighted = d;
    if (d) {
      d.line.setStyle({ color: "#5fd3ff", weight: 2.5, opacity: 1 }).bringToFront();
      d.li && d.li.classList.add("hl");
    }
  }

  function popupHtml(d) {
    const hrs = d.km / 820 + 0.5; // rough block time: cruise ~820 km/h + taxi/climb
    const h = Math.floor(hrs), m = Math.round((hrs - h) * 60 / 5) * 5;
    const names = d.als.map((x) => AL[x]);
    const al = names.length > 6 ? names.slice(0, 6).join(", ") + ` +${names.length - 6} more` : names.join(", ");
    const div = document.createElement("div");
    div.innerHTML = `<b>${current.o[0]} → ${d.a[0]}</b><br>${esc(d.a[1])}<br>${esc(d.a[2])}, ${esc(d.a[3])}<br>
      ${d.km.toLocaleString()} km · ~${h}h ${String(m).padStart(2, "0")}m
      <div class="al">${esc(al)}</div>`;
    const btn = document.createElement("button");
    btn.className = "pop-btn";
    btn.textContent = `Fly from ${d.a[0]} →`;
    btn.onclick = () => { map.closePopup(); select(d.i); };
    div.appendChild(btn);
    return div;
  }

  $("dist").addEventListener("input", () => render(false));
  $("intl").addEventListener("change", () => render(false));

  // ---------- search ----------
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
      if (sc) scored.push([sc + Math.min(ROUTES[i].length, 300) / 30, i]);
    });
    results = scored.sort((x, y) => y[0] - x[0]).slice(0, 10).map((x) => x[1]);
    active = 0;
    drawSuggest();
  });
  function drawSuggest() {
    sug.innerHTML = results.map((i, k) => {
      const a = A[i];
      return `<li role="option" data-i="${i}" aria-selected="${k === active}"><span class="c">${a[0]}</span><span class="n">${esc(a[2])} <span style="color:var(--muted)">· ${esc(a[1])}</span></span><span class="m">${ROUTES[i].length} routes</span></li>`;
    }).join("") || `<li style="color:var(--muted)">No airports found</li>`;
    sug.hidden = false;
  }
  sug.addEventListener("mousedown", (e) => {
    const li = e.target.closest("li[data-i]");
    if (li) { e.preventDefault(); sug.hidden = true; select(+li.dataset.i); q.blur(); }
  });
  q.addEventListener("keydown", (e) => {
    if (sug.hidden || !results.length) return;
    if (e.key === "ArrowDown") { active = (active + 1) % results.length; drawSuggest(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { active = (active - 1 + results.length) % results.length; drawSuggest(); e.preventDefault(); }
    else if (e.key === "Enter") { sug.hidden = true; select(results[active]); q.blur(); }
    else if (e.key === "Escape") { sug.hidden = true; }
  });
  q.addEventListener("blur", () => setTimeout(() => (sug.hidden = true), 150));

  window.addEventListener("hashchange", () => {
    const c = location.hash.slice(1).toUpperCase();
    if (byCode.has(c) && (!current || A[current.i][0] !== c)) select(byCode.get(c));
  });
})();

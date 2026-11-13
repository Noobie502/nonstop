// Forwards /go/prices/BKK-CNX and /go/schedule/BKK-CNX/TG?al=Thai%20Airways to Google Flights.
// Only builds Google Flights URLs from validated airport/airline codes, so it can't be used to redirect elsewhere.
(function () {
  "use strict";
  var m = location.pathname.match(/^\/go\/(prices|schedule)\/([A-Z]{3})-([A-Z]{3})(?:\/([A-Z0-9]{2}))?\/?$/);
  var target = "https://www.google.com/travel/flights";
  if (m) {
    var q = "Flights from " + m[2] + " to " + m[3];
    var al = new URLSearchParams(location.search).get("al") || "";
    if (m[1] === "schedule" && /^[\p{L}\p{N} .&'()-]{2,60}$/u.test(al)) q += " on " + al;
    target += "?q=" + encodeURIComponent(q);
  }
  document.getElementById("manual").href = target;
  var gone = false;
  function go() { if (!gone) { gone = true; location.replace(target); } }
  // give the analytics script a moment to record the visit, but never hold the visitor up for long
  window.addEventListener("load", function () { setTimeout(go, 350); });
  setTimeout(go, 1500);
})();

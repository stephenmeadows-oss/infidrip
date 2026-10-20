/* Infidrip background: falling "drips of intelligence". Vanilla JS, one fixed canvas behind the page. */
(function () {
  "use strict";
  var canvas = document.createElement("canvas");
  canvas.id = "drip-bg";
  canvas.setAttribute("aria-hidden", "true");
  document.body.insertBefore(canvas, document.body.firstChild);
  var ctx = canvas.getContext("2d");
  var GLYPHS = "0123456789abcdef123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz01◎∞●•·".split("").concat(["si", "si", "◎", "∞", "01"]);
  var CYAN = "143,234,252", GOLD = "239,186,125";
  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  var w, h, dpr, size, cols, drips, splashes, running = false, last = 0;
  function pick() { return GLYPHS[(Math.random() * GLYPHS.length) | 0]; }
  function newDrip(i, scatter) {
    var len = 6 + ((Math.random() * 14) | 0);
    return {
      x: (i + 0.5) * (w / cols),
      y: scatter ? Math.random() * h : -Math.random() * h * 0.6,
      speed: (28 + Math.random() * 46) * (size / 16),
      len: len,
      gold: Math.random() < 0.08,
      alpha: 0.2 + Math.random() * 0.12,
      trail: Array.from({ length: len }, pick),
      stop: Math.random() < 0.35 ? h * (0.35 + Math.random() * 0.6) : h + size,
      tick: 0,
    };
  }
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    w = window.innerWidth; h = window.innerHeight;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    canvas.style.width = w + "px"; canvas.style.height = h + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var mobile = w < 640;
    size = mobile ? 14 : 16;
    var spacing = mobile ? 34 : 30; // sparse: one column every ~30px, about half active
    var slots = Math.floor(w / spacing);
    cols = slots;
    drips = [];
    for (var i = 0; i < slots; i++) if (Math.random() < (mobile ? 0.4 : 0.5)) drips.push(newDrip(i, true));
    splashes = [];
  }
  function drawGlyph(g, x, y, a, color, glow) {
    ctx.fillStyle = "rgba(" + color + "," + a + ")";
    if (g === "●") { ctx.beginPath(); ctx.arc(x, y - size * 0.35, size * 0.22, 0, 6.283); ctx.fill(); return; }
    if (g === "◎") { ctx.strokeStyle = ctx.fillStyle; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(x, y - size * 0.35, size * 0.32, 0, 6.283); ctx.stroke(); ctx.beginPath(); ctx.arc(x, y - size * 0.35, size * 0.12, 0, 6.283); ctx.fill(); return; }
    ctx.shadowBlur = glow; ctx.shadowColor = "rgba(" + color + "," + Math.min(1, a * 2) + ")";
    ctx.fillText(g, x, y);
    ctx.shadowBlur = 0;
  }
  function frame(dt) {
    ctx.clearRect(0, 0, w, h);
    ctx.font = "500 " + size + "px ui-monospace, Menlo, Consolas, monospace";
    ctx.textAlign = "center";
    for (var i = 0; i < drips.length; i++) {
      var d = drips[i], color = d.gold ? GOLD : CYAN;
      d.y += d.speed * dt;
      d.tick += dt;
      if (d.tick > 0.12) { d.tick = 0; d.trail[(Math.random() * d.len) | 0] = pick(); }
      for (var k = d.len - 1; k >= 0; k--) {
        var y = d.y - k * size * 1.1;
        if (y < -size || y > d.stop) continue;
        var fade = 1 - k / d.len;
        drawGlyph(k === 0 ? d.trail[0] : d.trail[k], d.x, y, d.alpha * fade * fade * (k === 0 ? 2.2 : 1), color, k === 0 ? 10 : 2);
      }
      // the drip head: a small teardrop of light
      if (d.y < d.stop) {
        ctx.fillStyle = "rgba(" + color + "," + Math.min(0.45, d.alpha * 1.8) + ")";
        ctx.beginPath(); ctx.ellipse(d.x, d.y + size * 0.35, 1.6, 3, 0, 0, 6.283); ctx.fill();
      }
      if (d.y - d.len * size * 1.1 > d.stop) {
        if (d.stop < h && splashes.length < 24) splashes.push({ x: d.x, y: d.stop + size * 0.4, r: 1, a: d.alpha * 1.4, color: color });
        var col = Math.round(d.x / (w / cols) - 0.5);
        drips[i] = newDrip(col, false);
      } else if (d.y >= d.stop && !d.landed && d.stop < h) {
        d.landed = true;
        splashes.push({ x: d.x, y: d.stop + size * 0.4, r: 1, a: d.alpha * 1.6, color: color });
      }
    }
    for (var s = splashes.length - 1; s >= 0; s--) {
      var p = splashes[s];
      p.r += 22 * dt; p.a -= 0.35 * dt;
      if (p.a <= 0) { splashes.splice(s, 1); continue; }
      ctx.strokeStyle = "rgba(" + p.color + "," + p.a + ")"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.ellipse(p.x, p.y, p.r, p.r * 0.32, 0, 0, 6.283); ctx.stroke();
    }
  }
  function loop(t) {
    if (!running) return;
    var dt = last ? Math.min(0.05, (t - last) / 1000) : 0.016;
    last = t;
    frame(dt);
    requestAnimationFrame(loop);
  }
  function start() {
    if (running || reduced.matches || document.hidden) return;
    running = true; last = 0; requestAnimationFrame(loop);
  }
  function stop() { running = false; }
  function staticFrame() { stop(); for (var i = 0; i < 8; i++) frame(0.4); splashes = []; frame(0); }
  resize();
  if (reduced.matches) staticFrame(); else start();
  window.addEventListener("resize", function () { resize(); if (reduced.matches) staticFrame(); });
  document.addEventListener("visibilitychange", function () { if (document.hidden) stop(); else start(); });
  (reduced.addEventListener ? reduced.addEventListener.bind(reduced, "change") : reduced.addListener.bind(reduced))(function () { if (reduced.matches) staticFrame(); else start(); });
  window.__drip = { isRunning: function () { return running; } };
})();

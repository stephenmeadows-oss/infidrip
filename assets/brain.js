/* Infidrip coin brain: training form, test chat, and saving to the brain service. */
(function () {
  "use strict";
  var DRAFT_KEY = "infidrip.brainDraft";
  function $(id) { return document.getElementById(id); }
  function apiBase() {
    var q = new URLSearchParams(location.search).get("brainApi");
    if (q && /^(localhost|127\.0\.0\.1)$/.test(location.hostname)) return q.replace(/\/$/, "");
    var m = document.querySelector('meta[name="infidrip-brain-api"]');
    return m && m.content ? m.content.replace(/\/$/, "") : "";
  }
  function phantom() {
    var p = window.phantom && window.phantom.solana;
    if (p && p.isPhantom) return p;
    if (window.solana && window.solana.isPhantom) return window.solana;
    return null;
  }
  function message(action, mint, cluster, ts) {
    return "Infidrip coin brain\nAction: " + action + "\nCoin: " + mint + "\nNetwork: " + cluster + "\nTime: " + ts;
  }
  function toB64(bytes) { var s = ""; for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return btoa(s); }
  async function sign(action, mint, cluster) {
    var p = phantom();
    if (!p) throw new Error("Open this page in a browser with Phantom to sign.");
    if (!p.publicKey) await p.connect();
    var ts = Date.now();
    var out = await p.signMessage(new TextEncoder().encode(message(action, mint, cluster, ts)), "utf8");
    return { wallet: p.publicKey.toBase58(), ts: ts, signature: toB64(out.signature || out) };
  }
  async function post(path, body) {
    var base = apiBase();
    if (!base) throw new Error("The brain service is not switched on yet. Your training is saved on this device.");
    var r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    var j = {};
    try { j = await r.json(); } catch (e) {}
    if (!r.ok) throw new Error(j.error || "The brain service did not answer.");
    return j;
  }
  function readConfig(root) {
    var f = function (n) { var el = root.querySelector('[name="brain-' + n + '"]'); return el ? el.value : ""; };
    return {
      name: f("name"), persona: f("persona"), voice: f("voice"), knowledge: f("knowledge"),
      links: f("links").split(/\s+/).filter(Boolean), rules: f("rules"),
    };
  }
  function writeConfig(root, c) {
    if (!c) return;
    ["name", "persona", "voice", "knowledge", "rules"].forEach(function (n) {
      var el = root.querySelector('[name="brain-' + n + '"]'); if (el && c[n] != null) el.value = c[n];
    });
    var l = root.querySelector('[name="brain-links"]'); if (l && c.links) l.value = c.links.join("\n");
  }
  function chatUI(root, send) {
    var log = root.querySelector(".brain-log"), input = root.querySelector(".brain-input"), btn = root.querySelector(".brain-send");
    var history = [];
    function add(role, text) {
      var p = document.createElement("p"); p.className = "bubble " + role; p.textContent = text; log.appendChild(p); log.scrollTop = log.scrollHeight;
    }
    async function go() {
      var text = input.value.trim(); if (!text) return;
      input.value = ""; add("user", text); btn.disabled = true;
      try { var reply = await send(history, text); add("assistant", reply); history.push({ role: "user", content: text }, { role: "assistant", content: reply }); }
      catch (e) { add("note", e.message); }
      btn.disabled = false;
    }
    btn.addEventListener("click", go);
    input.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); go(); } });
  }
  function coinFromPage() {
    return { name: ($("name") && $("name").value) || "", ticker: ($("ticker") && $("ticker").value) || "" };
  }
  function cluster() { var c = document.querySelector("#networks .chip.on"); return c ? c.getAttribute("data-net") : "mainnet-beta"; }

  /* Launch page */
  function bindLaunch() {
    var root = $("brain"); if (!root) return;
    var toggle = $("brain-on"), body = $("brain-body"), status = $("brain-status");
    var draft = null; try { draft = JSON.parse(localStorage.getItem(DRAFT_KEY) || "null"); } catch (e) {}
    if (draft) { writeConfig(root, draft.config); toggle.checked = !!draft.on; }
    function sync() { body.hidden = !toggle.checked; var row = $("card-brain"); if (row) row.hidden = !toggle.checked; var nm = $("card-brain-name"); if (nm) nm.textContent = readConfig(root).name || "On"; }
    function save() { localStorage.setItem(DRAFT_KEY, JSON.stringify({ on: toggle.checked, config: readConfig(root) })); sync(); }
    toggle.addEventListener("change", save);
    root.addEventListener("input", save);
    sync();
    var proof = null;
    chatUI(root, async function (history, text) {
      if (!proof || Date.now() - proof.ts > 50 * 60 * 1000) proof = await sign("test", "draft", cluster());
      var j = await post("/preview", Object.assign({ cluster: cluster(), config: readConfig(root), coin: coinFromPage(), history: history, message: text }, proof));
      return j.reply;
    });
    // After a launch succeeds, attach the brain to the new coin.
    var mintEl = $("result-mint");
    if (mintEl) new MutationObserver(function () {
      var mint = mintEl.textContent.trim();
      if (!toggle.checked || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) return;
      var box = $("brain-after"); box.hidden = false;
      $("brain-manage-link").href = "manage.html?mint=" + mint + "&net=" + cluster();
      $("brain-attach").onclick = async function () {
        status.textContent = "Sign once to give " + (coinFromPage().name || "your coin") + " its brain.";
        try {
          var s = await sign("save", mint, cluster());
          await post("/brain/save", Object.assign({ mint: mint, cluster: cluster(), coin: coinFromPage(), config: readConfig(root), enabled: true }, s));
          status.textContent = "Your coin has its brain. You can keep training it any time.";
          localStorage.removeItem(DRAFT_KEY);
        } catch (e) { status.textContent = e.message; }
      };
    }).observe(mintEl, { childList: true, characterData: true, subtree: true });
  }

  /* Manage page */
  function bindManage() {
    var root = $("manage"); if (!root) return;
    var q = new URLSearchParams(location.search);
    var mintIn = $("m-mint"), netIn = $("m-net"), status = $("m-status"), body = $("m-body");
    if (q.get("mint")) mintIn.value = q.get("mint");
    if (q.get("net")) netIn.value = q.get("net");
    var coin = { name: "", ticker: "" };
    $("m-open").addEventListener("click", async function () {
      status.textContent = "Sign with the wallet that launched this coin.";
      try {
        var s = await sign("load", mintIn.value.trim(), netIn.value);
        var j = await post("/brain/load", Object.assign({ mint: mintIn.value.trim(), cluster: netIn.value }, s));
        if (j.brain) { writeConfig(root, j.brain.config); coin = j.brain.coin; $("m-enabled").checked = j.brain.enabled; }
        body.hidden = false;
        status.textContent = j.brain ? "Loaded. Change anything and save." : "No brain yet. Train it below and save.";
      } catch (e) { status.textContent = e.message; }
    });
    $("m-save").addEventListener("click", async function () {
      status.textContent = "Sign to save.";
      try {
        var s = await sign("save", mintIn.value.trim(), netIn.value);
        await post("/brain/save", Object.assign({ mint: mintIn.value.trim(), cluster: netIn.value, coin: coin, config: readConfig(root), enabled: $("m-enabled").checked }, s));
        status.textContent = "Saved. Your coin's brain is up to date.";
      } catch (e) { status.textContent = e.message; }
    });
    chatUI(root, async function (history, text) {
      var j = await post("/chat", { mint: mintIn.value.trim(), cluster: netIn.value, wallet: "11111111111111111111111111111111", history: history, message: text });
      return j.reply;
    });
  }
  document.addEventListener("DOMContentLoaded", function () { bindLaunch(); bindManage(); });
})();

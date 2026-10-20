// Infidrip coin brain API. Cloudflare Worker.
// Secrets and bindings (never in the browser):
//   LLM_API_KEY   secret, xAI API key (or any OpenAI-compatible key)
//   LLM_BASE_URL  optional, default https://api.x.ai/v1
//   LLM_MODEL     optional, default grok-3-mini
//   BRAINS        KV namespace, brain configs keyed by "brain:<cluster>:<mint>"
//   ALLOWED_ORIGIN optional, default https://infidrip.si
//   RPC_MAINNET / RPC_DEVNET optional Solana RPC URLs

const MAX = { name: 40, persona: 600, voice: 300, knowledge: 6000, links: 10, rules: 1500, message: 800, history: 12 };
const SIG_WINDOW_MS = 10 * 60 * 1000;

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function b58decode(str) {
  const bytes = [0];
  for (const ch of str) {
    const v = B58.indexOf(ch);
    if (v < 0) throw new Error("bad base58");
    let carry = v;
    for (let i = 0; i < bytes.length; i++) { carry += bytes[i] * 58; bytes[i] = carry & 0xff; carry >>= 8; }
    while (carry) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  for (const ch of str) { if (ch === "1") bytes.push(0); else break; }
  return new Uint8Array(bytes.reverse());
}
function b64decode(s) { return Uint8Array.from(atob(s), c => c.charCodeAt(0)); }

export function brainMessage(action, mint, cluster, ts) {
  return "Infidrip coin brain\nAction: " + action + "\nCoin: " + mint + "\nNetwork: " + cluster + "\nTime: " + ts;
}

async function verifySig(wallet, message, sigB64) {
  const key = await crypto.subtle.importKey("raw", b58decode(wallet), { name: "Ed25519" }, false, ["verify"]);
  return crypto.subtle.verify({ name: "Ed25519" }, key, b64decode(sigB64), new TextEncoder().encode(message));
}

async function rpc(env, cluster, method, params) {
  const url = cluster === "devnet" ? (env.RPC_DEVNET || "https://api.devnet.solana.com") : (env.RPC_MAINNET || "https://api.mainnet-beta.solana.com");
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

// The creator is the fee payer of the coin's first transaction (the launch).
export async function mintCreator(env, cluster, mint) {
  if (env.CREATOR_LOOKUP) return env.CREATOR_LOOKUP(cluster, mint);
  let before; let oldest = null;
  for (let i = 0; i < 20; i++) {
    const page = await rpc(env, cluster, "getSignaturesForAddress", [mint, { limit: 1000, before }]);
    if (!page.length) break;
    oldest = page[page.length - 1].signature;
    if (page.length < 1000) break;
    before = oldest;
  }
  if (!oldest) return null;
  const tx = await rpc(env, cluster, "getTransaction", [oldest, { encoding: "json", maxSupportedTransactionVersion: 0 }]);
  return tx && tx.transaction.message.accountKeys[0];
}

function clean(s, n) { return String(s || "").replace(/[\u0000-\u0008\u000b-\u001f]/g, "").slice(0, n).trim(); }
export function sanitizeConfig(c) {
  c = c || {};
  return {
    name: clean(c.name, MAX.name),
    persona: clean(c.persona, MAX.persona),
    voice: clean(c.voice, MAX.voice),
    knowledge: clean(c.knowledge, MAX.knowledge),
    links: (Array.isArray(c.links) ? c.links : []).map(l => clean(l, 300)).filter(l => /^https?:\/\//.test(l)).slice(0, MAX.links),
    rules: clean(c.rules, MAX.rules),
  };
}

export function systemPrompt(cfg, coin) {
  return [
    "You are " + (cfg.name || "the brain") + ", the voice of the coin " + (coin.name || "") + (coin.ticker ? " ($" + coin.ticker + ")" : "") + " launched on Infidrip.",
    cfg.persona && "Who you are: " + cfg.persona,
    cfg.voice && "How you talk: " + cfg.voice,
    cfg.knowledge && "What you know:\n" + cfg.knowledge,
    cfg.links.length && "Useful links:\n" + cfg.links.join("\n"),
    cfg.rules && "Your creator's rules:\n" + cfg.rules,
    "Always: be warm and plain. Never give financial advice. Never promise or suggest profit, price moves, returns or earnings for holders. If asked, say you are an AI brain trained by the coin's creator. Keep replies short.",
  ].filter(Boolean).join("\n\n");
}

async function callLLM(env, cfg, coin, history, message) {
  if (!env.LLM_API_KEY) return { status: 503, body: { error: "The brain service is not connected to a model yet." } };
  const msgs = [{ role: "system", content: systemPrompt(cfg, coin) }];
  for (const h of (history || []).slice(-MAX.history)) {
    if (h && (h.role === "user" || h.role === "assistant")) msgs.push({ role: h.role, content: clean(h.content, MAX.message) });
  }
  msgs.push({ role: "user", content: clean(message, MAX.message) });
  const r = await fetch((env.LLM_BASE_URL || "https://api.x.ai/v1") + "/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + env.LLM_API_KEY },
    body: JSON.stringify({ model: env.LLM_MODEL || "grok-3-mini", messages: msgs, max_tokens: 300, temperature: 0.7 }),
  });
  if (!r.ok) return { status: 502, body: { error: "The model did not answer. Try again." } };
  const j = await r.json();
  return { status: 200, body: { reply: (j.choices && j.choices[0].message.content || "").trim(), usage: j.usage || null } };
}

async function rateLimit(env, key, limit) {
  const k = "rl:" + key + ":" + Math.floor(Date.now() / 3600000);
  const n = parseInt((await env.BRAINS.get(k)) || "0", 10);
  if (n >= limit) return false;
  await env.BRAINS.put(k, String(n + 1), { expirationTtl: 3700 });
  return true;
}

function json(body, status, origin) {
  return new Response(status === 204 ? null : JSON.stringify(body), { status: status || 200, headers: { "content-type": "application/json", "access-control-allow-origin": origin, "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "content-type" } });
}

async function checkSigned(env, b, action) {
  const ts = Number(b.ts);
  if (!ts || Math.abs(Date.now() - ts) > SIG_WINDOW_MS) return "This signature is too old. Sign again.";
  const msg = brainMessage(action, b.mint, b.cluster, ts);
  let ok = false;
  try { ok = await verifySig(b.wallet, msg, b.signature); } catch (e) { ok = false; }
  if (!ok) return "That signature does not match this wallet.";
  return null;
}

export default {
  async fetch(request, env) {
    const allowed = env.ALLOWED_ORIGIN || "https://infidrip.si";
    const reqOrigin = request.headers.get("origin") || "";
    const origin = allowed.split(",").includes(reqOrigin) ? reqOrigin : allowed.split(",")[0];
    if (request.method === "OPTIONS") return json({}, 204, origin);
    const url = new URL(request.url);
    const ip = request.headers.get("cf-connecting-ip") || "local";
    try {
      if (request.method === "GET" && url.pathname === "/health") return json({ ok: true, model: Boolean(env.LLM_API_KEY) }, 200, origin);
      const m = url.pathname.match(/^\/brain\/(mainnet-beta|devnet)\/([1-9A-HJ-NP-Za-km-z]{32,44})$/);
      if (request.method === "GET" && m) {
        const raw = await env.BRAINS.get("brain:" + m[1] + ":" + m[2]);
        if (!raw) return json({ brain: null }, 200, origin);
        const rec = JSON.parse(raw);
        return json({ brain: { name: rec.config.name, persona: rec.config.persona, enabled: rec.enabled, updatedAt: rec.updatedAt } }, 200, origin);
      }
      if (request.method !== "POST") return json({ error: "Not found." }, 404, origin);
      const b = await request.json();
      if (!["mainnet-beta", "devnet"].includes(b.cluster) || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(b.mint || "") || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(b.wallet || "")) {
        if (url.pathname !== "/preview") return json({ error: "Missing coin, network or wallet." }, 400, origin);
      }
      const key = "brain:" + b.cluster + ":" + b.mint;

      if (url.pathname === "/brain/save" || url.pathname === "/brain/load") {
        const action = url.pathname === "/brain/save" ? "save" : "load";
        const err = await checkSigned(env, b, action);
        if (err) return json({ error: err }, 401, origin);
        const creator = await mintCreator(env, b.cluster, b.mint);
        if (!creator) return json({ error: "That coin was not found on this network yet. Try again in a minute." }, 404, origin);
        if (creator !== b.wallet) return json({ error: "Only the wallet that launched this coin can train its brain." }, 403, origin);
        if (action === "load") {
          const raw = await env.BRAINS.get(key);
          return json({ brain: raw ? JSON.parse(raw) : null }, 200, origin);
        }
        const rec = { mint: b.mint, cluster: b.cluster, creator, coin: { name: clean(b.coin && b.coin.name, 32), ticker: clean(b.coin && b.coin.ticker, 13) }, config: sanitizeConfig(b.config), enabled: b.enabled !== false, updatedAt: new Date().toISOString(), proof: { ts: b.ts, signature: b.signature } };
        await env.BRAINS.put(key, JSON.stringify(rec));
        return json({ ok: true, brain: rec }, 200, origin);
      }

      if (url.pathname === "/chat") {
        if (!(await rateLimit(env, "chat:" + ip, 60))) return json({ error: "Lots of chatting. Take a short break and try again." }, 429, origin);
        const raw = await env.BRAINS.get(key);
        if (!raw) return json({ error: "This coin does not have a brain yet." }, 404, origin);
        const rec = JSON.parse(raw);
        if (!rec.enabled) return json({ error: "This brain is turned off." }, 403, origin);
        const out = await callLLM(env, rec.config, rec.coin, b.history, b.message);
        return json(out.body, out.status, origin);
      }

      if (url.pathname === "/preview") {
        // Test chat before launch: uses the draft config, needs a wallet signature, tighter limit.
        if (!(await rateLimit(env, "prev:" + ip, 30))) return json({ error: "Lots of testing. Take a short break and try again." }, 429, origin);
        b.mint = b.mint || "draft"; b.cluster = b.cluster || "mainnet-beta";
        const ts = Number(b.ts);
        if (!ts || Math.abs(Date.now() - ts) > 60 * 60 * 1000) return json({ error: "Sign again to test the brain." }, 401, origin);
        let ok = false;
        try { ok = await verifySig(b.wallet, brainMessage("test", "draft", b.cluster, ts), b.signature); } catch (e) {}
        if (!ok) return json({ error: "Connect and sign with Phantom to test the brain." }, 401, origin);
        if (!(await rateLimit(env, "prevw:" + b.wallet, 30))) return json({ error: "Lots of testing. Take a short break and try again." }, 429, origin);
        const out = await callLLM(env, sanitizeConfig(b.config), { name: clean(b.coin && b.coin.name, 32), ticker: clean(b.coin && b.coin.ticker, 13) }, b.history, b.message);
        return json(out.body, out.status, origin);
      }
      return json({ error: "Not found." }, 404, origin);
    } catch (e) {
      return json({ error: "Something went wrong. Try again." }, 500, origin);
    }
  },
};

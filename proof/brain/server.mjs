import http from "node:http";
import worker from "/workspace/inf-audit/brain-api/worker.js";
const kv = new Map();
const env = {
  BRAINS: { get: async k => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, v); } },
  LLM_API_KEY: process.env.STUB ? "stub" : "",
  LLM_BASE_URL: "http://127.0.0.1:8788/v1",
  ALLOWED_ORIGIN: "http://127.0.0.1:8080",
  CREATOR_LOOKUP: async () => process.env.CREATOR,
};
// stub model: shows the system prompt was built from the training
http.createServer(async (req, res) => {
  let b = ""; for await (const c of req) b += c; const j = JSON.parse(b);
  const sys = j.messages[0].content; const name = (sys.match(/You are (.*?),/) || [])[1];
  const last = j.messages.at(-1).content;
  res.end(JSON.stringify({ choices: [{ message: { content: `[stub model] Hi, I'm ${name}. You said "${last}". I know: ${(sys.match(/What you know:\n(.*)/) || [])[1] || "nothing yet"}` } }], usage: { total_tokens: 1 } }));
}).listen(8788);
http.createServer(async (req, res) => {
  let b = ""; for await (const c of req) b += c;
  const r = await worker.fetch(new Request("http://x" + req.url, { method: req.method, headers: req.headers, body: ["GET","OPTIONS"].includes(req.method) ? undefined : b }), env);
  res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(await r.text());
}).listen(8787, () => console.log("up"));

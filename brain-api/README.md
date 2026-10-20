# Infidrip coin brain API

A Cloudflare Worker. The site stays static on GitHub Pages and calls this for brain storage and chat.

- `POST /brain/save` and `POST /brain/load`: the creator signs a message with Phantom. The worker checks the signature, then checks on chain that the signer paid for the coin's first transaction (the launch). Configs live in KV under `brain:<network>:<mint>`, with the signature kept as proof.
- `POST /preview`: test chat before launch with the draft training. Needs any wallet signature and is rate limited.
- `POST /chat`: chat with a saved brain. Rate limited per IP.
- `GET /brain/<network>/<mint>`: public name and persona only.

The model key never reaches the browser.

## Deploy
1. `npm i -g wrangler && wrangler login` (Cloudflare account)
2. `wrangler kv namespace create BRAINS`, paste the id into wrangler.toml
3. `wrangler secret put LLM_API_KEY` (xAI API key; any OpenAI-compatible key works with LLM_BASE_URL and LLM_MODEL)
4. `wrangler deploy`, then put the worker URL in `<meta name="infidrip-brain-api">` in index.html and manage.html.

Until step 4, the site shows the brain form, keeps training on the device, and says the brain service is not switched on yet.

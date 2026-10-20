import json, base64
from cryptography.hazmat.primitives.serialization import load_pem_private_key
from playwright.sync_api import sync_playwright
k = json.load(open("keys.json")); priv = load_pem_private_key(k["priv"].encode(), None)
MINT = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"
fake = """
window.__sign = null;
window.phantom = { solana: { isPhantom: true, publicKey: { toBase58: () => '%s' },
  connect: async () => ({}),
  signMessage: async (bytes) => ({ signature: Uint8Array.from(atob(await window.pySign(Array.from(bytes))), c => c.charCodeAt(0)) }) } };
""" % k["pub"]
API = "?brainApi=http://127.0.0.1:8787"
with sync_playwright() as p:
    b = p.chromium.launch(executable_path="/usr/bin/google-chrome"); pg = b.new_page(viewport={"width": 1280, "height": 900})
    pg.expose_function("pySign", lambda arr: base64.b64encode(priv.sign(bytes(arr))).decode())
    pg.add_init_script(fake)
    pg.on("console", lambda m: print("console:", m.text) if m.type == "error" else None)
    pg.goto("http://127.0.0.1:8080/index.html" + API); pg.wait_for_timeout(1500)
    pg.locator("#story").screenshot(path="shots/1-story-steps.png")
    pg.locator("#taps").screenshot(path="shots/2-chain-solana-only.png")
    pg.fill("#name", "Harbor Roast"); pg.fill("#ticker", "HRST")
    pg.check("#brain-on")
    pg.fill('#brain [name="brain-name"]', "Harbor")
    pg.fill('#brain [name="brain-persona"]', "The friendly voice of Harbor Roast, a corner coffee shop in NoDa.")
    pg.fill('#brain [name="brain-voice"]', "Warm, short, a little funny.")
    pg.fill('#brain [name="brain-knowledge"]', "Open 7am to 3pm. Saturday latte art meetup.")
    pg.fill('#brain [name="brain-rules"]', "Never talk about price.")
    pg.fill("#brain .brain-input", "When are you open?"); pg.click("#brain .brain-send")
    pg.wait_for_selector("#brain .bubble.assistant", timeout=10000)
    print("preview:", pg.inner_text("#brain .bubble.assistant"))
    pg.locator("#brain").screenshot(path="shots/3-brain-training-and-test-chat.png")
    # simulate a finished launch (no real transaction in this test)
    pg.evaluate("""m => { document.getElementById('result').hidden = false; document.getElementById('result-mint').textContent = m; }""", MINT)
    pg.wait_for_selector("#brain-after:not([hidden])"); pg.click("#brain-attach")
    pg.wait_for_function("document.getElementById('brain-status').textContent.includes('has its brain')", timeout=10000)
    print("attach:", pg.inner_text("#brain-status"))
    pg.locator("#launcher").screenshot(path="shots/4-after-launch-brain-attached.png")
    pg.locator("#people").screenshot(path="shots/5-bands-solana.png")
    pg.goto("http://127.0.0.1:8080/manage.html" + "?brainApi=http://127.0.0.1:8787&mint=" + MINT + "&net=mainnet-beta")
    pg.click("#m-open"); pg.wait_for_selector("#m-body:not([hidden])", timeout=10000)
    pg.fill('#manage [name="brain-knowledge"]', "Open 7am to 4pm now. Saturday latte art meetup.")
    pg.click("#m-save"); pg.wait_for_function("document.getElementById('m-status').textContent.startsWith('Saved')", timeout=10000)
    pg.fill("#manage .brain-input", "Hours?"); pg.click("#manage .brain-send")
    pg.wait_for_selector("#manage .bubble.assistant", timeout=10000)
    print("manage chat:", pg.inner_text("#manage .bubble.assistant"))
    pg.screenshot(path="shots/6-manage-page.png", full_page=True)
    b.close()

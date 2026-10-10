import esbuild from "esbuild";

await esbuild.build({
  entryPoints: ["src/browser.cjs"],
  bundle: true,
  format: "iife",
  platform: "browser",
  outfile: "assets/launcher.js",
  legalComments: "none",
  minify: true,
  inject: ["src/shims/node-globals.cjs"],
  define: {
    "process.env.NODE_ENV": '"production"',
    global: "globalThis",
  },
  alias: {
    crypto: "crypto-browserify",
    stream: "stream-browserify",
    events: "events",
    "stream/promises": "./src/shims/stream-promises.cjs",
  },
});

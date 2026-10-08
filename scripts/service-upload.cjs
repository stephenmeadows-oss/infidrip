"use strict";

const SERVICE_METADATA_URL = "https://pump.fun/api/ipfs";

async function uploadServiceMetadata(fields, fileBytes, filename) {
  const blob = new Blob([fileBytes], { type: "image/png" });
  const form = new FormData();
  form.append("file", blob, filename || "coin.png");
  form.append("name", fields.name);
  form.append("symbol", fields.symbol);
  form.append("description", fields.description);
  form.append("twitter", fields.twitter || "");
  form.append("website", fields.website || "");
  form.append("showName", "true");
  const response = await fetch(SERVICE_METADATA_URL, {
    method: "POST",
    headers: { Origin: "https://infidrip.si" },
    body: form,
  });
  const allow = response.headers.get("access-control-allow-origin");
  if (!response.ok) {
    throw new Error("Metadata upload failed (" + response.status + ").");
  }
  const json = await response.json();
  if (!json.metadataUri || String(json.metadataUri).length > 200) {
    throw new Error("Metadata upload did not return a usable link.");
  }
  return {
    metadataUri: json.metadataUri,
    accessControlAllowOrigin: allow,
    browserCanRead: Boolean(allow),
  };
}

module.exports = { SERVICE_METADATA_URL, uploadServiceMetadata };

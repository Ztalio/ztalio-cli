// ztalio-mcp — the hosted MCP server at https://api.ztalio.com/v1/mcp (Streamable HTTP, stateless).
// Built from the CLI's mcp-core.js by mcp-lambda/deploy.sh (esbuild bundle), so the hosted
// server and `ztalio mcp` expose exactly the same tools. Auth = the caller's Ztalio API key in
// `Authorization: Bearer ztk_…` (or x-api-key); every tool call goes to the public API with that key.
//
// Transport notes: POST only (JSON-RPC request → application/json response; notification-only
// → 202). No sessions, no server-initiated streams (GET → 405). Clients that insist on SSE for
// responses still work: the spec allows a plain JSON reply to a POST.
import { client } from "../src/api.js";
import { handleMessage, SERVER_INFO } from "../src/mcp-core.js";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type,authorization,x-api-key,mcp-protocol-version,mcp-session-id,accept",
  "access-control-allow-methods": "POST,OPTIONS",
  "access-control-expose-headers": "mcp-protocol-version",
};
const json = (code, body, extra = {}) => ({ statusCode: code, headers: { "content-type": "application/json", ...CORS, ...extra }, body: JSON.stringify(body) });

export const handler = async (event) => {
  const method = event.requestContext?.http?.method || "GET";
  const h = Object.fromEntries(Object.entries(event.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
  if (method === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };
  if (method === "GET") return json(405, { error: "This MCP server is stateless: send JSON-RPC by POST. Docs: https://ztalio.com/developers#mcp" }, { allow: "POST" });
  if (method === "DELETE") return { statusCode: 204, headers: CORS, body: "" };
  if (method !== "POST") return json(405, { error: "POST only" }, { allow: "POST" });

  const m = (h.authorization || "").match(/^Bearer\s+(\S+)$/i);
  const key = (m && m[1]) || h["x-api-key"] || null;
  if (!key) {
    return json(401, { jsonrpc: "2.0", id: null, error: { code: -32001, message: "Send your Ztalio API key as `Authorization: Bearer ztk_…` (Settings → API access; Pro and Network plans)." } },
      { "www-authenticate": 'Bearer realm="ztalio", error="invalid_token", error_description="API key required"' });
  }

  let body;
  try { body = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body || "", "base64").toString("utf8") : (event.body || "")); }
  catch { return json(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); }

  let api = null;
  const getApi = async () => (api ||= await client({ key, base: process.env.ZTALIO_API_BASE }));
  const batch = Array.isArray(body) ? body : [body];
  const out = (await Promise.all(batch.map((msg) => handleMessage(msg, getApi)))).filter(Boolean);
  if (!out.length) return { statusCode: 202, headers: CORS, body: "" };
  const auth = out.find((r) => r.error && r.error.code === -32001);
  if (auth) return json(401, auth);
  return json(200, Array.isArray(body) ? out : out[0], { "mcp-protocol-version": h["mcp-protocol-version"] || "2025-06-18", "x-ztalio-mcp": SERVER_INFO.version });
};

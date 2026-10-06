// `ztalio mcp` — MCP server over stdio (newline-delimited JSON-RPC). stdout carries only
// protocol messages; anything human goes to stderr.
import { createInterface } from "node:readline";
import { client } from "./api.js";
import { handleMessage } from "./mcp-core.js";

export async function serveStdio({ key, base } = {}) {
  let api = null;
  const getApi = async () => (api ||= await client({ key, base }));
  const write = (m) => process.stdout.write(JSON.stringify(m) + "\n");
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    const s = line.trim();
    if (!s) continue;
    let msg;
    try { msg = JSON.parse(s); } catch { write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); continue; }
    const batch = Array.isArray(msg) ? msg : [msg];
    const out = (await Promise.all(batch.map((m) => handleMessage(m, getApi)))).filter(Boolean);
    if (!out.length) continue;
    write(Array.isArray(msg) ? out : out[0]);
  }
}

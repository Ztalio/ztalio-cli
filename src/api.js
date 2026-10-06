// HTTP client for https://api.ztalio.com/v1 — zero dependencies (Node 18+ fetch).
import { readFile, writeFile, mkdir, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_BASE = "https://api.ztalio.com/v1";
const CONFIG_DIR = process.env.ZTALIO_CONFIG_DIR || join(homedir(), ".config", "ztalio");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

export class ApiError extends Error {
  constructor(status, body, path) {
    super(body?.error || body?.message || `HTTP ${status}`);
    this.status = status; this.body = body || {}; this.code = body?.code; this.path = path;
  }
}

export async function readConfig() {
  try { return JSON.parse(await readFile(CONFIG_FILE, "utf8")); } catch { return {}; }
}

export async function writeConfig(cfg) {
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  await writeFile(CONFIG_FILE, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  try { await chmod(CONFIG_FILE, 0o600); } catch {}
  return CONFIG_FILE;
}

export async function resolveKey() {
  if (process.env.ZTALIO_API_KEY) return process.env.ZTALIO_API_KEY;
  return (await readConfig()).apiKey || null;
}

export function configPath() { return CONFIG_FILE; }

export async function client({ key, base } = {}) {
  const cfg = await readConfig();
  const apiKey = key || process.env.ZTALIO_API_KEY || cfg.apiKey;
  const apiBase = (base || process.env.ZTALIO_API_BASE || cfg.apiBase || DEFAULT_BASE).replace(/\/$/, "");
  if (!apiKey) {
    const e = new Error("No API key. Run `ztalio login` (create a key at ztalio.com → Settings → API access) or set ZTALIO_API_KEY.");
    e.code = "NO_KEY"; throw e;
  }
  async function call(method, path, body, { raw = false } = {}) {
    const res = await fetch(apiBase + path, {
      method,
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", "user-agent": "ztalio-cli" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
    if (!res.ok) throw new ApiError(res.status, data, path);
    return raw ? { status: res.status, data } : data;
  }
  return {
    base: apiBase,
    get: (p) => call("GET", p),
    post: (p, b) => call("POST", p, b ?? {}),
    patch: (p, b) => call("PATCH", p, b ?? {}),
    del: (p, b) => call("DELETE", p, b),
    call,
  };
}

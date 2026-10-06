// All `ztalio` subcommands. Each receives { api, args, flags, json } and prints its result.
import { createReadStream, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { createInterface } from "node:readline/promises";
import { ApiError, client, configPath, readConfig, writeConfig } from "./api.js";
import { ago, bytes, out, speedLabel, table } from "./format.js";

const TRANSITIONS = ["none", "dissolve", "slide", "flip", "zoom"];
const MIME = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", heic: "image/heic",
  mp4: "video/mp4", mov: "video/quicktime", m4v: "video/x-m4v", webm: "video/webm", mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", aac: "audio/aac" };
const PART_SIZE = 25 * 1024 * 1024;

// "8-17" · "mon-fri 8-17" · "mon,wed,fri 9-21; sat 10-14" · "off"  →  { rules: [{ startHour, endHour, daysOfWeek? }] }
// Hours are in the account's timezone (Settings), 0–24; daysOfWeek 0 = Sunday, omitted = every day.
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
function parseSchedule(text) {
  if (["off", "none", "clear"].includes(text.trim().toLowerCase())) return null;
  const rules = text.split(";").map((part) => {
    const m = part.trim().toLowerCase().match(/^(?:([a-z,\-]+)\s+)?(\d{1,2})\s*-\s*(\d{1,2})$/);
    if (!m) throw new UsageError(`Bad schedule "${part.trim()}". Examples: "8-17", "mon-fri 8-17", "mon,wed,fri 9-21; sat 10-14", off`);
    const startHour = Number(m[2]), endHour = Number(m[3]);
    if (startHour < 0 || startHour > 23 || endHour < 1 || endHour > 24 || endHour <= startHour) throw new UsageError(`Hours must be 0–24 with end after start: "${part.trim()}"`);
    const rule = { startHour, endHour };
    if (m[1]) {
      const days = new Set();
      for (const tok of m[1].split(",")) {
        const r = tok.match(/^([a-z]{3})(?:-([a-z]{3}))?$/);
        const a = r ? DAYS.indexOf(r[1]) : -1, b = r && r[2] ? DAYS.indexOf(r[2]) : a;
        if (!r || a < 0 || b < 0) throw new UsageError(`Unknown day "${tok}" (use sun … sat)`);
        for (let d = a; ; d = (d + 1) % 7) { days.add(d); if (d === b) break; }
      }
      if (days.size < 7) rule.daysOfWeek = [...days].sort((x, y) => x - y);
    }
    return rule;
  });
  return { rules };
}

class UsageError extends Error { constructor(m) { super(m); this.code = "USAGE"; } }
const need = (v, what) => { if (v === undefined || v === null || v === "") throw new UsageError(`Missing ${what}`); return v; };

// ---------- name resolution (id, or case-insensitive unique name / prefix) ----------
const norm = (v) => String(v ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
function pick(list, query, label, { id = "id", name = "name", alt = () => "", cmd = `${label}s` } = {}) {
  const q = norm(query);
  const keys = (x) => [x[id], x[name], alt(x)].map(norm);
  const exact = list.filter((x) => keys(x).includes(q));
  if (exact.length === 1) return exact[0];
  const partial = list.filter((x) => keys(x).some((k) => k && k.includes(q)));
  if (partial.length === 1) return partial[0];
  if (!exact.length && !partial.length) throw new UsageError(`No ${label} matches "${query}". Run \`ztalio ${cmd}\` to see them.`);
  const c = (exact.length ? exact : partial).slice(0, 8).map((x) => `  ${x[name]}  (${x[id]})`).join("\n");
  throw new UsageError(`"${query}" matches more than one ${label}:\n${c}\nUse the id.`);
}

async function screensOf(api) { return (await api.get("/screens")).screens; }
async function playlistsOf(api) { return await api.get("/playlists"); }
async function mediaOf(api) { return await api.get("/media"); }
// Folders live in two places: the library feed (what the TVs and the web grid read) and the
// V2 folders table (what uploads and sharing use). Show the union; the V2 id is what uploads take.
async function foldersOf(api) {
  const [feed, v2] = await Promise.all([mediaOf(api), api.get("/folders").catch(() => ({ items: [] }))]);
  const byId = new Map();
  for (const f of feed.folders || []) byId.set(f.id, { id: f.id, name: f.name, itemCount: f.itemCount ?? null, shared: false });
  for (const f of v2.items || []) byId.set(f.folderId, { id: f.folderId, name: f.name, itemCount: byId.get(f.folderId)?.itemCount ?? null, shared: !!f.isShared && !f.isOwner });
  return [...byId.values()];
}
const mediaPick = (items, q) => pick(items, q, "media item", { id: "s3Key", name: "title", alt: (i) => basename(i.s3Key || ""), cmd: "media" });

// ---------- commands ----------
export const commands = {
  async login({ args, flags, json }) {
    let key = flags.key || args[0];
    if (!key) {
      if (!process.stdin.isTTY) throw new UsageError("Pass the key: ztalio login --key ztk_…  (or set ZTALIO_API_KEY)");
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      process.stdout.write("Create a key at https://ztalio.com/settings → API access, then paste it here.\n");
      key = (await rl.question("API key: ")).trim();
      rl.close();
    }
    if (!/^ztk_[A-Za-z0-9_-]{20,}$/.test(key)) throw new UsageError("That does not look like a Ztalio API key (ztk_…).");
    const api = await client({ key, base: flags.base });
    const me = await api.get("/me");
    const cfg = await readConfig();
    const file = await writeConfig({ ...cfg, apiKey: key, ...(flags.base ? { apiBase: flags.base } : {}) });
    out(json, { ok: true, email: me.email, plan: me.plan, scopes: me.key.scopes, config: file },
      `Signed in as ${me.email} (${me.plan} plan, key "${me.key.name}": ${me.key.scopes.join(", ")}). Saved to ${file}`);
  },

  async logout({ json }) {
    const cfg = await readConfig(); delete cfg.apiKey;
    const file = await writeConfig(cfg);
    out(json, { ok: true }, `Removed the saved key from ${file}`);
  },

  async whoami({ api, json }) {
    const me = await api.get("/me");
    const r = me.resources || {};
    out(json, me, [`${me.email}${me.name ? `  (${me.name})` : ""}`, `plan: ${me.plan}`,
      `screens: ${r.displaysLinked ?? "?"} of ${r.displaysLimit ?? "?"}   storage: ${bytes(r.storageUsedBytes)} of ${r.storageGB} GB   team: ${r.usersLinked ?? 0}`,
      `key: ${me.key.name} [${me.key.scopes.join(", ")}]`].join("\n"));
  },

  async screens({ api, args, flags, json }) {
    if (args[0] === "rename") {
      const list = await screensOf(api);
      const s = pick(list, need(args[1], "screen"), "screen");
      const r = await api.post(`/screens/${encodeURIComponent(s.id)}/rename`, { name: need(args.slice(2).join(" "), "new name") });
      return out(json, r, `Renamed "${s.name}" → "${args.slice(2).join(" ")}"`);
    }
    const list = await screensOf(api);
    out(json, { screens: list }, table(list, [
      { label: "NAME", get: (s) => s.name },
      { label: "STATUS", get: (s) => (s.status !== "paired" ? s.status : s.online ? "online" : "offline") },
      { label: "LAST SEEN", get: (s) => ago(s.lastSeenAt) },
      { label: "NOW PLAYING", get: (s) => (s.nowPlaying ? `${s.nowPlaying.itemCount} items${s.nowPlaying.firstItem ? ` · ${s.nowPlaying.firstItem}` : ""}` : "—") },
      { label: "ID", get: (s) => s.id },
    ]));
  },

  async playlists({ api, args, flags, json }) {
    const sub = args[0];
    if (!sub || sub === "list") {
      let list = await playlistsOf(api);
      // The list endpoint carries name + count only; details (speed, transition, flags) need one
      // read each — cheap for the handful of playlists an account has, skipped for very large ones.
      if (list.length && list.length <= 30) {
        list = await Promise.all(list.map((p) => api.get(`/playlists/${encodeURIComponent(p.playlistId)}`).then((d) => ({ ...p, ...d })).catch(() => p)));
      }
      return out(json, list, table(list, [
        { label: "NAME", get: (p) => p.name },
        { label: "ITEMS", get: (p) => (Array.isArray(p.items) ? p.items.length : p.itemsCount ?? "") },
        { label: "SPEED", get: (p) => speedLabel(p.slideSeconds) },
        { label: "TRANSITION", get: (p) => (p.transition && p.transition !== "none" ? p.transition : "") },
        { label: "FLAGS", get: (p) => [p.schedule?.rules?.length ? "scheduled" : "", p.shuffleEnabled ? "shuffle" : "", p.backgroundMusicS3Key ? "music" : ""].filter(Boolean).join(" ") },
        { label: "ID", get: (p) => p.playlistId || p.id },
      ]));
    }
    if (sub === "create") {
      const name = need(args.slice(1).join(" "), "playlist name");
      const r = await api.post("/playlists", { name });
      return out(json, r, `Created playlist "${r.name}" (${r.playlistId})`);
    }
    const list = await playlistsOf(api);
    const p = pick(list, need(args[1], "playlist"), "playlist", { id: "playlistId" });
    const id = encodeURIComponent(p.playlistId);
    if (sub === "show") {
      const full = await api.get(`/playlists/${id}`);
      return out(json, full, [`${full.name}  (${full.playlistId})`,
        `speed: ${speedLabel(full.slideSeconds) || "default"}   transition: ${full.transition}   shuffle: ${full.shuffleEnabled ? "on" : "off"}   music: ${full.backgroundMusicS3Key ? basename(full.backgroundMusicS3Key) : "off"}   schedule: ${full.schedule?.rules?.length ? `${full.schedule.rules.length} rule(s)` : "none"}`,
        "", table(full.items || [], [{ label: "TITLE", get: (it) => it.title || basename(it.s3Key) }, { label: "TYPE", get: (it) => it.mediaType || "" }, { label: "KEY", get: (it) => it.s3Key }])].join("\n"));
    }
    if (sub === "add" || sub === "remove") {
      const feed = await mediaOf(api);
      const keys = args.slice(2).map((q) => mediaPick(feed.items, q).s3Key);
      if (!keys.length) throw new UsageError("Name the items to add (title or key). See `ztalio media`.");
      const r = sub === "add" ? await api.post(`/playlists/${id}/items`, { s3Keys: keys }) : await api.del(`/playlists/${id}/items`, { s3Keys: keys });
      return out(json, r, `${sub === "add" ? "Added" : "Removed"} ${keys.length} item(s) ${sub === "add" ? "to" : "from"} "${p.name}"`);
    }
    if (sub === "set") {
      const patch = {};
      if (flags.name) patch.name = flags.name;
      if (flags.speed !== undefined) { const s = Number(flags.speed); if (!Number.isInteger(s) || s < 2 || s > 3600) throw new UsageError("--speed is seconds per photo, 2–3600"); patch.slideSeconds = s; }
      if (flags.transition !== undefined) { if (!TRANSITIONS.includes(flags.transition)) throw new UsageError(`--transition must be one of ${TRANSITIONS.join(", ")}`); patch.transition = flags.transition; }
      if (flags.shuffle !== undefined) patch.shuffleEnabled = ["on", "true", "1", "yes", true].includes(flags.shuffle);
      if (flags.music !== undefined) {
        if (["off", "none", "false"].includes(String(flags.music))) patch.backgroundMusicS3Key = null;
        else {
          const { tracks } = await api.get("/music");
          const feed = await mediaOf(api);
          const own = feed.items.filter((i) => i.mediaType === "audio").map((i) => ({ id: i.s3Key, title: i.title, s3Key: i.s3Key }));
          const t = pick([...tracks.map((t) => ({ id: t.id, title: t.title, s3Key: t.s3Key })), ...own], flags.music, "track", { id: "id", name: "title" });
          patch.backgroundMusicS3Key = t.s3Key;
        }
      }
      if (flags.schedule !== undefined) patch.schedule = parseSchedule(String(flags.schedule));
      if (flags["schedule-json"] !== undefined) patch.schedule = flags["schedule-json"] === "off" ? null : JSON.parse(flags["schedule-json"]);
      if (!Object.keys(patch).length) throw new UsageError("Nothing to set. Flags: --name, --speed <sec>, --transition <none|dissolve|slide|flip|zoom>, --shuffle on|off, --music <track|off>, --schedule \"mon-fri 8-17\"|off");
      const r = await api.patch(`/playlists/${id}`, patch);
      return out(json, r, `Updated "${r.name || p.name}": ${Object.entries(patch).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(" ")}`);
    }
    if (sub === "delete") {
      const r = await api.del(`/playlists/${id}`);
      return out(json, r, `Deleted "${p.name}"`);
    }
    throw new UsageError("playlists: list | show <playlist> | create <name> | add <playlist> <item…> | remove <playlist> <item…> | set <playlist> --speed 7 --transition dissolve … | delete <playlist>");
  },

  async push({ api, args, flags, json }) {
    const playlists = await playlistsOf(api);
    const p = pick(playlists, need(args[0], "playlist"), "playlist", { id: "playlistId" });
    const screens = await screensOf(api);
    let targets;
    if (flags.all) targets = screens.filter((s) => s.status === "paired");
    else {
      const names = String(need(flags.to, "--to <screen[,screen…]> (or --all)")).split(",").map((s) => s.trim()).filter(Boolean);
      targets = names.map((n) => pick(screens, n, "screen"));
    }
    if (!targets.length) throw new UsageError("No screens to push to.");
    const body = { playlistId: p.playlistId, screenIds: targets.map((t) => t.id) };
    if (flags.speed) body.slideSeconds = Number(flags.speed);
    if (flags.transition) body.transition = flags.transition;
    const r = await api.post("/push", body);
    out(json, r, `Pushed "${p.name}" to ${targets.map((t) => t.name).join(", ")}${r.failedDisplays?.length ? `\nFailed: ${r.failedDisplays.map((f) => `${f.displayId} (${f.reason})`).join(", ")}` : ""}`);
  },

  async media({ api, args, flags, json }) {
    const feed = await mediaOf(api);
    let items = feed.items || [];
    if (flags.folder) { const f = pick(await foldersOf(api), flags.folder, "folder"); items = items.filter((i) => i.folderId === f.id); }
    if (flags.type) items = items.filter((i) => i.mediaType === flags.type);
    const folders = new Map((feed.folders || []).map((f) => [f.id, f.name]));
    out(json, { folders: feed.folders, items }, table(items, [
      { label: "TITLE", get: (i) => i.title },
      { label: "TYPE", get: (i) => i.mediaType },
      { label: "FOLDER", get: (i) => folders.get(i.folderId) || i.folderId },
      { label: "SIZE", get: (i) => (i.size ? bytes(i.size) : "") },
      { label: "KEY", get: (i) => i.s3Key },
    ]));
  },

  async folders({ api, args, json }) {
    if (args[0] === "create") {
      const r = await api.post("/folders", { name: need(args.slice(1).join(" "), "folder name") });
      return out(json, r, `Created folder "${r.name}" (${r.folderId})`);
    }
    const list = await foldersOf(api);
    out(json, list, table(list, [{ label: "NAME", get: (f) => f.name }, { label: "ITEMS", get: (f) => f.itemCount ?? "" }, { label: "SHARED", get: (f) => (f.shared ? "shared with you" : "") }, { label: "ID", get: (f) => f.id }]));
  },

  async music({ api, json }) {
    const { tracks } = await api.get("/music");
    out(json, tracks, table(tracks, [{ label: "ID", get: (t) => t.id }, { label: "TITLE", get: (t) => t.title }, { label: "MOOD", get: (t) => t.mood }, { label: "LENGTH", get: (t) => speedLabel(t.durationSec) }]));
  },

  async upload({ api, args, flags, json }) {
    if (!args.length) throw new UsageError("upload <file…> [--folder <name>]");
    let folderId = "root";
    if (flags.folder) folderId = pick(await foldersOf(api), flags.folder, "folder").id;
    const results = [];
    for (const file of args) {
      const size = statSync(file).size;
      const ext = extname(file).slice(1).toLowerCase();
      const contentType = MIME[ext]; if (!contentType) throw new UsageError(`Unsupported file type .${ext} (${file})`);
      const totalParts = Math.max(1, Math.ceil(size / PART_SIZE));
      const init = await api.post("/uploads", { filename: basename(file), contentType, sizeBytes: size, totalParts, folderId });
      const { parts } = await api.post(`/uploads/${encodeURIComponent(init.uploadId)}/part-urls`, { partNumbers: Array.from({ length: totalParts }, (_, i) => i + 1) });
      const done = [];
      const buf = await readFile(file);
      for (const part of parts) {
        const chunk = buf.subarray((part.partNumber - 1) * PART_SIZE, part.partNumber * PART_SIZE);
        const res = await fetch(part.url, { method: "PUT", body: chunk, headers: { "content-type": contentType } });
        if (!res.ok) throw new Error(`Part ${part.partNumber} of ${basename(file)} failed: HTTP ${res.status}`);
        done.push({ partNumber: part.partNumber, etag: res.headers.get("etag") });
        if (!json) process.stderr.write(`\r${basename(file)}: ${Math.round((part.partNumber / totalParts) * 100)}%`);
      }
      const fin = await api.post(`/uploads/${encodeURIComponent(init.uploadId)}/complete`, { parts: done });
      if (!json) process.stderr.write("\r\x1b[K");
      results.push({ file: basename(file), size, s3Key: fin.s3Key, folderId });
    }
    out(json, { uploaded: results }, results.map((r) => `Uploaded ${r.file} (${bytes(r.size)}) — it appears in your library within a minute`).join("\n"));
  },

  async api({ api, args, flags, json }) {
    const method = String(need(args[0], "METHOD")).toUpperCase();
    const path = need(args[1], "path (e.g. /screens)");
    const body = flags.data !== undefined ? JSON.parse(flags.data) : (["POST", "PATCH", "DELETE"].includes(method) ? {} : undefined);
    const r = await api.call(method, path.startsWith("/") ? path : `/${path}`, body, { raw: true });
    process.stdout.write(JSON.stringify(r.data, null, 2) + "\n");
  },

  async agent() {
    process.stdout.write(AGENT_GUIDE);
  },

  async config({ json }) {
    const cfg = await readConfig();
    out(json, { file: configPath(), hasKey: !!cfg.apiKey, apiBase: cfg.apiBase || null }, `${configPath()}\nkey: ${cfg.apiKey ? "saved" : "none"}  base: ${cfg.apiBase || "(default)"}`);
  },
};

export const HELP = `ztalio — Ztalio digital signage from the command line  (https://ztalio.com/developers)

  ztalio login [--key ztk_…]            save your API key (Settings → API access; Pro & Network)
  ztalio whoami                          account, plan, usage
  ztalio screens                         your TVs: online/offline, what's playing
  ztalio screens rename <screen> <name>
  ztalio playlists                       list playlists
  ztalio playlists show <playlist>
  ztalio playlists create <name>
  ztalio playlists add <playlist> <item…>     items by title (see \`ztalio media\`) or key
  ztalio playlists remove <playlist> <item…>
  ztalio playlists set <playlist> --speed 7 --transition dissolve --shuffle on --music "Tokyo Dreams"
  ztalio playlists set <playlist> --schedule "mon-fri 8-17"     (hours in your account timezone; "off" clears)
  ztalio playlists delete <playlist>
  ztalio push <playlist> --to "Lobby,Bar 2"   (or --all)   the TVs change within seconds
  ztalio media [--folder <name>] [--type image|video|audio]
  ztalio upload <file…> [--folder <name>]
  ztalio folders | folders create <name>
  ztalio music                           built-in background tracks
  ztalio api <METHOD> </path> [--data '{…}']   raw call to https://api.ztalio.com/v1
  ztalio agent                           how an AI assistant should use this tool

Screens and playlists can be named by id or by (part of) their name.
Global: --json (machine output), --key, --base. Env: ZTALIO_API_KEY, ZTALIO_API_BASE.
`;

const AGENT_GUIDE = `# Using the ztalio CLI as an AI assistant

You control a Ztalio account's TV screens. Everything is idempotent and safe to retry; add --json
to every command and parse stdout. Typical flow:

1. ztalio screens --json            → which TVs exist, whether they are online, what each is showing
2. ztalio media --json              → the library (title, mediaType, s3Key)
3. ztalio playlists --json          → existing playlists
4. Make or edit a playlist:
     ztalio playlists create "Lunch specials"
     ztalio playlists add "Lunch specials" "Tacos.jpg" "Burger.jpg"
     ztalio playlists set "Lunch specials" --speed 8 --transition dissolve
5. Put it on the screen:  ztalio push "Lunch specials" --to "Lobby"      (the TV updates in seconds)
6. New content:           ztalio upload ./menu.png --folder Promos     (wait ~1 min, then it is in \`ztalio media\`)

Before a push, confirm with the user which screen(s) and which playlist. Never push to --all unless
the user said "all screens". Errors are JSON on stderr with a "code": NO_KEY (ask the user to run
\`ztalio login\`), UPGRADE_REQUIRED (the plan does not include API access), SCOPE (the key lacks
write/push), RATE_LIMITED (wait a minute), NOT_FOUND.
`;

export { ApiError, UsageError };

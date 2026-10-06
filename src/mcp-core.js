// MCP (Model Context Protocol) over the Ztalio API — the one tool set behind both hosts:
//   `ztalio mcp`                 stdio server for Claude Desktop / Claude Code / Cursor / Codex
//   https://api.ztalio.com/v1/mcp  Streamable-HTTP server (Lambda), API key in the Authorization header
//
// Every tool is a thin call on the public REST API with the caller's own key, so plan, scope,
// rate limit and audit all happen in api-v1 — this layer holds no secrets and no state. The
// JSON-RPC handling is written out here (initialize / tools/list / tools/call / ping) rather
// than pulled from the SDK, which keeps the CLI dependency-free.
import { pick, parseItems, parseSchedule, TRANSITIONS, UsageError } from "./resolve.js";
import { ApiError } from "./api.js";

export const SERVER_INFO = { name: "ztalio", version: "0.3.0" };
export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

export const INSTRUCTIONS = `Ztalio runs TV screens (Roku, Fire TV, Apple TV, Google TV, LG, Samsung) as digital signs and
slideshows. You control one customer's account. Typical flow: list_screens → list_media / list_playlists
→ create or edit a playlist → push_playlist to a screen (the TV changes within seconds). create_slide makes
a picture from text alone (menu board, promo, announcement, hours, welcome, event) with no file; use
preview:true to look at it before saving. Screens, playlists, folders and media can be named by (part of)
their name. Always confirm with the user WHICH screen before pushing; never push to all screens unless they
said so. Errors carry a code: UPGRADE_REQUIRED (plan without API access), SCOPE (key lacks write/push),
RATE_LIMITED (wait a minute), NOT_FOUND.`;

const str = (d, extra = {}) => ({ type: "string", description: d, ...extra });
const arr = (d, items) => ({ type: "array", description: d, items });
const obj = (properties, required = []) => ({ type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false });

export const TOOLS = [
  { name: "whoami", description: "The account behind this key: email, plan, usage and the key's scopes.", inputSchema: obj({}) },
  { name: "list_screens", description: "All TV screens on the account with online/offline, last seen and what each is showing now.", inputSchema: obj({}) },
  { name: "rename_screen", description: "Rename a screen.", inputSchema: obj({ screen: str("screen name or id"), name: str("new name") }, ["screen", "name"]) },
  { name: "list_playlists", description: "All playlists with item counts, slide speed, transition and flags (scheduled / shuffle / music).", inputSchema: obj({}) },
  { name: "get_playlist", description: "One playlist with its items and settings.", inputSchema: obj({ playlist: str("playlist name or id") }, ["playlist"]) },
  { name: "create_playlist", description: "Create an empty playlist.", inputSchema: obj({ name: str("playlist name") }, ["name"]) },
  { name: "add_to_playlist", description: "Append library items to a playlist, by title or key (see list_media).", inputSchema: obj({ playlist: str("playlist name or id"), items: arr("item titles or keys", { type: "string" }) }, ["playlist", "items"]) },
  { name: "remove_from_playlist", description: "Remove items from a playlist, by title or key.", inputSchema: obj({ playlist: str("playlist name or id"), items: arr("item titles or keys", { type: "string" }) }, ["playlist", "items"]) },
  { name: "update_playlist", description: "Change a playlist's name, seconds per photo (2–3600), transition, shuffle, background music or schedule.",
    inputSchema: obj({ playlist: str("playlist name or id"), name: str("new name"), slideSeconds: { type: "integer", minimum: 2, maximum: 3600, description: "seconds each photo stays on screen" },
      transition: str("between photos", { enum: TRANSITIONS }), shuffle: { type: "boolean" }, music: str('built-in track id/title, own audio title, or "off"'),
      schedule: str('"8-17", "mon-fri 8-17", "mon,wed,fri 9-21; sat 10-14" (hours in the account timezone, 0–24) or "off"') }, ["playlist"]) },
  { name: "delete_playlist", description: "Delete a playlist (the media stays in the library).", inputSchema: obj({ playlist: str("playlist name or id") }, ["playlist"]) },
  { name: "push_playlist", description: "Show a playlist on one or more screens right now. Confirm the screen with the user first.",
    inputSchema: obj({ playlist: str("playlist name or id"), screens: arr("screen names or ids", { type: "string" }), all: { type: "boolean", description: "every paired screen — only if the user asked for all screens" } }, ["playlist"]) },
  { name: "list_media", description: "The library: pictures, videos and audio with their titles, folders and keys.", inputSchema: obj({ folder: str("only this folder (name)"), type: str("image | video | audio", { enum: ["image", "video", "audio"] }) }) },
  { name: "list_folders", description: "Library folders.", inputSchema: obj({}) },
  { name: "list_slide_templates", description: "The eight slide templates (menu board, price list, promo, announcement, hours, welcome, event, portrait menu) and the fields each accepts.", inputSchema: obj({}) },
  { name: "create_slide", description: "Make a 1920×1080 slide from text with Ztalio Studio's renderer and save it to the library (folder \"Studio\"); no file needed. Optionally append it to a playlist and push it to screens in the same call. With preview:true nothing is saved and the image is returned so you can look first. With prompt, the Studio assistant lays the slide out from a sentence.",
    inputSchema: obj({
      template: str("menu-board | price-list | promo | announcement | hours | welcome | event | portrait-menu (default: menu-board when items are given, else announcement)"),
      title: str("main line"), subtitle: str("second line"), kicker: str("small label above the title"), body: str("paragraph; newlines allowed"), badge: str("text inside the round badge (promo)"),
      items: arr("menu / price / hours rows", obj({ name: str("item"), price: str("price or right-hand text"), desc: str("description"), tag: str("small tag, e.g. New") }, ["name"])),
      logo: str("a picture from the library (title or key) used as the logo"), photo: str("a picture from the library used as the photo/background"),
      accent: str("accent colour #RRGGBB"), font: str("Inter | Playfair Display | Bebas Neue | Lora | Montserrat"), name: str("file title in the library"),
      prompt: str("describe the slide in a sentence and let the Studio assistant design it (slower, ~15 s)"),
      add_to_playlist: str("append the slide to this playlist (name or id)"), push_to_screens: arr("push the slide to these screens (names or ids)", { type: "string" }),
      preview: { type: "boolean", description: "render only; return the PNG, save nothing" },
    }) },
  { name: "screen_analytics", description: "Screen uptime analytics for the last N days (on now, last seen, hours on per day, usual hours) and proof of play.", inputSchema: obj({ days: { type: "integer", minimum: 1, maximum: 30, default: 7 } }) },
];

// ---------------------------------------------------------------------------------------
const text = (v) => ({ content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }] });
const need = (v, what) => { if (v === undefined || v === null || v === "") throw new UsageError(`Missing ${what}`); return v; };
const screensOf = async (api) => (await api.get("/screens")).screens;
const playlistsOf = (api) => api.get("/playlists");
const mediaOf = (api) => api.get("/media");
const foldersOf = async (api) => {
  const [feed, v2] = await Promise.all([mediaOf(api), api.get("/folders").catch(() => ({ items: [] }))]);
  const byId = new Map();
  for (const f of feed.folders || []) byId.set(f.id, { id: f.id, name: f.name, itemCount: f.itemCount ?? null });
  for (const f of v2.items || []) byId.set(f.folderId, { id: f.folderId, name: f.name, itemCount: byId.get(f.folderId)?.itemCount ?? null, shared: !!f.isShared && !f.isOwner });
  return [...byId.values()];
};
const mediaPick = (items, q) => pick(items, q, "media item", { id: "s3Key", name: "title", alt: (i) => (i.s3Key || "").split("/").pop(), cmd: "media" });
const playlistPick = async (api, q) => pick(await playlistsOf(api), need(q, "playlist"), "playlist", { id: "playlistId" });
const screenPick = (screens, q) => pick(screens, q, "screen");

export async function callTool(api, name, a = {}) {
  switch (name) {
    case "whoami": return text(await api.get("/me"));
    case "list_screens": return text({ screens: await screensOf(api) });
    case "rename_screen": {
      const s = screenPick(await screensOf(api), need(a.screen, "screen"));
      await api.post(`/screens/${encodeURIComponent(s.id)}/rename`, { name: need(a.name, "name") });
      return text(`Renamed "${s.name}" to "${a.name}"`);
    }
    case "list_playlists": {
      let list = await playlistsOf(api);
      if (list.length && list.length <= 30) list = await Promise.all(list.map((p) => api.get(`/playlists/${encodeURIComponent(p.playlistId)}`).then((d) => ({ ...p, ...d, items: undefined, itemsCount: d.items?.length ?? p.itemsCount })).catch(() => p)));
      return text(list.map((p) => ({ playlistId: p.playlistId, name: p.name, items: p.itemsCount, slideSeconds: p.slideSeconds ?? null, transition: p.transition ?? null,
        scheduled: !!p.schedule?.rules?.length, shuffle: !!p.shuffleEnabled, music: p.backgroundMusicS3Key ? p.backgroundMusicS3Key.split("/").pop() : null })));
    }
    case "get_playlist": { const p = await playlistPick(api, a.playlist); return text(await api.get(`/playlists/${encodeURIComponent(p.playlistId)}`)); }
    case "create_playlist": return text(await api.post("/playlists", { name: need(a.name, "name") }));
    case "add_to_playlist": case "remove_from_playlist": {
      const p = await playlistPick(api, a.playlist);
      const feed = await mediaOf(api);
      const keys = (Array.isArray(a.items) ? a.items : [a.items]).filter(Boolean).map((q) => mediaPick(feed.items, q).s3Key);
      if (!keys.length) throw new UsageError("items required");
      const path = `/playlists/${encodeURIComponent(p.playlistId)}/items`;
      const r = name === "add_to_playlist" ? await api.post(path, { s3Keys: keys }) : await api.del(path, { s3Keys: keys });
      return text({ playlist: p.name, ...r, keys });
    }
    case "update_playlist": {
      const p = await playlistPick(api, a.playlist);
      const patch = {};
      if (a.name) patch.name = String(a.name);
      if (a.slideSeconds !== undefined) { const s = Number(a.slideSeconds); if (!Number.isInteger(s) || s < 2 || s > 3600) throw new UsageError("slideSeconds must be 2–3600"); patch.slideSeconds = s; }
      if (a.transition !== undefined) { if (!TRANSITIONS.includes(a.transition)) throw new UsageError(`transition must be one of ${TRANSITIONS.join(", ")}`); patch.transition = a.transition; }
      if (a.shuffle !== undefined) patch.shuffleEnabled = !!a.shuffle;
      if (a.music !== undefined) {
        if (["off", "none", "false", ""].includes(String(a.music).toLowerCase())) patch.backgroundMusicS3Key = null;
        else {
          const [{ tracks }, feed] = await Promise.all([api.get("/music"), mediaOf(api)]);
          const own = feed.items.filter((i) => i.mediaType === "audio").map((i) => ({ id: i.s3Key, title: i.title, s3Key: i.s3Key }));
          patch.backgroundMusicS3Key = pick([...tracks.map((t) => ({ id: t.id, title: t.title, s3Key: t.s3Key })), ...own], a.music, "track", { id: "id", name: "title", cmd: "music" }).s3Key;
        }
      }
      if (a.schedule !== undefined) patch.schedule = parseSchedule(String(a.schedule));
      if (!Object.keys(patch).length) throw new UsageError("Nothing to change");
      return text(await api.patch(`/playlists/${encodeURIComponent(p.playlistId)}`, patch));
    }
    case "delete_playlist": { const p = await playlistPick(api, a.playlist); await api.del(`/playlists/${encodeURIComponent(p.playlistId)}`); return text(`Deleted "${p.name}"`); }
    case "push_playlist": {
      const p = await playlistPick(api, a.playlist);
      const screens = await screensOf(api);
      const targets = a.all ? screens.filter((s) => s.status === "paired") : (Array.isArray(a.screens) ? a.screens : [a.screens]).filter(Boolean).map((q) => screenPick(screens, q));
      if (!targets.length) throw new UsageError("Name the screens (or all:true if the user asked for every screen)");
      const r = await api.post("/push", { playlistId: p.playlistId, screenIds: targets.map((t) => t.id) });
      return text({ pushed: p.name, screens: targets.map((t) => t.name), ...r });
    }
    case "list_media": {
      const feed = await mediaOf(api);
      let items = feed.items || [];
      if (a.folder) { const f = pick(await foldersOf(api), a.folder, "folder"); items = items.filter((i) => i.folderId === f.id); }
      if (a.type) items = items.filter((i) => i.mediaType === a.type);
      const folders = new Map((feed.folders || []).map((f) => [f.id, f.name]));
      return text(items.slice(0, 300).map((i) => ({ title: i.title, type: i.mediaType, folder: folders.get(i.folderId) || i.folderId, key: i.s3Key })));
    }
    case "list_folders": return text(await foldersOf(api));
    case "list_slide_templates": return text((await api.get("/slides/templates")).templates);
    case "create_slide": {
      const fields = {};
      for (const f of ["title", "subtitle", "kicker", "body", "badge", "accent", "font", "name"]) if (a[f] !== undefined && a[f] !== null) fields[f] = String(a[f]);
      if (a.items) fields.items = typeof a.items === "string" ? parseItems(a.items) : a.items;
      if (a.logo || a.photo) {
        const images = (await mediaOf(api)).items.filter((i) => i.mediaType === "image");
        if (a.logo) fields.logo = mediaPick(images, a.logo).s3Key;
        if (a.photo) fields.photo = mediaPick(images, a.photo).s3Key;
      }
      const template = a.template || (fields.items ? "menu-board" : "announcement");
      if (!a.prompt && !Object.keys(fields).length) throw new UsageError("Give the slide some content (title, items, …) or a prompt");
      const body = { template, fields };
      if (a.add_to_playlist) body.playlistId = (await playlistPick(api, a.add_to_playlist)).playlistId;
      if (a.push_to_screens?.length) { const screens = await screensOf(api); body.screenIds = a.push_to_screens.map((q) => screenPick(screens, q).id); }
      if (a.prompt) { const p = await api.post("/slides/propose", { template, fields, prompt: String(a.prompt) }); body.doc = p.doc; delete body.template; delete body.fields; if (fields.name) body.name = fields.name; }
      if (a.preview) {
        const r = await api.post("/slides/preview", body.doc ? { doc: body.doc } : { template, fields });
        return { content: [{ type: "text", text: `Preview (${r.size.w}×${r.size.h}); nothing saved. Call again without preview to save it.` }, { type: "image", data: r.png, mimeType: "image/png" }] };
      }
      const r = await api.post("/slides", body);
      return text({ saved: r.title, key: r.s3Key, folder: "Studio", playlist: r.playlist, push: r.push, note: r.ready === false ? "still processing; it appears in the library within a minute" : undefined });
    }
    case "screen_analytics": return text(await api.get(`/screens/analytics?days=${Number(a.days) || 7}`));
    default: throw new UsageError(`Unknown tool ${name}`);
  }
}

// ---------------------------------------------------------------------------------------
// JSON-RPC dispatch shared by the stdio and HTTP transports. `getApi()` resolves the API client
// for the current caller (saved key on stdio; the request's bearer over HTTP).
// Returns a response object, or null for notifications.
export async function handleMessage(msg, getApi) {
  const id = msg?.id;
  const reply = (result) => ({ jsonrpc: "2.0", id, result });
  const fail = (code, message, data) => ({ jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } });
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return id === undefined ? null : fail(-32600, "Invalid request");
  const isNotification = id === undefined || id === null;
  try {
    switch (msg.method) {
      case "initialize": {
        const asked = msg.params?.protocolVersion;
        return reply({ protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0], capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS });
      }
      case "ping": return reply({});
      case "tools/list": return reply({ tools: TOOLS });
      case "tools/call": {
        const { name, arguments: args } = msg.params || {};
        if (!TOOLS.some((t) => t.name === name)) return fail(-32602, `Unknown tool: ${name}`);
        try {
          return reply(await callTool(await getApi(), name, args || {}));
        } catch (e) {
          const code = e instanceof ApiError ? e.code || `HTTP_${e.status}` : e.code || "ERROR";
          return reply({ content: [{ type: "text", text: `Error (${code}): ${e.message}${e instanceof ApiError && e.status === 402 ? " — API access is included with the Pro and Network plans: https://ztalio.com/settings" : ""}` }], isError: true });
        }
      }
      default:
        if (isNotification) return null;                      // notifications/initialized, notifications/cancelled, …
        return fail(-32601, `Method not found: ${msg.method}`);
    }
  } catch (e) {
    return isNotification ? null : fail(-32603, e.message || "Internal error");
  }
}

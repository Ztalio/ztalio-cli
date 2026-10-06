// Name resolution and small parsers shared by the CLI commands and the MCP tools.
export class UsageError extends Error { constructor(m) { super(m); this.code = "USAGE"; } }
export const TRANSITIONS = ["none", "dissolve", "slide", "flip", "zoom"];

export const norm = (v) => String(v ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
export function pick(list, query, label, { id = "id", name = "name", alt = () => "", cmd = `${label}s` } = {}) {
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

// "8-17" · "mon-fri 8-17" · "mon,wed,fri 9-21; sat 10-14" · "off"  →  { rules: [{ startHour, endHour, daysOfWeek? }] }
// Hours are in the account's timezone (Settings), 0–24; daysOfWeek 0 = Sunday, omitted = every day.
export const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
export function parseSchedule(text) {
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

// "Tacos=$4|three, street style; Burrito=$9 *Popular; Horchata" → [{ name, price?, desc?, tag? }]
export function parseItems(text) {
  return text.split(";").map((part) => {
    let t = part.trim(); if (!t) return null;
    const item = {};
    const tag = t.match(/\s\*(\S+)\s*$/); if (tag) { item.tag = tag[1]; t = t.slice(0, tag.index); }
    const [head, desc] = t.split("|"); if (desc) item.desc = desc.trim();
    const [name, price] = head.split("="); item.name = name.trim(); if (price) item.price = price.trim();
    return item.name ? item : null;
  }).filter(Boolean);
}


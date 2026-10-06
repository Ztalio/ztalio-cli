// Output helpers: a plain table for humans, JSON for scripts and agents (--json).
export function table(rows, columns) {
  if (!rows.length) return "(none)";
  const cells = rows.map((r) => columns.map((c) => String(c.get(r) ?? "")));
  const widths = columns.map((c, i) => Math.max(c.label.length, ...cells.map((row) => row[i].length)));
  const line = (vals) => vals.map((v, i) => v.padEnd(widths[i])).join("  ").trimEnd();
  return [line(columns.map((c) => c.label)), line(widths.map((w) => "-".repeat(w))), ...cells.map(line)].join("\n");
}

export function ago(iso) {
  if (!iso) return "never";
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return `${Math.round(s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function speedLabel(sec) {
  if (!sec) return "";
  if (sec < 60) return `${sec} s`;
  const m = Math.floor(sec / 60), r = sec % 60;
  return r ? `${m} min ${r} s` : `${m} min`;
}

export function bytes(n) {
  n = Number(n || 0);
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function out(json, data, human) {
  if (json) process.stdout.write(JSON.stringify(data, null, 2) + "\n");
  else process.stdout.write((typeof human === "function" ? human(data) : human) + "\n");
}

#!/usr/bin/env node
import { client } from "../src/api.js";
import { commands, HELP, ApiError, UsageError } from "../src/commands.js";

// --flag value | --flag=value | --flag (boolean) ; everything else positional. `--` ends flags.
function parse(argv) {
  const args = [], flags = {};
  const booleans = new Set(["json", "all", "help", "version", "setup", "templates"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") { args.push(...argv.slice(i + 1)); break; }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
      if (eq > 0) flags[name] = a.slice(eq + 1);
      else if (booleans.has(name) || i + 1 >= argv.length || argv[i + 1].startsWith("--")) flags[name] = true;
      else flags[name] = argv[++i];
    } else if (a === "-h") flags.help = true;
    else args.push(a);
  }
  return { args, flags };
}

const { args, flags } = parse(process.argv.slice(2));
const json = !!flags.json;
const [cmd, ...rest] = args;

if (flags.version) { const { version } = JSON.parse(await import("node:fs").then((fs) => fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"))); console.log(version); process.exit(0); }
if (!cmd || flags.help || cmd === "help") { process.stdout.write(HELP); process.exit(cmd ? 0 : 1); }

const fn = commands[cmd];
if (!fn) { process.stderr.write(`Unknown command "${cmd}".\n\n${HELP}`); process.exit(2); }

try {
  const needsApi = !["login", "logout", "agent", "config", "help", "mcp"].includes(cmd);
  const api = needsApi ? await client({ key: flags.key, base: flags.base }) : null;
  await fn({ api, args: rest, flags, json });
} catch (e) {
  const code = e instanceof ApiError ? e.code || `HTTP_${e.status}` : e.code || "ERROR";
  const hint = e instanceof ApiError && e.status === 402 ? ` Upgrade at ${e.body.upgradeUrl || "https://ztalio.com/settings"}.`
    : e instanceof ApiError && e.status === 401 ? " Run `ztalio login` with a current key." : "";
  if (json) process.stderr.write(JSON.stringify({ error: e.message, code, ...(e instanceof ApiError ? { status: e.status, details: e.body } : {}) }) + "\n");
  else process.stderr.write(`Error: ${e.message}${hint}\n`);
  process.exit(e instanceof UsageError ? 2 : 1);
}

# ztalio

Command-line client for [Ztalio](https://ztalio.com) digital signage. Manage your TV screens,
playlists and media library from the terminal, from scripts, or from an AI assistant such as
Claude Code or Codex. Zero dependencies; Node 18+.

```sh
npm install -g ztalio
ztalio login            # paste a key from ztalio.com → Settings → API access (Pro and Network plans)
ztalio screens          # your TVs: online/offline, what's playing
ztalio push "Happy Hour" --to Lobby
```

## Commands

```
ztalio login [--key ztk_…]              save your API key (~/.config/ztalio/config.json, mode 600)
ztalio whoami                            account, plan, usage
ztalio screens                           list TVs
ztalio screens rename <screen> <name>
ztalio playlists                         list playlists with speed / transition / flags
ztalio playlists show <playlist>
ztalio playlists create <name>
ztalio playlists add <playlist> <item…>        items by title or key (see `ztalio media`)
ztalio playlists remove <playlist> <item…>
ztalio playlists set <playlist> --speed 7 --transition dissolve --shuffle on --music "Tokyo Dreams"
ztalio playlists set <playlist> --schedule "mon-fri 8-17; sat 10-14"    ("off" clears)
ztalio playlists delete <playlist>
ztalio push <playlist> --to "Lobby,Bar 2"      (or --all)  — the TVs change within seconds
ztalio media [--folder <name>] [--type image|video|audio]
ztalio upload <file…> [--folder <name>]
ztalio folders | folders create <name>
ztalio music                             the built-in background tracks
ztalio api <METHOD> </path> [--data '{…}']     raw call to https://api.ztalio.com/v1
ztalio agent                             how an AI assistant should use this tool
```

Screens, playlists, folders and media can be named by id or by (part of) their name — case and
punctuation don't matter (`beachsunset` finds "Beach Sunset"). Add `--json` to any command for
machine-readable output; errors go to stderr as JSON with a `code`.

Environment: `ZTALIO_API_KEY` (overrides the saved key), `ZTALIO_API_BASE`, `ZTALIO_CONFIG_DIR`.

## For AI assistants

Run `ztalio agent` for a short guide. The pattern is: `ztalio screens --json` → `ztalio media --json`
→ create/edit a playlist → `ztalio push <playlist> --to <screen>`. Confirm the target screen with
the user before pushing; never use `--all` unless they said all screens.

## API

The CLI is a thin client over the public REST API: https://api.ztalio.com/v1 (OpenAPI at
`/v1/openapi.json`, docs at https://ztalio.com/developers). Keys carry scopes `read`, `write`,
`push`; 120 requests per minute per key.

MIT © Cre8ive Innovations LLC

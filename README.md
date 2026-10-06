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
ztalio slide --template promo --title "Happy hour" --subtitle "4–6 pm" --badge "$5 margaritas" --push Lobby
ztalio slide --items "Tacos=$4|three, street style; Burrito=$9 *Popular" --title "Lunch" --add-to "Lunch menu"
ztalio slide --prompt "lunch menu, six tacos around $4, bold" --preview check.png   (Studio assistant)
ztalio slide --templates                 the templates (menu board, price list, promo, announcement, hours, welcome, event, portrait menu) and their fields
ztalio folders | folders create <name>
ztalio music                             the built-in background tracks
ztalio api <METHOD> </path> [--data '{…}']     raw call to https://api.ztalio.com/v1
ztalio agent                             how an AI assistant should use this tool
```

Screens, playlists, folders and media can be named by id or by (part of) their name — case and
punctuation don't matter (`beachsunset` finds "Beach Sunset"). Add `--json` to any command for
machine-readable output; errors go to stderr as JSON with a `code`.

Environment: `ZTALIO_API_KEY` (overrides the saved key), `ZTALIO_API_BASE`, `ZTALIO_CONFIG_DIR`.

## Slides from text

`ztalio slide` renders a 1920×1080 PNG on the server with the same engine as ztalio.com/studio and
saves it to your library's "Studio" folder — no file needed. `--items` takes `name=price|description`
pairs separated by `;` (`*Tag` at the end adds a tag), `--logo`/`--photo` take a picture from your
library by name, `--accent #RRGGBB` and `--font` restyle the template, `--add-to` appends it to a
playlist and `--push` sends it to screens in one go. `--preview file.png` renders without saving so
you (or your assistant) can look first; `--prompt "…"` asks the Studio assistant to lay it out.

## For AI assistants

Run `ztalio agent` for a short guide. The pattern is: `ztalio screens --json` → `ztalio media --json`
→ create/edit a playlist → `ztalio push <playlist> --to <screen>`. Confirm the target screen with
the user before pushing; never use `--all` unless they said all screens.

## API

The CLI is a thin client over the public REST API: https://api.ztalio.com/v1 (OpenAPI at
`/v1/openapi.json`, docs at https://ztalio.com/developers). Keys carry scopes `read`, `write`,
`push`; 120 requests per minute per key.

MIT © Cre8ive Innovations LLC

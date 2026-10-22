# Least-privilege WordPress abilities over MCP: worked example

A small WordPress plugin that registers three abilities, a local WordPress to run it on, and a scripted MCP client that checks who can see and who can do what. It accompanies the [iLogr](https://ilogr.com/) article **[WordPress MCP Server: Least-Privilege Abilities for Claude Code and Codex](https://ilogr.com/wordpress-mcp-server-least-privilege-abilities/)**. No AI model or paid assistant is involved at any point: the checks are deterministic.

> **Before you use it:** this is example code for learning, provided as is, without warranty of any kind. Run it on a development machine or a disposable copy, never on a live site, store or database, and take a backup of anything you care about first. The test bed turns on settings that are unsafe outside a local machine, including application passwords over plain HTTP. You use all of it entirely at your own risk, and nobody who wrote or published it accepts any responsibility for loss, damage or other problems arising from its use. Review every file before you adapt any of it.

## Requirements

- Docker with Compose v2
- Node.js 20 or later and npm (for the checks)
- `bash` and `curl` (standard on macOS and Linux)
- Port 8089 free on 127.0.0.1 (8090 for the mutation harness). Set `WP_PORT` to use another port.

The setup script downloads one third-party plugin, the [MCP Adapter](https://github.com/WordPress/mcp-adapter/releases), from its official GitHub release page, and checks it against a pinned SHA-256 checksum. It is not part of this repository.

## Run it

```bash
./bin/setup.sh
cd tests && npm install && node check.mjs
```

Setup prints a one-line warning, builds the Docker project `mcp-least-privilege`, installs WordPress, the MCP Adapter and the example plugin, creates four users with different roles, and writes application passwords to `.state/` (git-ignored, never printed). If Docker is not running, a tool is missing or the port is taken, it stops straight away and says what to change.

A test bed that is already installed is not rebuilt unless you say so, because a rebuild deletes its users, posts and pages:

```bash
MCP_LAB_RESET=yes ./bin/setup.sh
```

Choose versions with environment variables on the setup command, on a fresh test bed (`docker compose down -v` first):

```bash
WP_VERSION=7.1.3 PHP_VERSION=8.3 ADAPTER_VERSION=0.6.2 ./bin/setup.sh
```

`ADAPTER_VERSION` accepts `0.6.1`, `0.6.2` (default) and `0.7.1`.

Expected results:

| Command | Expected |
| --- | --- |
| `./bin/setup.sh` | `Ready: http://localhost:8089 (WordPress 7.1.3, ...)`, exit code 0 |
| `node check.mjs` | `44 of 44 checks passed.`, exit code 0. Exit 1 means a check failed; exit 2 means the harness could not reach WordPress. |
| `node revert.mjs` | Twenty-two `CAUGHT` lines and `Restored plugin passes again.`, exit code 0 |

`revert.mjs` shows that the checks notice when a safeguard goes missing. It applies each mutation to a scratch copy of the plugin, one at a time, on a separate Docker stack (project `mcp-least-privilege-revert`), and requires named checks to fail. Allow 15 to 30 minutes, longer on slower machines. Ctrl+C or SIGTERM restores the plugin, removes the scratch stack and exits 130. With `--keep`, the stack stays up with the plugin restored. If teardown fails, the scratch folder is left in place, its path is printed and the exit code is 2.

Remove the main test bed and its data afterwards:

```bash
docker compose down -v
```

## What is in this repository

| Path | Purpose |
| --- | --- |
| `plugin/ilogr-draft-abilities/` | The plugin. Two abilities exposed to MCP, one registered but unexposed. |
| `compose.yaml` | WordPress 7.1.3 (PHP 8.3, Apache), MariaDB 11.4 and a WP-CLI container, bound to 127.0.0.1 only. The passwords are local test values. |
| `bin/setup.sh` | Installs WordPress, the MCP Adapter (checksum pinned), the plugin, four users, four posts, a draft page and two application passwords. |
| `tests/check.mjs` | 44 deterministic checks over STDIO, HTTP, REST and PHP, using the official MCP TypeScript SDK as the client. |
| `tests/revert.mjs` | Applies 22 selected mutations to a scratch copy of the plugin and requires the named checks to fail. |
| `client-config/` | Connection entries for Claude Code (`.mcp.json` format) and Codex (`config.toml`). |

## The three abilities

| Ability | Exposure | Permission callback | Notes |
| --- | --- | --- | --- |
| `ilogr/list-draft-titles` | `meta.mcp.public` only | `edit_posts` | Read-only. Returns only drafts the user may edit; the limit applies after that per-post check. |
| `ilogr/set-draft-excerpt` | `meta.mcp.public` only | `edit_post` for the given post ID | Write. Schema limits input; execute repeats the `edit_post` check, refuses anything but a draft post, refuses an excerpt that is empty once markup, whitespace and format characters are removed, and slashes data for `wp_update_post()`. |
| `ilogr/delete-stale-drafts` | none | `delete_others_posts`, then `delete_post` for each draft inside the execute callback | Site code only; invisible and unusable over MCP. Filters on local `post_modified`, rechecks each draft, accepts 30 to 3650 days, and refuses to run when the bin is disabled. |

`meta.mcp.public` exposes an ability to the MCP Adapter only. The WordPress 7.1 flag `meta.public` would also switch on the REST abilities endpoints, which the example does not want; check `R01` fails if it is used.

Object checks are repeated inside the execute callbacks because a `wp_ability_permission_result` filter can override any permission callback's answer, but not a `current_user_can()` call made later (capability filters such as `map_meta_cap` can still change that, so audit them too). Check `A02` installs such a filter on purpose and requires both refusals to hold.

Known limits, kept on purpose to stay small:

- The blank-excerpt pattern is not exhaustive: a few rare invisible characters (U+17B4, U+E0100, U+FFFC) still pass on their own.
- `sanitize_textarea_field()` strips tags and percent-encoded octets, so an excerpt such as "Save 20%ab" is stored as "Save 20". Adapt it if your excerpts need that.
- The draft list scans drafts in pages of 100 and stops once it has enough the user may edit. The scan still grows with the number of drafts a user may not edit. On a large site, narrow the query (for example by author for users without `edit_others_posts`) or add a scan limit and a cursor.

## Users created by setup

| Login | Role | Used for |
| --- | --- | --- |
| `admin` | Administrator | Proving the unexposed ability stays unusable even for an administrator. |
| `agent-editor` | Editor | The account an agent would normally use. Has an application password. |
| `agent-author` | Author | Proving the per-post check: own draft yes, another author's draft no. |
| `agent-subscriber` | Subscriber | The low-role account that must be denied. Has an application password. |
| `other-author` | Author | Owns the draft the others try to change. |

Passwords and application passwords are local test values for the disposable test bed.

## What the checks cover

- `S01` to `S05`: what a client can see. The default server shows only the adapter's three meta-tools, the two exposed abilities are discoverable, the unexposed one is not listed even for an administrator, a Subscriber can see the write ability it cannot use, and the three WordPress 7.1 core abilities appear through `meta.public` alone.
- `S06` to `S16`, `S23` to `S29`: what a client may do. Every write is read back from the database as an exact, untrimmed value. Includes the list limit applying after the per-post check (`S23`), markup stripped (`S24`), markup, whitespace and invisible characters refused (`S25`), a draft page refused (`S26`), backslashes preserved (`S27`), and the unexposed ability refused to a Subscriber and to a session with no user (`S28`, `S29`).
- `S17` to `S20`: the input schema rejects an over-long excerpt, a non-integer ID, an extra property and a missing field.
- `S21`, `S22`: behaviour pins for the MCP Adapter on WordPress 7.1. The ability's permission callback runs on raw input before schema validation, and a numeric string passes an `integer` schema. If an upgrade changes either, these fail.
- `H01` to `H06`: the HTTP transport with application passwords, including a session ID from one user refused with another user's credentials, and the unexposed ability refused to a Subscriber.
- `R01`: MCP-only exposure does not leak into the REST abilities endpoints.
- `R02`: a core ability's REST run URL refuses a request with no credentials.
- `P01` to `P05`: the unexposed ability called from PHP, as site code would. Only a stale draft is trashed (a never-edited draft, which WordPress gives a zero GMT modified date, survives), a draft the user may not delete is skipped, a Subscriber is refused, it refuses to run with the bin disabled, and `older_than_days` above 3650 is rejected.
- `A01`: nothing on the site hooks `wp_ability_permission_result` or `wp_pre_execute_ability`. On a real site this lists every callback so a person can review them.
- `A02`: with a filter that approves every permission check installed for the duration of the check, a Subscriber still cannot change another author's excerpt or trash a stale draft, because the execute callbacks ask again. The filter is removed afterwards, and `setup.sh` removes it if a run was cut short.

Newer MCP Adapter releases word the refusal of an unexposed ability differently: 0.6.x says "is not exposed via MCP", 0.7.1 answers as if the ability did not exist. The four checks that read that reply (`S14`, `S15`, `S28`, `H06`) accept either wording.

## The mutation harness

`revert.mjs` prints one line per mutation. The list is selective: passing it shows that these twenty-two changes are noticed, not that no other change could break the plugin.

The last mutation adds one line anywhere on the site:

```php
add_filter( 'wp_ability_permission_result', '__return_true' );
```

On WordPress 7.1 with MCP Adapter 0.6.x, that single filter lets a Subscriber, over STDIO or HTTP, and a STDIO process with no user, execute the unexposed ability. The adapter enforces MCP exposure and login inside its own `mcp-adapter/execute-ability` permission callback, and this filter can override that callback's result too. It also lets anonymous requests run the public core abilities through the REST abilities endpoints (`R02` fails), which exposes the administrator's email address and server versions. Anonymous requests to the MCP endpoint are still refused with 401, because its transport authentication is not an ability check, and the object checks inside the execute callbacks still hold; the harness requires `H01`, `H02` and `A02` to keep passing under this mutation.

## Connecting a client

The STDIO entries run WP-CLI inside the Compose stack. Replace `/path/to/worked-example` with the path of this folder. `--user` limits calls made through that MCP process only; it does not contain an agent that can run WP-CLI or Docker itself. On a site where `wp` runs directly, the documented form is:

```json
{
  "command": "wp",
  "args": ["--path=/path/to/wordpress", "mcp-adapter", "serve",
           "--server=mcp-adapter-default-server", "--user=agent-editor"]
}
```

For the HTTP entries, export the credential from this folder first:

```bash
export WP_MCP_BASIC_AUTH=$(printf 'agent-editor:%s' "$(cat .state/agent-editor.app-password)" | base64)
export WP_MCP_AUTHORIZATION="Basic $WP_MCP_BASIC_AUTH"
```

`WP_MCP_BASIC_AUTH` is used by the Claude Code entry and `WP_MCP_AUTHORIZATION` by the Codex entry.

Both clients accepted the shipped entries when they were tried. Claude Code (2.1.284) reported both servers as connected, and the HTTP entry failed with HTTP 401 when the credential was missing or wrong. Codex CLI (0.158) wrote and read back both entries with `codex mcp add`, `list` and `get`, but Codex cannot open an MCP session without starting a model turn, so its connection was not exercised.

## Not covered

Production hosting, HTTPS, OAuth, the `@automattic/mcp-wordpress-remote` proxy, multisite, custom MCP servers created with `create_server()`, WordPress versions before 7.1, any AI model's behaviour when it is refused, and large sites (see the note on the draft list above).

## Tested

Versions only. Every row below passed `node check.mjs` with 44 of 44 checks, and `node revert.mjs` caught all twenty-two mutations on the default row.

| WordPress | PHP | MCP Adapter | Note |
| --- | --- | --- | --- |
| 7.1.3 | 8.3 | 0.6.2 | Default. |
| 7.1.2 | 8.3 | 0.6.1 | The versions the article was written against. WordPress.org now marks 7.1.2 as insecure, so use it only to reproduce the article. |
| 7.1.3 | 8.2 | 0.6.2 | Lowest PHP version that the official WordPress image still ships. |
| 7.1.3 | 8.4 | 0.6.2 | |
| 7.1.3 | 8.5 | 0.7.1 | Newest of each. |

Also: MariaDB 11.4.13, WP-CLI 2.12.0, the MCP TypeScript SDK 1.32.1 as the test client, Node.js 24.21.0, Docker 29.7.2 with Compose 5.4.0 on macOS. The plugin file also passes `php -l` on PHP 7.4, 8.2 and 8.5.

**Minimum supported:** WordPress 7.1 (the `meta.public` flag, the core abilities and the permission filter that the checks exercise arrived in 7.1), MCP Adapter 0.6.1 and PHP 7.4 for the plugin itself (WordPress 7.1's own minimum). The test bed needs PHP 8.2 or later because the official images start there. Later versions may behave differently; checks `S21` and `S22` exist to tell you when the adapter changes the behaviour the example relies on.

## Licence

GPL-2.0-or-later, in full in `LICENSE`. The repository's main purpose is a WordPress plugin, and WordPress code is GPL-2.0-or-later, so the whole repository, scripts and tests included, is under that one licence. The MCP Adapter that the setup script downloads has its own licence (GPL-2.0-or-later) and is not part of this repository.

More code that accompanies iLogr guides: [github.com/ilogrblog](https://github.com/ilogrblog).

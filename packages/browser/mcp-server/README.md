# dsh-browser-mcp

A stdio MCP server that lets other agent tools (Claude Code, Cursor, Codex, or any MCP client) drive your browser through the DSH browser bridge. It is a small proxy with no dependencies. The real endpoint is the bridge plugin's loopback MCP server.

MCP calls go through the same path as DSH's own browser sessions:

- the same `browser_*` tools, with the same schemas and descriptions;
- the extension's pause gate, site policy, taint rules and kill switch;
- payload-bound approval cards in the side panel, labelled **"Requested by MCP client “<name>”"** (the name is reported by the client itself);
- the hash-chained audit log.

Each MCP client connection gets its own bridge-owned **external session** (`mcp-…`). An external session has no DSH conversation, so nobody can prompt it, read it as a DSH session, or inject into it. Its approvals are only answered in the browser. They are never forwarded to DSH's approval service.

## 1. Enable the endpoint in DSH

The endpoint is off by default. Enable it in the `bridge-browser` plugin config, either with a profile patch or in DSH settings:

```yaml
- id: bridge-browser
  config:
    mcp:
      enabled: true
      # port: 0        # default: a free loopback port each start
```

On the next start the plugin:

- listens on `127.0.0.1` only;
- writes `~/.dsh/browser-mcp-token`, a separate random bearer token (mode 0600), plus `~/.dsh/browser-mcp.json`, which holds `{ url, pid }` (mode 0600);
- refuses requests that carry an `Origin` header, a `Host` other than the loopback address and port, a non-JSON body, or a wrong token.

Keep DSH running and the browser extension connected.

## 2. Register the shim with your MCP client

The package is not published. Point your client at the script in your checkout or install:

```sh
SHIM=/absolute/path/to/dsh-browser/packages/browser/mcp-server/bin/dsh-browser-mcp.mjs
```

**Claude Code**

```sh
claude mcp add dsh-browser -- node "$SHIM"
# with a non-default DSH home:
claude mcp add dsh-browser -e DSH_HOME=/path/to/.dsh -- node "$SHIM"
```

**Cursor** (`~/.cursor/mcp.json` or `.cursor/mcp.json` in a project)

```json
{
  "mcpServers": {
    "dsh-browser": {
      "command": "node",
      "args": ["/absolute/path/to/dsh-browser/packages/browser/mcp-server/bin/dsh-browser-mcp.mjs"]
    }
  }
}
```

**Codex** (`~/.codex/config.toml`)

```toml
[mcp_servers.dsh-browser]
command = "node"
args = ["/absolute/path/to/dsh-browser/packages/browser/mcp-server/bin/dsh-browser-mcp.mjs"]
# env = { DSH_HOME = "/path/to/.dsh" }
```

## Environment

| Variable | Meaning |
|---|---|
| `DSH_HOME` | DSH home holding the token and endpoint files (default `~/.dsh`). |
| `DSH_BROWSER_MCP_URL` | Use this endpoint URL instead of the one in the endpoint file. Only loopback `http://` URLs are accepted. |
| `DSH_BROWSER_MCP_TOKEN` | Use this token instead of the one in the token file. |

The shim refuses a token file that is a symlink, belongs to another user, or is readable by group or others. When DSH restarts, the port and the session table change. The shim re-reads the endpoint file and replays the client's `initialize` once. The client is then on a fresh external session, with fresh taint and a new audit log. A message is re-sent only when the connection was refused or reset, or the endpoint moved to a new port. A tool call that was already delivered and is waiting for your approval is never sent twice, however long it waits. When the MCP client closes the shim's stdin, calls still in flight are abandoned and the MCP session is ended.

## Behaviour notes

- An action can wait for your decision in the browser: about 1 minute once the side panel shows the card, and up to 10 minutes as a system notification while the panel is closed. MCP approvals are never forwarded to DSH's own approval UI.
- Taint applies to MCP sessions as well. Once a call has read a page, that external session's later calls carry the taint, so the extension's taint rules, such as fresh approvals for writes to other sites, apply. The session also binds to the first browser install it reaches. If that browser disconnects, calls fail instead of moving to another profile.
- A denial, the kill switch, or a pause is your decision. The tool result says so, and the client should not retry.
- `browser_save_pdf` and `browser_extract { saveTo }` write into a DSH workspace, so they are refused for MCP clients. Read the data and save it with the client's own tools instead.
- `browser_screenshot` returns an MCP image block.
- The `browser_devtools_*` and `browser_console_*` tools are listed only while a Chrome extension that supports them is connected. They still need developer-tools consent in the panel.

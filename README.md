# mcp-crm

A learning project: a [Model Context Protocol](https://modelcontextprotocol.io) server that exposes a CRM to an MCP client over stdio.

Sign-in goes through Microsoft Entra using the device-code flow. The resulting identity token is exchanged for a CRM access token, so CRM queries run as the signed-in user and return only what that user is allowed to see.

## Requirements

- Node.js 20+
- An Entra app registration with the device-code (public client) flow enabled
- A CRM API that accepts an Entra token at `POST /api/auth/entra` and serves `GET /api/accounts`

## Setup

```bash
npm install
```

Create a `.env` in the project root:

```
ENTRA_CLIENT_ID=<your app registration's client id>
ENTRA_TENANT_ID=<your directory tenant id>
CRM_API_BASE_URL=https://your-crm.example.com
```

All three are required — the server throws on startup if any is missing. `.env` is gitignored; never commit it.

## Running

```bash
npx tsx src/index.ts     # run directly
npx tsc                  # type-check and build to dist/
```

The server speaks MCP over stdio, so it is normally launched by a client rather than by hand. To register it with Claude Code:

```json
{
  "mcpServers": {
    "crm": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/mcp-crm/src/index.ts"]
    }
  }
}
```

Log output goes to stderr, since stdout carries the MCP protocol.

## Tools

| Tool | Description |
| --- | --- |
| `start_crm_login` | Begins Entra device-code sign-in and returns the code and URL to visit. Returns immediately; the sign-in completes in the background. |
| `crm_login_status` | Reports whether that sign-in has finished, is still pending, or failed. |
| `search_crm_accounts` | Searches real CRM accounts by name. Requires a completed sign-in. Returns up to 25 matches with `id`, `name`, `status`, and `sales_rep`. |
| `get_crm_account` | Fetches full details for a single CRM account by `account_id`. Requires a completed sign-in. |
| `search_accounts` | Searches a small hardcoded list of sample accounts. No auth needed — used for testing the wiring without a live CRM. |

### Sign-in flow

`start_crm_login` cannot block until Entra finishes, so it is split in two:

1. Call `start_crm_login`. It returns the device code and the URL to open.
2. Complete sign-in in the browser.
3. Call `crm_login_status` to confirm. Once it reports a signed-in user, `search_crm_accounts` and `get_crm_account` will work.

The token is held in memory only — restarting the server means signing in again.

## License

ISC

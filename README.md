# `@origoid/mcp-server`

Official **Model Context Protocol** server for [OrigoID](https://docs.origoid.com).
Exposes every OrigoID API endpoint as an MCP tool so any MCP-compatible
client — Claude Code, Claude Desktop, Cursor, Windsurf, ChatGPT Desktop,
Codex CLI, Gemini, and others — can call OrigoID directly.

## Why

MCP is an open standard adopted by Anthropic (2024), OpenAI (2025), and
Google (2025). Install this server **once** and it works in every
MCP-capable client. Inside your IDE or chat you can say:

> "Validate CURP `PELJ900101HDFRRN09` against RENAPO."

The host LLM calls the `validate_curp` tool, this server proxies the
request through `@origoid/sdk` to `https://api.origoid.com`, and the
response envelope comes back as a structured result.

## Install

You do not install this package manually — your MCP client launches it
on demand via `npx`.

### Claude Code

```bash
claude mcp add origoid \
  --env ORIGOID_API_KEY=your_api_key \
  -- npx -y @origoid/mcp-server
```

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`
(macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "origoid": {
      "command": "npx",
      "args": ["-y", "@origoid/mcp-server"],
      "env": {
        "ORIGOID_API_KEY": "your_api_key"
      }
    }
  }
}
```

Restart Claude Desktop.

### Cursor / Windsurf / VS Code (Codex CLI / Codex extension)

Add to your client's `mcp.json` (path varies — Cursor uses
`~/.cursor/mcp.json`, Windsurf uses `~/.codeium/windsurf/mcp_config.json`):

```json
{
  "mcpServers": {
    "origoid": {
      "command": "npx",
      "args": ["-y", "@origoid/mcp-server"],
      "env": {
        "ORIGOID_API_KEY": "your_api_key"
      }
    }
  }
}
```

### ChatGPT Desktop

ChatGPT's MCP support uses the same JSON shape under **Settings →
Tools → Model Context Protocol**. Paste the `mcpServers.origoid` block
above.

### Gemini CLI / Antigravity

Edit `~/.gemini/settings.json` (or the equivalent Antigravity config):

```json
{
  "mcpServers": {
    "origoid": {
      "command": "npx",
      "args": ["-y", "@origoid/mcp-server"],
      "env": {
        "ORIGOID_API_KEY": "your_api_key"
      }
    }
  }
}
```

### Any other MCP client

Use:

- **Command:** `npx`
- **Args:** `["-y", "@origoid/mcp-server"]`
- **Env:** `ORIGOID_API_KEY=<your_api_key>`

The server speaks MCP over stdio (standard transport).

## Tools

| Tool name | OrigoID endpoint |
| --- | --- |
| `issue_token` | `POST /auth/token` |
| `validate_curp` | `POST /mex/renapo/v1/curp-validations` |
| `lookup_curp` | `POST /mex/renapo/v1/curp-lookups` |
| `validate_rfc` | `POST /mex/fiscal/v1/rfc-validations` |
| `extract_csf` | `POST /mex/fiscal/v1/csf-extractions` |
| `validate_cfdi` | `POST /mex/fiscal/v1/cfdi-validations` |
| `lookup_nss` | `POST /mex/social-security/v1/nss-lookups` |
| `get_employment_status` | `POST /mex/social-security/v1/employment-status` |
| `validate_voter_list` | `POST /mex/id/v1/voter-list-validations` |
| `extract_voter_id_data` | `POST /mex/id/v1/voter-id-extractions` |
| `extract_qr_data` | `POST /mex/id/v1/qr-extractions` |
| `search_sat_69` | `POST /mex/compliance/v1/sat-69-searches` |
| `search_sat_69b` | `POST /mex/compliance/v1/sat-69b-searches` |
| `search_ofac` | `POST /global/compliance/v1/ofac-searches` |
| `search_peps` | `POST /mex/compliance/v1/peps-searches` |
| `match_faces` | `POST /global/biometrics/v1/face-matches` |
| `check_liveness` | `POST /global/biometrics/v1/liveness-checks` |
| `validate_email` | `POST /global/email/v1/email-validations` |
| `extract_proof_of_address` | `POST /mex/documents/v1/proof-of-address-extractions` |

Each tool returns the full OrigoID envelope as a JSON string. The host
LLM reads `status`, `type`, `data`, `errors[]`, and `transactionId` to
present the result.

## Authentication

The server requires `ORIGOID_API_KEY` in its environment. The host MCP
client is responsible for injecting it via the `env` field in its
configuration. The server never accepts the API key as a tool argument
— that would expose it to the LLM context. Keep your key out of chat
transcripts.

## Cost

Every successful tool call consumes credits per the OrigoID pricing
policy. The LLM can call tools repeatedly when iterating on a task,
which adds up — set a billing alert on your OrigoID account and review
the tool list in your client before approving auto-execution.

## Source

GitHub: [github.com/origoid/mcp-server](https://github.com/origoid/mcp-server)

The source is public so you can audit exactly which request bodies are
sent to `https://api.origoid.com`.

## Support

[support@origoid.com](mailto:support@origoid.com) — bug reports, feature
requests, or help wiring up a new MCP client.

## License

MIT.

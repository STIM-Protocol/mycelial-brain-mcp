# Connect Your AI to Mycelial Brain

## How It Works

Mycelial Brain gives your AI agent persistent memory via the Model Context Protocol (MCP). When connected, the AI can:

- Search your knowledge base before answering
- Recall your preferences, projects, and history
- Maintain context across sessions and agents
- Write new memories back to the brain

## Self-Hosted Setup

### 1. Deploy the Server

```bash
git clone https://github.com/STIM-Protocol/mycelial-brain-mcp.git
cd mycelial-brain-mcp
npm install

export GCS_BUCKET_NAME=your-brain-bucket
export MCP_AUTH_TOKEN=generate-a-secure-token

npm start
```

Or deploy to Cloud Run:

```bash
npm run deploy
```

### 2. Connect Claude Desktop

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "mycelial-brain": {
      "url": "http://localhost:8080/mcp",
      "headers": {
        "Authorization": "Bearer your-token-here"
      }
    }
  }
}
```

### 3. Connect Other MCP-Compatible Agents

Any agent that supports MCP HTTP transport can connect:

```json
{
  "mcpServers": {
    "mycelial-brain": {
      "url": "https://your-deployment-url/mcp",
      "headers": {
        "Authorization": "Bearer your-token-here"
      }
    }
  }
}
```

## Hosted Option

Prefer a managed endpoint? [myceliate.cv](https://myceliate.cv) provides:

- Per-user MCP endpoint at `https://myceliate.cv/mcp/your-username`
- One-click .mcpb bundle download for Claude Desktop
- Dashboard with full-text search
- No infrastructure to manage

Sign up at [myceliate.cv/onboarding](https://myceliate.cv/onboarding).

## Available Tools

| Tool | Input | Output |
|------|-------|--------|
| `brain_search` | `query` (string), `limit` (number) | Scored results with path, tags, preview |
| `brain_read` | `path` (string, e.g. "doc-42") | Full document content |
| `brain_write` | `content` (string), `tags` (array), `path` (optional) | Confirmation with saved path |
| `brain_list` | none | All documents with their tags |
| `stim_write` | `content`, `namespace`, `author` | Confirmation with saved path |

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GCS_BUCKET_NAME` | Yes | `mycelial-brain-storage` | Google Cloud Storage bucket for documents |
| `MCP_AUTH_TOKEN` | No | (empty = open mode) | Bearer token for authentication |
| `PORT` | No | `8080` | Server port |

## Troubleshooting

**"Connection refused"**
- Ensure the server is running: `npm start`
- Check the port: `curl http://localhost:8080/health`

**"Unauthorized"**
- Verify your `MCP_AUTH_TOKEN` matches the Bearer token in your agent config

**"No results found"**
- The brain is empty. Use `brain_write` to seed documents first.

**"bucket not found"**
- Verify `GCS_BUCKET_NAME` and that your service account has access.

<p align="center">
  <img src="https://raw.githubusercontent.com/STIM-Protocol/stim-core/main/assets/stim-logo.png" alt="STIM Protocol" width="120" />
</p>

<h1 align="center">mycelial-brain-mcp</h1>

<p align="center">
  <strong>Persistent, decentralized context memory for AI agents</strong><br/>
  <em>STIM Protocol Reference Implementation: Mycelial Memory Layer</em>
</p>

<p align="center">
  <a href="https://github.com/STIM-Protocol/stim-core"><img alt="STIM Protocol" src="https://img.shields.io/badge/STIM-Layer_0-1a4a2e?style=flat&labelColor=0d2818"></a>
  <a href="https://github.com/STIM-Protocol/white-paper"><img alt="White Paper" src="https://img.shields.io/badge/White_Paper-v7.0011-1a4a2e?style=flat&labelColor=0d2818"></a>
  <a href="https://github.com/STIM-Protocol/Forest_OS"><img alt="Forest OS" src="https://img.shields.io/badge/Implementation-Forest_OS-1a4a2e?style=flat&labelColor=0d2818"></a>
  <a href="https://github.com/STIM-Protocol/stim-guard"><img alt="stim-guard" src="https://img.shields.io/badge/Constraint_Engine-stim--guard-1a4a2e?style=flat&labelColor=0d2818"></a>
  <img alt="License" src="https://img.shields.io/badge/License-Apache_2.0-1a4a2e?style=flat&labelColor=0d2818">
  <img alt="Node" src="https://img.shields.io/badge/Node-22+-1a4a2e?style=flat&labelColor=0d2818">
</p>

---

## What This Is

Just as mycelium connects trees and transfers nutrients across forests, Mycelial Brain connects your knowledge and transfers context across AI agents.

This is the open-source MCP (Model Context Protocol) server that powers the Mycelial Brain: a GCS-backed persistent memory system that any MCP-compatible AI agent can read from, write to, and search.

It is the memory layer of the [STIM Protocol](https://github.com/STIM-Protocol/stim-core): a Layer 0 constraint architecture that grounds autonomous AI in thermodynamic and ecological law rather than human preference.

## MCP Tools

Once connected, your AI agent gets five tools:

| Tool | Description |
|------|-------------|
| `brain_search` | Full-text keyword search across all brain documents with tag-weighted scoring |
| `brain_read` | Read a specific document by path (e.g., `doc-42`) |
| `brain_write` | Write a new document with auto-incremented ID or custom path |
| `brain_list` | List all documents with their tags |
| `stim_write` | Write a STIM protocol nugget with namespace and author metadata |

## Quick Start: Self-Host

### Prerequisites

- Node.js 22+
- Google Cloud Storage bucket (or fork with a different storage backend)

### Run Locally

```bash
git clone https://github.com/STIM-Protocol/mycelial-brain-mcp.git
cd mycelial-brain-mcp
npm install

# Set environment variables
export GCS_BUCKET_NAME=your-brain-bucket
export MCP_AUTH_TOKEN=your-secret-token   # omit to run in open mode

# Start the server
npm start
```

The server exposes an MCP endpoint at `POST /mcp` on port 8080.

### Deploy to Google Cloud Run

```bash
npm run deploy
```

This runs `gcloud run deploy` with the repo as source. Make sure your Cloud Run service account has Storage Object Admin on the GCS bucket.

### Connect Your AI Agent

Add the MCP server to your agent configuration (Claude Desktop, etc.):

```json
{
  "mcpServers": {
    "mycelial-brain": {
      "url": "https://your-deployment-url/mcp",
      "headers": {
        "Authorization": "Bearer your-secret-token"
      }
    }
  }
}
```

See [CONNECT.md](./CONNECT.md) for detailed setup instructions.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│              MYCELIAL BRAIN STACK                     │
├─────────────────────────────────────────────────────┤
│                                                      │
│  AI Agent ──MCP──▶ Express Server ──▶ GCS Bucket     │
│  (Claude,          (this repo)      (doc-*.json)     │
│   Gemini, etc.)                                       │
│                                                      │
│  Tools: brain_search, brain_read, brain_write,      │
│         brain_list, stim_write                        │
│                                                      │
│  Cache: 5-min in-memory TTL, invalidated on write    │
│  Auth:  Bearer token (optional, open mode if unset)  │
│  Search: Tag-weighted full-text with synonym expand  │
│                                                      │
└─────────────────────────────────────────────────────┘
```

Documents are stored as JSON objects in GCS:

```json
{
  "path": "doc-42",
  "content": "Your document text...",
  "tags": ["research", "stim", "decisions"],
  "updated": "2026-08-22T12:00:00.000Z"
}
```

## Hosted Version

Don't want to self-host? [myceliate.cv](https://myceliate.cv) offers a managed MCP endpoint with:

- One-click Claude Desktop integration via .mcpb bundle
- Operator dashboard with full-text search across your document catalog
- Google OAuth authentication and per-user namespace isolation
- Tiered pricing (free open-source tier through enterprise)
- Onboarding flow with document upload and text paste seeding

The hosted version runs the same MCP protocol as this repo. Your data stays in your own GCS namespace, and you can export or self-host at any time.

## STIM Protocol Context

This repo is one component of the STIM Protocol ecosystem:

| Repo | Role |
|------|------|
| [stim-core](https://github.com/STIM-Protocol/stim-core) | Layer 0 specification: nature-grounded intelligence constraints |
| [white-paper](https://github.com/STIM-Protocol/white-paper) | Versioned, arXiv-ready documentation |
| [stim-guard](https://github.com/STIM-Protocol/stim-guard) | pip-installable constraint engine for AI agents |
| [gpd-framework](https://github.com/STIM-Protocol/gpd-framework) | Physics-based dimensional analysis and thermodynamic convergence |
| [Forest_OS](https://github.com/STIM-Protocol/Forest_OS) | Knowledge organism: living, self-governing file system |
| **mycelial-brain-mcp** | **MCP memory layer (this repo)** |

## License

Apache 2.0. See [LICENSE](./LICENSE).

## Contributing

This is a STIM Protocol reference implementation. Issues and PRs welcome.

---

<em>"The accumulated context across platforms has become a fifth category of professional capital."</em>

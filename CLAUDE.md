# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

openlink is a browser-local proxy that enables web-based AI assistants (Gemini/ChatGPT/DeepSeek etc.) to access the local filesystem through a sandboxed Go server and Chrome extension.

**Architecture**: Two-component system:
1. **Go Server** (`cmd/server/main.go`): HTTP server that executes filesystem operations within a sandboxed directory
2. **Chrome Extension** (`extension/src/content/index.ts`): Content script that intercepts AI tool calls from web pages, proxies them to the local server, and provides input completion UI

## Development Commands

### Running the Server

```bash
# Start server with default settings (current dir, port 39527)
go run cmd/server/main.go

# Start with custom workspace and port
go run cmd/server/main.go -dir=/path/to/workspace -port=39527 -timeout=60
```

### Building

```bash
# Build server binary
go build -o openlink cmd/server/main.go

# Run built binary
./openlink -dir=/your/workspace -port=39527
```

### Building the Extension

```bash
cd extension
npm install
npm run build   # outputs to extension/dist/
```

### Testing the Server

```bash
# Check server health
curl http://127.0.0.1:39527/health

# List available skills
curl http://127.0.0.1:39527/skills -H "Authorization: Bearer <token>"

# List files (with optional query filter)
curl "http://127.0.0.1:39527/files?q=main" -H "Authorization: Bearer <token>"

# Test command execution
curl -X POST http://127.0.0.1:39527/exec \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{"name":"exec_cmd","args":{"command":"ls -la"}}'
```

### Installing the Extension

1. Build first: `cd extension && npm run build`
2. Open Chrome: `chrome://extensions/`
3. Enable "Developer mode"
4. Click "Load unpacked"
5. Select the `extension/dist/` directory

## Code Architecture

### Request Flow

```
Web AI (Gemini/ChatGPT/DeepSeek/etc.)
  ↓ outputs <tool> tags in response
content script (extension/src/content/index.ts)
  ↓ MutationObserver detects tool tags, renders card UI
  ↓ HTTP POST to localhost:39527/exec (via background fetch)
Go Server (internal/server/server.go)
  ↓ validates & sanitizes
Executor (internal/executor/executor.go)
  ↓ executes with sandbox
Security Layer (internal/security/sandbox.go)
  ↓ path validation & command filtering
Local Filesystem
```

### Key Components

**internal/types/types.go**: Core data structures
- `ToolRequest`: Incoming tool call from browser (name, args)
- `ToolResponse`: Execution result (status, output, error, stopStream)
- `Config`: Server configuration (RootDir, Port, Timeout, Token, DefaultPrompt)

**internal/security/sandbox.go**: Security enforcement
- `SafePath()`: Validates all file paths stay within RootDir using absolute path comparison
- `IsDangerousCommand()`: Blocks dangerous commands (rm -rf, sudo, curl, wget, etc.)

**internal/security/auth.go**: Token-based auth middleware for all routes

**internal/executor/executor.go**: Tool execution dispatcher
- All operations run with context timeout (default 60s)
- File operations use `SafePath()` before any filesystem access
- Commands execute via `sh -c` in the configured RootDir

**internal/tool/**: Individual tool implementations
- `edit.go`: String replacement with 11-step normalization cascade for AI-generated content
- Other tools: exec_cmd, list_dir, read_file, write_file, glob, grep, web_fetch, skill, todo_write

**internal/skill/**: Skills loader
- `LoadInfos(rootDir)`: Scans multiple directories for SKILL.md files, returns name+description list

**internal/server/server.go**: HTTP API (Gin framework)
- `GET /health`: Server status and version
- `GET /config`: Current configuration
- `GET /prompt`: Returns init prompt with system info and skills list injected
- `GET /skills`: Lists available skills (name + description)
- `GET /files?q=`: Lists files under RootDir matching query (max 50, skips .git/node_modules/etc.)
- `POST /exec`: Execute tool requests
- `POST /auth`: Validate token
- CORS enabled for all origins (required for browser extension)

**extension/src/content/index.ts**: Main content script
- `getSiteConfig()`: Per-site selectors for editor, send button, fill method
- `startDOMObserver()`: MutationObserver with debounce (800ms) + maxWait (3000ms) for tool detection
- `renderToolCard()`: Renders manual execution UI card above each detected tool call
- `fillAndSend()`: Fills editor and optionally auto-sends with configurable delay
- `attachInputListener()`: Slash command (`/`) and `@` file completion on input events
- `showPickerPopup()`: Keyboard-navigable dropdown for skill/file selection
- `replaceTokenInEditor()`: Cross-platform token replacement (value/execCommand/prosemirror/paste)

**prompts/init_prompt.txt**: Default system prompt injected into AI on initialization
- Contains tool definitions, usage rules, and `{{SYSTEM_INFO}}` placeholder

### Supported AI Platforms

| Platform | fillMethod | useObserver | Notes |
|----------|-----------|-------------|-------|
| Google AI Studio | value | true | Recommended; writes to System Instructions |
| Google Gemini | execCommand | true | |
| ChatGPT | prosemirror | true | |
| 通义千问 (Qwen) | value | true | |
| DeepSeek | paste | false | Uses injected.js |
| Kimi | execCommand | false | |
| Mistral | execCommand | false | |
| Perplexity | execCommand | false | |
| Arena.ai | value | true | |
| OpenRouter | value | false | |
| Grok | value | false | |
| GitHub Copilot | value | false | |
| t3.chat | value | false | |
| z.ai | value | false | |

### Security Model

**Sandbox Isolation**: All file operations restricted to configured RootDir
- Path traversal attacks blocked by absolute path comparison after `filepath.EvalSymlinks`
- Symlinks resolved before validation in both executor and `/files` endpoint

**Command Filtering**: Dangerous commands blocked before execution
- Destructive: `rm -rf`, `mkfs`, `dd`, `format`
- Network: `curl`, `wget`, `nc`, `netcat`
- Privilege: `sudo`, `chmod 777`
- System: `kill -9`, `reboot`, `shutdown`

**Token Auth**: All API endpoints protected by Bearer token (stored in `~/.openlink/token`)

**Timeout Control**: All commands timeout after configured duration (default 60s)

**Manual Confirmation**: Extension renders tool card UI; user clicks "执行" to run each tool call

### Input Completion (extension)

The content script attaches an `input` event listener to the AI platform's editor element:

- Typing `/` triggers skill completion: fetches `GET /skills`, shows picker, inserts `<tool name="skill">` XML on select
- Typing `@` triggers file completion: fetches `GET /files?q=<query>`, shows picker, inserts file path on select
- Picker supports ↑/↓ navigation, Enter to confirm, Escape to dismiss
- Results are cached (skills: 30s, files: 5s) to avoid excessive requests
- Race conditions prevented via `inputVersion` counter

### Skills System

Skills are Markdown files that extend AI capabilities for specific domains. Scanned directories (in priority order):

```
<rootDir>/.skills/
<rootDir>/.openlink/skills/
<rootDir>/.agent/skills/
<rootDir>/.claude/skills/
~/.openlink/skills/
~/.agent/skills/
~/.claude/skills/
```

Each skill is a subdirectory containing `SKILL.md` with frontmatter (`name`, `description`).

## Module Information

- **Module**: `github.com/afumu/openlink`
- **Go Version**: 1.23.0+ (toolchain 1.24.10)
- **Main Dependencies**: Gin web framework, standard library only
- **Extension**: TypeScript, Manifest V3, built with esbuild/webpack

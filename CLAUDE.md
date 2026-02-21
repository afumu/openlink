# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Ground-Link is a browser-local proxy that enables web-based AI assistants (DeepSeek/ChatGPT/Claude) to access the local filesystem through a sandboxed Go server and Chrome extension.

**Architecture**: Two-component system:
1. **Go Server** (`cmd/server/main.go`): HTTP server that executes filesystem operations within a sandboxed directory
2. **Chrome Extension** (`extension/`): Intercepts AI tool calls from web pages and proxies them to the local server

## Development Commands

### Running the Server

```bash
# Start server with default settings (current dir, port 8080)
go run cmd/server/main.go

# Start with custom workspace and port
go run cmd/server/main.go -dir=/path/to/workspace -port=8080 -timeout=60
```

### Building

```bash
# Build server binary
go build -o openlink cmd/server/main.go

# Run built binary
./openlink -dir=/your/workspace -port=8080
```

### Testing the Server

```bash
# Check server health
curl http://127.0.0.1:8080/health

# Get server config
curl http://127.0.0.1:8080/config

# Test command execution
curl -X POST http://127.0.0.1:8080/exec \
  -H "Content-Type: application/json" \
  -d '{"name":"exec_cmd","args":{"command":"ls -la"}}'
```

### Installing the Extension

1. Open Chrome: `chrome://extensions/`
2. Enable "Developer mode"
3. Click "Load unpacked"
4. Select the `extension/` directory

## Code Architecture

### Request Flow

```
Web AI (DeepSeek/ChatGPT/Claude)
  ↓ outputs <tool> tags
injected.js (intercepts DOM mutations)
  ↓ sends message
content.js (Chrome content script)
  ↓ HTTP POST to localhost:8080/exec
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
- `ToolRequest`: Incoming tool call from browser (name, args, reason)
- `ToolResponse`: Execution result (status, output, error)
- `Config`: Server configuration (RootDir, Port, Timeout)

**internal/security/sandbox.go**: Security enforcement
- `SafePath()`: Validates all file paths stay within RootDir using absolute path comparison
- `IsDangerousCommand()`: Blocks dangerous commands (rm -rf, sudo, curl, wget, etc.)

**internal/executor/executor.go**: Command execution
- All operations run with context timeout (default 60s)
- File operations use `SafePath()` before any filesystem access
- Commands execute via `sh -c` in the configured RootDir

**internal/server/server.go**: HTTP API (Gin framework)
- `GET /health`: Server status and version
- `GET /config`: Current configuration
- `POST /exec`: Execute tool requests
- CORS enabled for all origins (required for browser extension)

**extension/**: Browser extension (Manifest V3)
- `injected.js`: Injected into page context, monitors DOM for `<tool>` tags
- `content.js`: Content script, proxies requests to localhost server
- `popup.html/js`: Extension popup UI

### Security Model

**Sandbox Isolation**: All file operations restricted to configured RootDir
- Path traversal attacks blocked by absolute path validation
- Symlinks resolved before validation

**Command Filtering**: Dangerous commands blocked before execution
- Destructive: `rm -rf`, `mkfs`, `dd`, `format`
- Network: `curl`, `wget`, `nc`, `netcat`
- Privilege: `sudo`, `chmod 777`
- System: `kill -9`, `reboot`, `shutdown`

**Timeout Control**: All commands timeout after configured duration (default 60s)

**Manual Confirmation**: Extension shows confirmation dialog before executing any tool call

## Supported Tools

The server accepts tool requests with these names:
- `exec_cmd`: Execute shell command (args: `command` or `cmd`)
- Note: `list_dir`, `read_file`, `write_file` are mentioned in README but not implemented in current executor

## Module Information

- **Module**: `github.com/afumu/ground-link`
- **Go Version**: 1.23.0+ (toolchain 1.24.10)
- **Main Dependencies**: Gin web framework, standard library only

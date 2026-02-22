# cc-elephant

MCP proxy for monorepo environments — connects Claude Code to multiple IDE instances across sub-projects.

## Installation

```bash
npm install -g cc-elephant
# or
bun install -g cc-elephant
```

## Usage

```bash
elephant --dir /path/to/monorepo
# or use the shorter alias
cce --dir /path/to/monorepo

# or cd to your monorepo and run without --dir
cd /path/to/monorepo
elephant
```

### Options

- `--dir <path>` — monorepo root directory (defaults to current working directory)
- `--port <number>` — server port (defaults to random port 20000-30000)
- `--log-dir <path>` — log directory (empty string `""` uses `.elephant` in monorepo root, omit to disable logging)
- `--log-level <level>` — log level: `trace`, `debug`, `info`, `warn`, `error` (default: `info`)
- `--auto-focus` — bring IDE window to foreground when Claude opens a diff (default: `false`)
- `--debug` — enable debug mode (sets log level to `debug`, keeps PowerShell windows open for diagnostics)

### Example

```bash
# From anywhere
elephant --dir ~/my-monorepo --log-dir "" --auto-focus --debug

# Or from within your monorepo
cd ~/my-monorepo
cce --log-dir "" --auto-focus --debug
```

Then in Claude Code:

```bash
/ide
```

Claude Code will connect to the elephant proxy, which routes tool calls to the appropriate IDE based on file paths.

# Command-line threads

Create a thread on the running T3 Code server from any shell on the server machine:

```bash
t3 thread create
```

The current directory is used as the project workspace. If it is not already a T3 Code project,
the command adds it before creating the thread. Pass another workspace path or an existing project
ID to target it explicitly:

```bash
t3 thread create /path/to/project
```

Use `--prompt` to start the first turn immediately. Without it, the command creates an empty thread
that is ready to open in any connected client.

```bash
t3 thread create --prompt "Fix the failing tests"
t3 thread create /path/to/project --title "Investigate CI" --prompt "Find the CI failure"
```

New CLI threads use the project's default model when its provider is enabled. If that selection is
stale or disabled, the command uses the enabled provider selection from the server settings. Threads
start against the project's current checkout with full access. Use `--json` when another script
needs the created thread and project IDs.

The command must find the same T3 home as the running server. If the server was started with a
custom data directory, pass it explicitly:

```bash
t3 thread create --base-dir /path/to/t3-home
```

If `t3` is not installed as a command, use `npx t3@latest` in its place.

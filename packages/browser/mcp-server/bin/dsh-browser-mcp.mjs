#!/usr/bin/env node
// stdio MCP server for MCP clients (Claude Code, Cursor, Codex): proxies to the
// DSH browser bridge's loopback MCP endpoint. See ../README.md.
import { runShim } from '../src/shim.mjs'

const code = await runShim({ stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, env: process.env })
process.exitCode = code

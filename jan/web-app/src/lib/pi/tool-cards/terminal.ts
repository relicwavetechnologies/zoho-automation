/**
 * Reading a shell/terminal tool call for the terminal card.
 *
 * The command tool reaches the desktop in two shapes: the built-in `bash` tool
 * (`input: { command }`, Pi-native output) and the backend `runCommand` family
 * (`{ exitCode, stdout, stderr }`, per `run-command.tool.ts`). This normalizes
 * both to one small view — the command, its streams, and an exit code — so the
 * card can render like a real terminal regardless of which path ran it.
 *
 * Defensive throughout: a missing field just means that part of the terminal is
 * blank, never a thrown error.
 */

import type { ToolIdentity } from '@/lib/pi/tool-label'
import { normalizeToolOutput } from './output'
import { argString, extractInvokeArgs } from './invoke-args'

const TERMINAL_NAMES = /^(bash|shell|sh|run|zsh)$/
const TERMINAL_KEYS = /^(run_?command)$/

/** True when this call is a shell command run, by tool name or dispatched id. */
export function isTerminalTool(identity: ToolIdentity): boolean {
  const norm = (v?: string) => (v ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
  if (TERMINAL_NAMES.test((identity.name ?? '').toLowerCase())) return true
  return TERMINAL_KEYS.test(norm(identity.toolId)) || TERMINAL_KEYS.test(norm(identity.op))
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function parseMaybeJson(value: unknown): Record<string, unknown> | null {
  const rec = asRecord(value)
  if (rec) return rec
  if (typeof value === 'string') {
    try {
      return asRecord(JSON.parse(value))
    } catch {
      return null
    }
  }
  return null
}

/**
 * The command string, from the built-in `{ command }` input or a gateway
 * `payload.args.command` / `payload.args.input.command`. `fallback` (the
 * resolver's already-scraped detail) covers the streaming case where the input
 * is still partial JSON.
 */
export function extractCommand(input: unknown, fallback?: string): string | undefined {
  const direct = parseMaybeJson(input)
  const fromDirect = argString(direct, 'command', 'cmd')
  if (fromDirect) return fromDirect

  const args = extractInvokeArgs(input)
  const fromArgs = argString(args, 'command', 'cmd') ?? argString(asRecord(args?.['input']), 'command', 'cmd')
  return fromArgs ?? fallback
}

export type TerminalOutput = {
  stdout?: string
  stderr?: string
  exitCode?: number
  /** True when the run reported a non-zero exit or an error envelope. */
  failed: boolean
  /** True when no output has arrived yet. */
  empty: boolean
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length ? v : undefined
}

/** Strip the local gateway's "Request succeeded/…" preamble, if present. */
function stripPreamble(text: string): string {
  return text.replace(/^Request (?:succeeded|failed)[^\n]*\n+/i, '')
}

export function parseTerminalOutput(output: unknown): TerminalOutput {
  const norm = normalizeToolOutput(output)
  if (norm.empty) return { failed: false, empty: true }

  // Structured runCommand result — the richest shape.
  const rec = asRecord(norm.value)
  if (rec && ('stdout' in rec || 'stderr' in rec || 'exitCode' in rec)) {
    const exitCode = typeof rec['exitCode'] === 'number' ? (rec['exitCode'] as number) : undefined
    return {
      stdout: str(rec['stdout']),
      stderr: str(rec['stderr']),
      exitCode,
      failed: exitCode !== undefined && exitCode !== 0,
      empty: false,
    }
  }

  // Otherwise the whole body is the combined terminal output.
  const text = norm.text ? stripPreamble(norm.text) : norm.raw
  return { stdout: text || undefined, failed: /^Request failed/i.test(norm.text ?? ''), empty: false }
}

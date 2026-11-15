/**
 * A minimal cordis `Context` for unit specs: a tool registry that records
 * definitions, a guard list, an agent lookup, `get`, `on`, and a logger.
 */
import { vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'

/** A registered tool as the specs read it. */
export interface FakeToolDefinition {
  name: string
  description?: unknown
  execute: (args: unknown, exec: unknown) => Promise<unknown>
  [key: string]: unknown
}

/** Options for {@link fakeContext}. */
export interface FakeContextOptions {
  /** `ctx.get(name)`; defaults to undefined for everything. */
  get?: (name: string) => unknown
  /** `ctx.agents`; defaults to a lookup that finds nothing. */
  agents?: unknown
  /** Extra top-level members (they win over the defaults). */
  extra?: Record<string, unknown>
}

/** Build a fake context. */
export function fakeContext(options: FakeContextOptions = {}) {
  /** Live registry: a disposer removes its own definition. */
  const registered = new Map<string, FakeToolDefinition>()
  /** Every definition ever registered, in order. */
  const definitions: FakeToolDefinition[] = []
  const guards: Array<(execution: never) => unknown> = []
  const register = vi.fn((definition: FakeToolDefinition) => {
    registered.set(definition.name, definition)
    definitions.push(definition)
    return () => { if (registered.get(definition.name) === definition) registered.delete(definition.name) }
  })
  const guard = vi.fn((check: (execution: never) => unknown) => {
    guards.push(check)
    return () => {}
  })
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  const ctx = {
    tools: { register, guard },
    agents: options.agents ?? { get: () => undefined },
    get: options.get ?? (() => undefined),
    on: vi.fn(() => () => {}),
    logger,
    ...options.extra,
  } as unknown as Context
  return { ctx, registered, definitions, register, guards, logger }
}

/** `{ mode }` sandbox policy for `ctx.get('sandboxPolicy')`. */
export function sandboxPolicyOf(mode: string) {
  return { resolve: vi.fn(() => ({ mode })) }
}

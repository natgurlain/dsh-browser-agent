/**
 * Start a subagent on either shape of `ctx.subagents.startActivation`.
 *
 * DSH 0.2.2-rc.2 flattened the activation spec: the task fields (`parent`,
 * `prompt`, `agentPreset`, `outputSchema`, `maxDepth`, ...) sit beside
 * `provider`, `label`, `childId`, `signal` and `delivery`. DSH 0.2.2-rc.1
 * expects them under `request` and fails with a TypeError on the flat spec
 * (it reads `spec.request.maxDepth`) before it has created anything. There is
 * no version or capability to ask, and the host version cannot always be
 * detected (see dsh-support.ts), so the flat spec is tried first and a
 * TypeError retries once with the nested one.
 *
 * @module
 */

/** The envelope fields both shapes keep at the top level. */
interface ActivationEnvelope {
  provider: string
  label: string
  childId?: string
  signal: AbortSignal
  delivery: 'caller' | 'parent'
}

/** Either host's `startActivation`, typed loosely on purpose. */
interface ActivationStarter<Spec, Activation> {
  startActivation(spec: Spec): Promise<Activation>
}

/**
 * Start one activation, flat spec first.
 *
 * @param subagents - the host's subagent service.
 * @param spec - the flat (0.2.2-rc.2 and later) activation spec.
 * @returns the host's activation.
 * @throws the flat attempt's error when the nested retry fails the same way,
 *   so a current host's own TypeError is never replaced by the retry's.
 */
export async function startActivationCompat<Spec extends ActivationEnvelope, Activation>(
  subagents: ActivationStarter<Spec, Activation>,
  spec: Spec,
): Promise<Activation> {
  try {
    return await subagents.startActivation(spec)
  } catch (error: unknown) {
    if (!(error instanceof TypeError)) throw error
    const { provider, label, childId, signal, delivery, ...request } = spec
    const nested = { provider, label, ...(childId === undefined ? {} : { childId }), signal, delivery, request }
    try {
      return await subagents.startActivation(nested as unknown as Spec)
    } catch (retryError: unknown) {
      throw retryError instanceof TypeError ? error : retryError
    }
  }
}

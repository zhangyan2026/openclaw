/**
 * Agent-end side effect runner.
 *
 * Harnesses use this to trigger core research capture and plugin agent_end hooks
 * either fire-and-forget or awaited during tests/shutdown.
 */
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  awaitAgentHarnessAgentEndHook,
  runAgentHarnessAgentEndHook,
} from "./lifecycle-hook-helpers.js";

const log = createSubsystemLogger("agents/harness");

type AgentEndSideEffectsParams = Parameters<typeof runAgentHarnessAgentEndHook>[0];
type CoreAgentEndSideEffectsParams = AgentEndSideEffectsParams & {
  currentTurnMessages?: unknown[];
};

async function runCoreAgentEndSideEffects(params: CoreAgentEndSideEffectsParams): Promise<void> {
  try {
    const { runSkillResearchAutoCapture } = await import("../../skills/research/autocapture.js");
    await runSkillResearchAutoCapture({
      event: params.event,
      // External SDK callers predate current-turn provenance; preserve their prior event-based
      // behavior while built-in runtimes pass the exact current turn.
      currentTurnMessages: params.currentTurnMessages ?? params.event.messages,
      ctx: params.ctx,
      ...(params.ctx.config ? { config: params.ctx.config } : {}),
    });
  } catch (error) {
    // Side effects are observational; failures must not change the completed run result.
    log.warn(`skill research auto-capture failed: ${String(error)}`);
  }
}

/** Starts agent-end side effects without waiting for completion. */
export function runAgentEndSideEffects(params: CoreAgentEndSideEffectsParams): void {
  void runCoreAgentEndSideEffects(params);
  runAgentHarnessAgentEndHook({
    event: params.event,
    ctx: params.ctx,
    hookRunner: params.hookRunner,
  });
}

/** Runs agent-end side effects and waits for plugin/core completion. */
export async function awaitAgentEndSideEffects(
  params: CoreAgentEndSideEffectsParams,
): Promise<void> {
  await runCoreAgentEndSideEffects(params);
  await awaitAgentHarnessAgentEndHook({
    event: params.event,
    ctx: params.ctx,
    hookRunner: params.hookRunner,
  });
}

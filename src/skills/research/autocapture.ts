// Research autocapture helpers decide when skill research signals should be captured.
import { resolveStorePath } from "../../config/sessions/paths.js";
import { recordSessionSkillSuggestion } from "../../config/sessions/skill-suggestions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { sha256Hex } from "../../infra/crypto-digest.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { normalizeSkillIndexName } from "../discovery/skill-index.js";
import { readWorkspaceSkillFile } from "../lifecycle/workspace-skill-write.js";
import { resolveSkillWorkshopConfig } from "../workshop/config.js";
import {
  listSkillProposalRecords,
  listWritableWorkspaceSkillSummaries,
  proposeCreateSkill,
  proposeUpdateSkill,
  reviseSkillProposal,
} from "../workshop/service.js";
import { resolveSkillProposalTarget } from "../workshop/store.js";
import type { SkillProposalRecord } from "../workshop/types.js";
import {
  extractDurableInstructions,
  groupDurableInstructionProposals,
  mergeDurableInstructionProposal,
  type DurableInstructionProposal,
} from "./signals.js";

type SkillResearchAgentEndEvent = {
  messages: unknown[];
  success?: boolean;
};

type SkillResearchAgentContext = {
  agentId?: string;
  runId?: string;
  sessionKey?: string;
  trigger?: string;
  workspaceDir?: string;
};

const log = createSubsystemLogger("skills/research");
const AUTO_CAPTURE_PROPOSAL_SOURCE = "skill-autocapture";
const AUTO_CAPTURE_BLOCKED_TRIGGERS = new Set(["cron", "heartbeat", "memory", "overflow"]);
const AUTO_CAPTURE_BLOCKED_SESSION_SEGMENTS = new Set(["cron", "hook", "subagent"]);

// Captured updates append below existing skill text so learned context stays auditable.
function buildAutoCaptureUpdateContent(existingSkill: string, capturedContent: string): string {
  return [existingSkill.trimEnd(), "", "## Captured Update", "", capturedContent.trim(), ""].join(
    "\n",
  );
}

function isSkillResearchAutoCaptureEligible(ctx: SkillResearchAgentContext): boolean {
  const trigger = ctx.trigger?.trim().toLowerCase();
  if (trigger && AUTO_CAPTURE_BLOCKED_TRIGGERS.has(trigger)) {
    return false;
  }

  const sessionKey = ctx.sessionKey?.trim().toLowerCase();
  if (!sessionKey) {
    return true;
  }
  if (sessionKey.includes("active-memory")) {
    return false;
  }
  return !sessionKey
    .split(":")
    .some((segment) => AUTO_CAPTURE_BLOCKED_SESSION_SEGMENTS.has(segment));
}

function readProposalInstructions(proposal: SkillProposalRecord): string[] {
  return (proposal.evidence ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

async function reviseAutoCaptureProposal(params: {
  workspaceDir: string;
  config?: OpenClawConfig;
  pending: SkillProposalRecord;
  proposal: DurableInstructionProposal;
}): Promise<void> {
  const previousInstructions = readProposalInstructions(params.pending);
  const merged = mergeDurableInstructionProposal(params.proposal, previousInstructions);
  if (merged.instructions.length === previousInstructions.length) {
    return;
  }
  const content =
    params.pending.kind === "update"
      ? buildAutoCaptureUpdateContent(
          (await readWorkspaceSkillFile(params.pending.target.skillFile)) ?? "",
          merged.content,
        )
      : merged.content;
  const result = await reviseSkillProposal({
    workspaceDir: params.workspaceDir,
    config: params.config,
    proposalId: params.pending.id,
    content,
    goal: merged.goal,
    evidence: merged.evidence,
  });
  log.info(`skill research auto-capture revised workshop proposal ${result.record.id}`);
}

async function queueSkillSuggestion(params: {
  workspaceDir: string;
  config?: OpenClawConfig;
  ctx: SkillResearchAgentContext;
  instructions: readonly string[];
  records: readonly SkillProposalRecord[];
}): Promise<void> {
  const proposal = groupDurableInstructionProposals({
    instructions: params.instructions,
    maxProposals: 1,
  }).at(-1);
  if (!proposal) {
    return;
  }
  if (
    params.records.some(
      (record) =>
        (record.status === "pending" || record.status === "quarantined") &&
        normalizeSkillIndexName(record.target.skillKey) === proposal.skillName,
    )
  ) {
    return;
  }
  const sessionKey = params.ctx.sessionKey?.trim();
  if (!sessionKey) {
    return;
  }
  try {
    const target = resolveSkillProposalTarget({
      workspaceDir: params.workspaceDir,
      skillName: proposal.skillName,
    });
    if ((await readWorkspaceSkillFile(target.skillFile)) !== null) {
      return;
    }
    const recorded = await recordSessionSkillSuggestion({
      agentId: params.ctx.agentId,
      sessionKey,
      storePath: resolveStorePath(params.config?.session?.store, {
        agentId: params.ctx.agentId,
      }),
      skillName: target.skillKey,
      signalHash: sha256Hex(proposal.evidence),
    });
    if (recorded) {
      log.info(`skill research queued suggestion ${target.skillKey}`);
    }
  } catch (error) {
    log.warn(`skill research suggestion skipped: ${String(error)}`);
  }
}

/**
 * Captures or suggests durable skill research signals from the current turn.
 *
 * Suggestions remain success-only. Autonomous capture also runs after failed turns because the
 * extracted signal is the user's own correction, not failed assistant output.
 */
export async function runSkillResearchAutoCapture(params: {
  event: SkillResearchAgentEndEvent;
  currentTurnMessages: unknown[];
  ctx: SkillResearchAgentContext;
  config?: OpenClawConfig;
}): Promise<void> {
  const workshopConfig = resolveSkillWorkshopConfig(params.config);
  const autonomous = workshopConfig.autonomous.enabled;
  if (!autonomous && params.event.success === false) {
    return;
  }
  const workspaceDir = params.ctx.workspaceDir;
  if (!workspaceDir) {
    return;
  }
  if (!isSkillResearchAutoCaptureEligible(params.ctx)) {
    return;
  }

  const instructions = extractDurableInstructions({ messages: params.currentTurnMessages });
  if (instructions.length === 0) {
    return;
  }

  const records = await listSkillProposalRecords({ workspaceDir });
  const runId = params.ctx.runId?.trim();
  if (runId && records.some((record) => record.origin?.runId === runId)) {
    return;
  }

  if (!autonomous) {
    await queueSkillSuggestion({
      workspaceDir,
      config: params.config,
      ctx: params.ctx,
      instructions,
      records,
    });
    return;
  }

  // Discovery is intentionally after the cheap current-turn signal check.
  const existingSkills = listWritableWorkspaceSkillSummaries(workspaceDir, {
    config: params.config,
    agentId: params.ctx.agentId,
  });
  const proposals = groupDurableInstructionProposals({ instructions, existingSkills });
  const pendingAutoCaptureBySkill = new Map<string, SkillProposalRecord[]>();
  for (const entry of records) {
    if (entry.status !== "pending" || entry.createdBy !== AUTO_CAPTURE_PROPOSAL_SOURCE) {
      continue;
    }
    const skillName = normalizeSkillIndexName(entry.target.skillKey);
    const matches = pendingAutoCaptureBySkill.get(skillName) ?? [];
    matches.push(entry);
    pendingAutoCaptureBySkill.set(skillName, matches);
  }

  for (const proposal of proposals) {
    const pendingMatches = pendingAutoCaptureBySkill.get(proposal.skillName) ?? [];
    if (pendingMatches.length > 1) {
      log.warn(`skill research auto-capture skipped duplicate target ${proposal.skillName}`);
      continue;
    }

    try {
      const pending = pendingMatches[0];
      if (pending) {
        await reviseAutoCaptureProposal({
          workspaceDir,
          config: params.config,
          pending,
          proposal,
        });
        continue;
      }
      // A routed proposal matches a writable skill summary; its filePath is the live SKILL.md.
      // Inferred-topic proposals fall back to the flat layout the workshop uses for creates.
      const matchedSkills = existingSkills.filter(
        (entry) => normalizeSkillIndexName(entry.name) === proposal.skillName,
      );
      if (matchedSkills.length > 1) {
        log.warn(`skill research auto-capture skipped ambiguous target ${proposal.skillName}`);
        continue;
      }
      const matched = matchedSkills[0];
      const skillFile =
        matched?.filePath ??
        resolveSkillProposalTarget({ workspaceDir, skillName: proposal.skillName }).skillFile;
      const existingSkill = await readWorkspaceSkillFile(skillFile);
      const origin = {
        ...(params.ctx.agentId ? { agentId: params.ctx.agentId } : {}),
        ...(params.ctx.sessionKey ? { sessionKey: params.ctx.sessionKey } : {}),
        ...(runId ? { runId } : {}),
      };
      const result =
        existingSkill === null
          ? await proposeCreateSkill({
              workspaceDir,
              config: params.config,
              name: proposal.skillName,
              description: proposal.description,
              content: proposal.content,
              createdBy: AUTO_CAPTURE_PROPOSAL_SOURCE,
              origin,
              goal: proposal.goal,
              evidence: proposal.evidence,
            })
          : await proposeUpdateSkill({
              workspaceDir,
              config: params.config,
              agentId: params.ctx.agentId,
              skillName: matched?.name ?? proposal.skillName,
              content: buildAutoCaptureUpdateContent(existingSkill, proposal.content),
              createdBy: AUTO_CAPTURE_PROPOSAL_SOURCE,
              origin,
              goal: proposal.goal,
              evidence: proposal.evidence,
            });
      log.info(
        `skill research auto-capture queued workshop proposal ${result.record.target.skillKey}`,
      );
    } catch (error) {
      log.warn(`skill research auto-capture skipped ${proposal.skillName}: ${String(error)}`);
    }
  }
}

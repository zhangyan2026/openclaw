// Research autocapture tests cover capture policy, persistence, and config gating.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadSessionEntry, upsertSessionEntry } from "../../config/sessions/session-accessor.js";
import { consumeSessionSkillSuggestion } from "../../config/sessions/skill-suggestions.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";
import {
  applySkillProposal,
  inspectSkillProposal,
  listSkillProposals,
  proposeCreateSkill,
  rejectSkillProposal,
} from "../workshop/service.js";
import * as workshopService from "../workshop/service.js";
import { runSkillResearchAutoCapture } from "./autocapture.js";

const tempDirs = createTrackedTempDirs();
let testState: OpenClawTestState;
const SESSION_KEY = "agent:main:main";
let runSequence = 0;

beforeEach(async () => {
  runSequence = 0;
  testState = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-skill-workshop-state-",
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await testState.cleanup();
  await tempDirs.cleanup();
});

async function makeWorkspace(): Promise<string> {
  return await tempDirs.make("openclaw-skill-workshop-");
}

async function seedSession(sessionKey = SESSION_KEY): Promise<void> {
  await upsertSessionEntry(
    { agentId: "main", sessionKey },
    { sessionId: `session-${sessionKey}`, updatedAt: 1 },
  );
}

function readSession(sessionKey = SESSION_KEY) {
  return loadSessionEntry({ agentId: "main", sessionKey, readConsistency: "latest" });
}

type AutoCaptureParams = Parameters<typeof runSkillResearchAutoCapture>[0];

async function runAutoCapture(
  params: Omit<AutoCaptureParams, "currentTurnMessages"> & {
    currentTurnMessages?: unknown[];
  },
): Promise<void> {
  await runSkillResearchAutoCapture({
    ...params,
    currentTurnMessages: params.currentTurnMessages ?? params.event.messages,
    ctx: {
      ...params.ctx,
      runId: params.ctx.runId ?? `run-${++runSequence}`,
    },
  });
}

describe("skill research auto-capture", () => {
  it("deduplicates pending proposals for the same durable correction", async () => {
    const workspaceDir = await makeWorkspace();
    await seedSession();

    const captureParams = {
      event: {
        success: true,
        messages: [
          {
            role: "user",
            content:
              "From now on, when working on GitHub PRs, always check CI before final response.",
          },
        ],
      },
      ctx: { workspaceDir, agentId: "main", sessionKey: SESSION_KEY },
      config: {
        skills: {
          workshop: {
            autonomous: {
              enabled: true,
            },
          },
        },
      },
    };
    await runAutoCapture(captureParams);
    await runAutoCapture(captureParams);

    const proposals = await listSkillProposals({ workspaceDir });
    expect(proposals.proposals).toHaveLength(1);
    expect(proposals.proposals[0]).toMatchObject({
      kind: "create",
      status: "pending",
      skillKey: "github-pr-workflow",
      scanState: "clean",
    });
    const proposal = await inspectSkillProposal(proposals.proposals[0].id, { workspaceDir });
    expect(proposal?.content).toContain("status: proposal");
    expect(proposal?.content).toContain("always check CI before final response");
    expect(readSession()?.pendingSkillSuggestion).toBeUndefined();
  });

  it("records and one-shot consumes a suggestion with default config", async () => {
    const workspaceDir = await makeWorkspace();
    await seedSession();

    await runAutoCapture({
      event: {
        success: true,
        messages: [
          {
            role: "user",
            content: "Remember to always verify generated screenshots before replying.",
          },
        ],
      },
      ctx: { workspaceDir, agentId: "main", sessionKey: SESSION_KEY },
    });

    expect((await listSkillProposals({ workspaceDir })).proposals).toHaveLength(0);
    expect(readSession()?.pendingSkillSuggestion).toMatchObject({
      skillName: "screenshot-asset-workflow",
    });

    const first = await consumeSessionSkillSuggestion({
      agentId: "main",
      sessionKey: SESSION_KEY,
    });
    expect(first?.suggestion).toMatchObject({ skillName: "screenshot-asset-workflow" });
    expect(readSession()?.pendingSkillSuggestion).toBeUndefined();

    const second = await consumeSessionSkillSuggestion({
      agentId: "main",
      sessionKey: SESSION_KEY,
    });
    expect(second?.suggestion).toBeUndefined();

    await runAutoCapture({
      event: {
        success: true,
        messages: [
          {
            role: "user",
            content: "Remember to always verify generated screenshots before replying.",
          },
        ],
      },
      ctx: { workspaceDir, agentId: "main", sessionKey: SESSION_KEY },
    });
    expect(readSession()?.pendingSkillSuggestion).toBeUndefined();
  });

  it("does not record a suggestion when no durable signal is present", async () => {
    const workspaceDir = await makeWorkspace();
    await seedSession();

    await runAutoCapture({
      event: {
        success: true,
        messages: [{ role: "user", content: "Please review this pull request." }],
      },
      ctx: { workspaceDir, agentId: "main", sessionKey: SESSION_KEY },
    });

    expect(readSession()?.pendingSkillSuggestion).toBeUndefined();
  });

  it("does not record a suggestion after a failed turn", async () => {
    const workspaceDir = await makeWorkspace();
    await seedSession();

    await runAutoCapture({
      event: {
        success: false,
        messages: [
          {
            role: "user",
            content: "Remember to always verify generated screenshots before replying.",
          },
        ],
      },
      ctx: { workspaceDir, agentId: "main", sessionKey: SESSION_KEY },
    });

    expect(readSession()?.pendingSkillSuggestion).toBeUndefined();
  });

  it("does not record a suggestion while a matching proposal is pending", async () => {
    const workspaceDir = await makeWorkspace();
    await seedSession();
    const event = {
      success: true,
      messages: [
        {
          role: "user",
          content:
            "From now on, when working on GitHub PRs, always check CI before final response.",
        },
      ],
    };

    await runAutoCapture({
      event,
      ctx: { workspaceDir, agentId: "main", sessionKey: SESSION_KEY },
      config: { skills: { workshop: { autonomous: { enabled: true } } } },
    });
    await runAutoCapture({
      event,
      ctx: { workspaceDir, agentId: "main", sessionKey: SESSION_KEY },
    });

    expect((await listSkillProposals({ workspaceDir })).proposals).toHaveLength(1);
    expect(readSession()?.pendingSkillSuggestion).toBeUndefined();
  });

  it.each([
    {
      name: "subagent helper session",
      ctx: { sessionKey: "agent:main:subagent:worker" },
    },
    {
      name: "cron automation session",
      ctx: { trigger: "cron", sessionKey: "agent:main:cron:daily:run:run-1" },
    },
    {
      name: "heartbeat automation session",
      ctx: { trigger: "heartbeat", sessionKey: "agent:main:main" },
    },
    {
      name: "hook-scoped session",
      ctx: { sessionKey: "hook:gmail:message-1" },
    },
    {
      name: "Active Memory trigger",
      ctx: { trigger: "memory", sessionKey: "explicit:user-session:active-memory:abc123" },
    },
    {
      name: "Active Memory helper session with main suffix",
      ctx: { trigger: "manual", sessionKey: "agent:main:main:active-memory:abc123" },
    },
    {
      name: "Active Memory helper session without main suffix",
      ctx: { trigger: "manual", sessionKey: "agent:main:active-memory:abc123" },
    },
    {
      name: "Active Memory recall helper session",
      ctx: { trigger: "manual", sessionKey: "active-memory-recall-87504" },
    },
  ])("skips $name before queuing proposals", async ({ ctx }) => {
    const workspaceDir = await makeWorkspace();
    const sessionKey = ctx.sessionKey ?? SESSION_KEY;
    await seedSession(sessionKey);

    await runAutoCapture({
      event: {
        success: true,
        messages: [
          {
            role: "user",
            content:
              "From now on, when working on GitHub PRs, always check CI before final response.",
          },
        ],
      },
      ctx: { workspaceDir, agentId: "main", ...ctx },
    });

    expect((await listSkillProposals({ workspaceDir })).proposals).toHaveLength(0);
    expect(readSession(sessionKey)?.pendingSkillSuggestion).toBeUndefined();
  });

  it("preserves existing skill content when auto-capturing an update", async () => {
    const workspaceDir = await makeWorkspace();
    await seedSession();
    const skillFile = path.join(workspaceDir, "skills", "github-pr-workflow", "SKILL.md");
    await fs.mkdir(path.dirname(skillFile), { recursive: true });
    await fs.writeFile(
      skillFile,
      [
        "---",
        'name: "github-pr-workflow"',
        'description: "Existing GitHub PR workflow."',
        "---",
        "",
        "# GitHub PR Workflow",
        "",
        "- Preserve this original review checklist.",
        "",
      ].join("\n"),
      "utf8",
    );

    await runAutoCapture({
      event: {
        success: true,
        messages: [
          {
            role: "user",
            content:
              "From now on, when working on GitHub PRs, always check CI before final response.",
          },
        ],
      },
      ctx: { workspaceDir, agentId: "main", sessionKey: SESSION_KEY },
      config: {
        skills: {
          workshop: {
            autonomous: {
              enabled: true,
            },
          },
        },
      },
    });

    const proposals = await listSkillProposals({ workspaceDir });
    expect(proposals.proposals).toHaveLength(1);
    expect(proposals.proposals[0]).toMatchObject({
      kind: "update",
      status: "pending",
      skillKey: "github-pr-workflow",
    });

    await applySkillProposal({ workspaceDir, proposalId: proposals.proposals[0].id });
    const updatedSkill = await fs.readFile(skillFile, "utf8");
    expect(updatedSkill).toContain('description: "Existing GitHub PR workflow."');
    expect(updatedSkill).not.toContain("Reusable workflow notes");
    expect(updatedSkill).toContain("Preserve this original review checklist.");
    expect(updatedSkill).toContain("always check CI before final response");

    await runAutoCapture({
      event: {
        success: true,
        messages: [
          {
            role: "user",
            content:
              "From now on, when working on GitHub PRs, always check CI before final response.",
          },
        ],
      },
      ctx: { workspaceDir, agentId: "main", sessionKey: SESSION_KEY },
    });
    expect(readSession()?.pendingSkillSuggestion).toBeUndefined();
  });

  it("queues a proposal from a reactive correction, not just prospective phrasing", async () => {
    const workspaceDir = await makeWorkspace();

    await runAutoCapture({
      event: {
        success: true,
        messages: [
          {
            role: "user",
            content:
              "You're still using the transcripts as tone references — they should not be included as voice material at all.",
          },
        ],
      },
      ctx: { workspaceDir, agentId: "main" },
      config: {
        skills: {
          workshop: {
            autonomous: {
              enabled: true,
            },
          },
        },
      },
    });

    const proposals = await listSkillProposals({ workspaceDir });
    expect(proposals.proposals).toHaveLength(1);
    expect(proposals.proposals[0]).toMatchObject({
      kind: "create",
      status: "pending",
      skillKey: "learned-workflows",
    });
    const proposal = await inspectSkillProposal(proposals.proposals[0].id, { workspaceDir });
    expect(proposal?.content).toContain("should not be included as voice material");
  });

  it("routes a correction to the existing workspace skill it is about", async () => {
    const workspaceDir = await makeWorkspace();
    const skillFile = path.join(workspaceDir, "skills", "signal-scout", "SKILL.md");
    await fs.mkdir(path.dirname(skillFile), { recursive: true });
    await fs.writeFile(
      skillFile,
      [
        "---",
        'name: "signal-scout"',
        'description: "Mine the market for signals and validate them before drafting."',
        "---",
        "",
        "# Signal Scout",
        "",
        "- Capture first, score later.",
        "",
      ].join("\n"),
      "utf8",
    );

    await runAutoCapture({
      event: {
        success: true,
        messages: [
          {
            role: "user",
            content:
              "I thought we were working on listening — capture real market signals with quoted evidence before scoring anything.",
          },
        ],
      },
      ctx: { workspaceDir, agentId: "main" },
      config: {
        skills: {
          workshop: {
            autonomous: {
              enabled: true,
            },
          },
        },
      },
    });

    const proposals = await listSkillProposals({ workspaceDir });
    expect(proposals.proposals).toHaveLength(1);
    expect(proposals.proposals[0]).toMatchObject({
      kind: "update",
      status: "pending",
      skillKey: "signal-scout",
    });

    await applySkillProposal({ workspaceDir, proposalId: proposals.proposals[0].id });
    const updatedSkill = await fs.readFile(skillFile, "utf8");
    expect(updatedSkill).toContain("Capture first, score later.");
    expect(updatedSkill).toContain("capture real market signals with quoted evidence");
  });

  it("routes a correction to a writable project agent skill under .agents/skills", async () => {
    const workspaceDir = await makeWorkspace();
    const skillFile = path.join(workspaceDir, ".agents", "skills", "signal-scout", "SKILL.md");
    await fs.mkdir(path.dirname(skillFile), { recursive: true });
    await fs.writeFile(
      skillFile,
      [
        "---",
        'name: "Signal Scout"',
        'description: "Mine the market for signals and validate them before drafting."',
        "---",
        "",
        "# Signal Scout",
        "",
        "- Capture first, score later.",
        "",
      ].join("\n"),
      "utf8",
    );

    await runAutoCapture({
      event: {
        success: true,
        messages: [
          {
            role: "user",
            content:
              "I thought we were working on listening — capture real market signals with quoted evidence before scoring anything.",
          },
        ],
      },
      ctx: { workspaceDir, agentId: "main" },
      config: {
        skills: {
          workshop: {
            autonomous: {
              enabled: true,
            },
          },
        },
      },
    });

    const proposals = await listSkillProposals({ workspaceDir });
    expect(proposals.proposals).toHaveLength(1);
    expect(proposals.proposals[0]).toMatchObject({
      kind: "update",
      status: "pending",
      skillKey: "Signal Scout",
    });

    await applySkillProposal({ workspaceDir, proposalId: proposals.proposals[0].id });
    const updatedSkill = await fs.readFile(skillFile, "utf8");
    expect(updatedSkill).toContain("Capture first, score later.");
    expect(updatedSkill).toContain("capture real market signals with quoted evidence");
  });

  it("captures corrections from failed runs", async () => {
    const workspaceDir = await makeWorkspace();

    await runAutoCapture({
      event: {
        success: false,
        messages: [
          {
            role: "user",
            content:
              "From now on, when working on GitHub PRs, always check CI before final response.",
          },
        ],
      },
      ctx: { workspaceDir, agentId: "main" },
      config: {
        skills: {
          workshop: {
            autonomous: {
              enabled: true,
            },
          },
        },
      },
    });

    const proposals = await listSkillProposals({ workspaceDir });
    expect(proposals.proposals).toHaveLength(1);
    expect(proposals.proposals[0]).toMatchObject({
      kind: "create",
      status: "pending",
      skillKey: "github-pr-workflow",
    });
  });

  it("preserves autonomous capture for callers without a run id", async () => {
    const workspaceDir = await makeWorkspace();
    const event = {
      success: true,
      messages: [
        {
          role: "user",
          content:
            "From now on, when working on GitHub PRs, always check CI before final response.",
        },
      ],
    };

    await runSkillResearchAutoCapture({
      event,
      currentTurnMessages: event.messages,
      ctx: { workspaceDir, agentId: "main" },
      config: {
        skills: {
          workshop: {
            autonomous: {
              enabled: true,
            },
          },
        },
      },
    });

    expect((await listSkillProposals({ workspaceDir })).proposals).toHaveLength(1);
  });

  it("queues one proposal per distinct topic when a session has several corrections", async () => {
    const workspaceDir = await makeWorkspace();

    await runAutoCapture({
      event: {
        success: true,
        messages: [
          {
            role: "user",
            content:
              "From now on, when working on GitHub PRs, always check CI before final response.",
          },
          {
            role: "user",
            content: "Remember to always optimize screenshot assets before attaching them.",
          },
        ],
      },
      ctx: { workspaceDir, agentId: "main" },
      config: {
        skills: {
          workshop: {
            autonomous: {
              enabled: true,
            },
          },
        },
      },
    });

    const proposals = await listSkillProposals({ workspaceDir });
    const skillKeys = proposals.proposals.map((entry) => entry.skillKey).toSorted();
    expect(skillKeys).toEqual(["github-pr-workflow", "screenshot-asset-workflow"]);
  });

  it("revises its pending proposal when a later turn adds another correction", async () => {
    const workspaceDir = await makeWorkspace();
    const config = {
      skills: { workshop: { autonomous: { enabled: true } } },
    };

    await runAutoCapture({
      event: {
        success: true,
        messages: [
          {
            role: "user",
            content:
              "From now on, when working on GitHub PRs, always check CI before final response.",
          },
        ],
      },
      ctx: { workspaceDir, agentId: "main" },
      config,
    });
    await runAutoCapture({
      event: {
        success: true,
        messages: [
          {
            role: "user",
            content: "Next time on a GitHub PR, make sure to link the issue in the description.",
          },
        ],
      },
      ctx: { workspaceDir, agentId: "main" },
      config,
    });

    const proposals = await listSkillProposals({ workspaceDir });
    expect(proposals.proposals).toHaveLength(1);
    const proposal = await inspectSkillProposal(proposals.proposals[0].id, { workspaceDir });
    expect(proposal?.record).toMatchObject({
      createdBy: "skill-autocapture",
      proposedVersion: "v2",
    });
    expect(proposal?.content).toContain("always check CI");
    expect(proposal?.content).toContain("link the issue");
  });

  it("does not revise a manually created pending proposal", async () => {
    const workspaceDir = await makeWorkspace();
    const manual = await proposeCreateSkill({
      workspaceDir,
      name: "github-pr-workflow",
      description: "Manual GitHub workflow proposal.",
      content: "# Manual proposal\n\n- Keep this draft separate.\n",
      createdBy: "skill-workshop",
    });

    await runAutoCapture({
      event: {
        success: true,
        messages: [
          {
            role: "user",
            content:
              "From now on, when working on GitHub PRs, always check CI before final response.",
          },
        ],
      },
      ctx: { workspaceDir, agentId: "main" },
      config: {
        skills: { workshop: { autonomous: { enabled: true } } },
      },
    });

    const proposals = await listSkillProposals({ workspaceDir });
    expect(proposals.proposals).toHaveLength(2);
    const unchanged = await inspectSkillProposal(manual.record.id, { workspaceDir });
    expect(unchanged?.record.proposedVersion).toBe("v1");
    expect(unchanged?.content).toContain("Keep this draft separate");
  });

  it("suppresses capture when the same run already created a workshop proposal", async () => {
    const workspaceDir = await makeWorkspace();
    const runId = "learn-run";
    await proposeCreateSkill({
      workspaceDir,
      name: "curated-learn-proposal",
      description: "Curated /learn result.",
      content: "# Curated proposal\n",
      createdBy: "skill-workshop",
      origin: { runId },
    });

    await runAutoCapture({
      event: {
        success: true,
        messages: [
          {
            role: "user",
            content:
              "Stop using transcripts as tone references; only use them as factual evidence.",
          },
        ],
      },
      ctx: { workspaceDir, agentId: "main", runId },
      config: {
        skills: { workshop: { autonomous: { enabled: true } } },
      },
    });

    expect((await listSkillProposals({ workspaceDir })).proposals).toHaveLength(1);
  });

  it("suppresses a suggestion when the same run already created a workshop proposal", async () => {
    const workspaceDir = await makeWorkspace();
    const runId = "learn-suggestion-run";
    await seedSession();
    await proposeCreateSkill({
      workspaceDir,
      name: "curated-learn-proposal",
      description: "Curated /learn result.",
      content: "# Curated proposal\n",
      createdBy: "skill-workshop",
      origin: { runId },
    });

    await runAutoCapture({
      event: {
        success: true,
        messages: [
          {
            role: "user",
            content:
              "Stop using transcripts as tone references; only use them as factual evidence.",
          },
        ],
      },
      ctx: {
        workspaceDir,
        agentId: "main",
        sessionKey: SESSION_KEY,
        runId,
      },
    });

    expect((await listSkillProposals({ workspaceDir })).proposals).toHaveLength(1);
    expect(readSession()?.pendingSkillSuggestion).toBeUndefined();
  });

  it.each(["applied", "rejected"] as const)(
    "does not replay historical corrections after a proposal is %s",
    async (status) => {
      const workspaceDir = await makeWorkspace();
      const correction =
        "From now on, when working on GitHub PRs, always check CI before final response.";
      const config = {
        skills: { workshop: { autonomous: { enabled: true } } },
      };

      await runAutoCapture({
        event: { success: true, messages: [{ role: "user", content: correction }] },
        ctx: { workspaceDir, agentId: "main" },
        config,
      });
      const first = (await listSkillProposals({ workspaceDir })).proposals[0];
      if (status === "applied") {
        await applySkillProposal({ workspaceDir, proposalId: first.id });
      } else {
        await rejectSkillProposal({ workspaceDir, proposalId: first.id });
      }

      const currentTurn = {
        role: "user",
        content: "What is the current status of the implementation?",
      };
      await runAutoCapture({
        event: {
          success: true,
          messages: [{ role: "user", content: correction }, currentTurn],
        },
        currentTurnMessages: [currentTurn],
        ctx: { workspaceDir, agentId: "main" },
        config,
      });

      const proposals = await listSkillProposals({ workspaceDir });
      expect(proposals.proposals).toHaveLength(1);
      expect(proposals.proposals[0].status).toBe(status);
    },
  );

  it("captures only new current-turn corrections from a failed run", async () => {
    const workspaceDir = await makeWorkspace();
    const historical = {
      role: "user",
      content: "Remember to always optimize screenshot assets before attaching them.",
    };
    const current = {
      role: "user",
      content: "Next time on a GitHub PR, make sure to link the issue in the description.",
    };

    await runAutoCapture({
      event: { success: false, messages: [historical, current] },
      currentTurnMessages: [current],
      ctx: { workspaceDir, agentId: "main" },
      config: {
        skills: { workshop: { autonomous: { enabled: true } } },
      },
    });

    const proposals = await listSkillProposals({ workspaceDir });
    expect(proposals.proposals).toHaveLength(1);
    expect(proposals.proposals[0].skillKey).toBe("github-pr-workflow");
    const proposal = await inspectSkillProposal(proposals.proposals[0].id, { workspaceDir });
    expect(proposal?.content).toContain("link the issue");
    expect(proposal?.content).not.toContain("screenshot assets");
  });

  it("does not discover workspace skills on a signal-free turn", async () => {
    const workspaceDir = await makeWorkspace();
    const discovery = vi.spyOn(workshopService, "listWritableWorkspaceSkillSummaries");

    await runAutoCapture({
      event: {
        success: true,
        messages: [{ role: "user", content: "What is the current status?" }],
      },
      ctx: { workspaceDir, agentId: "main" },
      config: {
        skills: { workshop: { autonomous: { enabled: true } } },
      },
    });

    expect(discovery).not.toHaveBeenCalled();
  });
});

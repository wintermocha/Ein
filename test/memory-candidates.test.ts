import { expect, test } from "bun:test";
import { prepareCandidates } from "../src/memory-candidates";
import type { SourceItem } from "../src/memory-sources";

const turn: SourceItem = { tool: "codex", kind: "conversation", folder: "/repo", suggestedScope: "project", source: "session.jsonl#9", body: "" };

test("separate durable user statements keep conditions, rationale, location and explicit scope", () => {
  const preference = "모든 프로젝트에서 앞으로는 문서를 한국어로 써 줘.";
  const decision = "Our team chose SQLite. Because deployments must also work offline.";
  const fix = "When CI starts with a stale lockfile, we verified that reinstalling dependencies fixes the build.";
  const result = prepareCandidates([
    { ...turn, body: [preference, decision, fix, "I prefer JSON this time.", "오늘만 창을 열어 줘."].join("\n") },
    { ...turn, body: fix }, { ...turn, body: fix, folder: "/other" },
  ]);
  expect(result.map(({body, folder, source, suggestedScope}) => [body, folder, source, suggestedScope])).toEqual([
    [preference, "/repo", turn.source, "global"], [decision, "/repo", turn.source, "group"],
    [fix, "/repo", turn.source, "project"], [fix, "/other", turn.source, "project"],
  ]);
});

test("skip machine wrappers, code snippets, speculation and credentials even in curated inputs", () => {
  const items = [
    "Maybe we should always use JSON.", "Should I always use JSON?", "<environment_context>\nAlways use JSON.",
    "# AGENTS.md instructions for /repo\nAlways use JSON.", "```text\nAlways use JSON.\n```",
    "The tests passed.", "For now, always include snapshots.", "assistant: I prefer JSON.",
  ].map(body => ({ ...turn, body }));
  const curated = { ...turn, kind: "memory", body: "Deployment checklist" } as const;
  expect(prepareCandidates([...items, { ...curated, body: "api_key=fixture-only" }, curated])).toEqual([curated]);
});

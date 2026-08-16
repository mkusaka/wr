import { describe, expect, test } from "bun:test";
import type { FocusTarget } from "../src/api.ts";
import { filterFocusTargets } from "../src/ui.tsx";

const targets: FocusTarget[] = [
  {
    id: "run-1",
    session: "codex:thread-1",
    itermSessionId: "pane-1",
    taskIds: "MOQ-123",
    repoRoots: ["/src/mall-cloud"],
    branches: "feature/patient-route",
    pullRequests: "medley-inc/mall-cloud#42",
    prUrls: "https://github.com/medley-inc/mall-cloud/pull/42",
    startedCwd: "/src/mall-cloud",
  },
];

describe("focus target filter", () => {
  test.each(["MOQ-123", "mall-cloud", "patient-route", "#42", "thread-1", "github.com"])(
    "filters targets by %s",
    (query) => {
      expect(filterFocusTargets(targets, query)).toEqual(targets);
    },
  );

  test("requires every query term to match", () => {
    expect(filterFocusTargets(targets, "MOQ-123 #42")).toEqual(targets);
    expect(filterFocusTargets(targets, "MOQ-123 missing")).toEqual([]);
  });
});

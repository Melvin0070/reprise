import { describe, expect, it } from "vitest";

import {
  canTransition,
  isTerminal,
  NON_TERMINAL_STATES,
  TERMINAL_STATES,
} from "./state.js";
import type { SubmissionState } from "./state.js";

const ALL_STATES: readonly SubmissionState[] = [
  ...NON_TERMINAL_STATES,
  ...TERMINAL_STATES,
];

describe("the state vocabulary", () => {
  it("keeps terminal and non-terminal states disjoint", () => {
    const overlap = (TERMINAL_STATES as readonly string[]).filter((state) =>
      (NON_TERMINAL_STATES as readonly string[]).includes(state)
    );

    expect(overlap).toEqual([]);
  });

  it.each(ALL_STATES)("does not let %s transition to itself", (state) => {
    // Re-entering `running` would double-execute a submission; re-entering any
    // other state would mean a lifecycle that never makes progress.
    expect(canTransition(state, state)).toBe(false);
  });
});

/**
 * One case per terminal state — T7's verify line. The substantive claim about a
 * terminal state is that it is a dead end: once a run has an answer, nothing may
 * overwrite it.
 */
describe.each(TERMINAL_STATES)("terminal state %s", (state) => {
  it("reports as terminal", () => {
    expect(isTerminal(state)).toBe(true);
  });

  it("is reachable from running", () => {
    expect(canTransition("running", state)).toBe(true);
  });

  it("admits no outgoing transition", () => {
    const escapes = ALL_STATES.filter((to) => canTransition(state, to));

    expect(escapes).toEqual([]);
  });
});

describe.each(NON_TERMINAL_STATES)("non-terminal state %s", (state) => {
  it("does not report as terminal", () => {
    expect(isTerminal(state)).toBe(false);
  });
});

describe("queued", () => {
  it("reaches running when a worker picks the submission up", () => {
    expect(canTransition("queued", "running")).toBe(true);
  });

  it("can fail infra without ever running", () => {
    // A job nothing ever picks up still needs an honest terminal answer.
    expect(canTransition("queued", "failed-infra")).toBe(true);
  });

  it("cannot reach a run result without running first", () => {
    // `succeeded` asserts something about executed code. Reaching it from
    // `queued` would mean claiming an exit code no process ever produced.
    expect(canTransition("queued", "succeeded")).toBe(false);
    expect(canTransition("queued", "failed")).toBe(false);
    expect(canTransition("queued", "timeout")).toBe(false);
    expect(canTransition("queued", "killed-limit")).toBe(false);
  });
});

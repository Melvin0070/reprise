import { describe, expect, it } from "vitest";

import type { JailOutcome } from "../sandbox/outcome.js";
import { outcomeToState } from "./outcome-to-state.js";

describe("outcomeToState — one case per terminal state", () => {
  it("maps a clean exit to succeeded", () => {
    expect(outcomeToState({ exitCode: 0, kind: "exited" })).toBe("succeeded");
  });

  it("maps a non-zero exit to failed", () => {
    // The program ran and said no. That is a result, not a containment event.
    expect(outcomeToState({ exitCode: 1, kind: "exited" })).toBe("failed");
  });

  it("maps a wall-clock kill to timeout", () => {
    expect(outcomeToState({ kind: "timeout" })).toBe("timeout");
  });

  it("maps a CPU-limit kill to killed-limit", () => {
    expect(outcomeToState({ kind: "signalled", signal: "SIGXCPU" })).toBe(
      "killed-limit"
    );
  });

  it("maps a SIGKILL to killed-limit", () => {
    // Either our group kill or the OOM killer — both are a ceiling we imposed.
    expect(outcomeToState({ kind: "signalled", signal: "SIGKILL" })).toBe(
      "killed-limit"
    );
  });

  it("maps a run we could not reap to failed-infra", () => {
    // Not `killed-limit`: that would claim we stopped the run at a ceiling we
    // set, and the meaning of this outcome is that we could not stop it.
    expect(
      outcomeToState({ detail: "1 process(es) still owned", kind: "unreaped" })
    ).toBe("failed-infra");
  });

  it("maps an unrecognised signal to failed-infra rather than guessing", () => {
    // `failed` claims the user's program was wrong and `killed-limit` claims we
    // stopped it. With an unknown signal neither claim is supported, and
    // failed-infra is the state that renders "not verified".
    expect(outcomeToState({ kind: "signalled", signal: "SIGUSR1" })).toBe(
      "failed-infra"
    );
  });
});

describe("outcomeToState — crash signals are the program's fault, not ours", () => {
  const crashes = ["SIGSEGV", "SIGABRT", "SIGBUS", "SIGFPE", "SIGILL"];

  it.each(crashes)("maps %s to failed", (signal) => {
    // Rendering these as killed-limit would blame the sandbox for a program
    // that crashed on its own, and cost the run its evaluated verdict.
    expect(outcomeToState({ kind: "signalled", signal })).toBe("failed");
  });
});

describe("outcomeToState — states it must never invent", () => {
  const outcomes: readonly JailOutcome[] = [
    { exitCode: 0, kind: "exited" },
    { exitCode: 7, kind: "exited" },
    { kind: "timeout" },
    { kind: "signalled", signal: "SIGKILL" },
    { kind: "signalled", signal: "SIGSEGV" },
    { kind: "signalled", signal: "SIGUSR1" },
  ];

  it.each(outcomes)("never reports canceled for %o", (outcome) => {
    // `canceled` means a person asked us to stop (2A). No jail outcome can
    // establish that, so the mapping must not be able to produce it.
    expect(outcomeToState(outcome)).not.toBe("canceled");
  });
});

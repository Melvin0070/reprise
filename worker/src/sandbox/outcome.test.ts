import { describe, expect, it } from "vitest";

import { classifyOutcome } from "./outcome.js";

describe("classifyOutcome", () => {
  it("reports a normal exit with its code", () => {
    expect(classifyOutcome({ code: 0, signal: null, timedOut: false })).toEqual(
      { exitCode: 0, kind: "exited" }
    );
  });

  it("reports a non-zero exit as exited, not as a failure of the jail", () => {
    // A program that crashes on its own is a successful run of a failing
    // program. Containment did not fire, and the distinction matters to the
    // submission state machine (T7).
    expect(classifyOutcome({ code: 1, signal: null, timedOut: false })).toEqual(
      { exitCode: 1, kind: "exited" }
    );
  });

  it("reports the wall-clock kill as a timeout even though it arrives as SIGKILL", () => {
    // We sent that SIGKILL, so the signal is an implementation detail of our
    // own timeout. Reporting it as `signalled` would lose the reason.
    expect(
      classifyOutcome({ code: null, signal: "SIGKILL", timedOut: true })
    ).toEqual({ kind: "timeout" });
  });

  it("reports a kernel-sent signal as signalled", () => {
    // RLIMIT_CPU exhaustion arrives as SIGXCPU from the kernel, not from us.
    expect(
      classifyOutcome({ code: null, signal: "SIGXCPU", timedOut: false })
    ).toEqual({ kind: "signalled", signal: "SIGXCPU" });
  });

  it("throws when the kernel reports neither an exit code nor a signal", () => {
    // Node guarantees one of the two. If that ever breaks, fail loudly rather
    // than invent an outcome the state machine would then act on.
    expect(() =>
      classifyOutcome({ code: null, signal: null, timedOut: false })
    ).toThrow(/neither an exit code nor a signal/u);
  });
});

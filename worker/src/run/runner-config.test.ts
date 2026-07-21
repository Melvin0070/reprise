import { describe, expect, it } from "vitest";

import { loadRunnerIdentity } from "./runner-config.js";

describe("loadRunnerIdentity", () => {
  it("reads the runner uid and gid from the environment", () => {
    expect(
      loadRunnerIdentity({ REPRISE_RUN_GID: "1001", REPRISE_RUN_UID: "1001" })
    ).toEqual({ gid: 1001, uid: 1001 });
  });

  it("refuses root, so a misconfiguration cannot silently remove the boundary", () => {
    // The jail refuses root too. This one exists so the refusal happens at
    // startup with a legible message, rather than on the first submission.
    expect(() =>
      loadRunnerIdentity({ REPRISE_RUN_GID: "1001", REPRISE_RUN_UID: "0" })
    ).toThrow(/root/u);

    expect(() =>
      loadRunnerIdentity({ REPRISE_RUN_GID: "0", REPRISE_RUN_UID: "1001" })
    ).toThrow(/root/u);
  });

  it("refuses a missing setting rather than defaulting to one", () => {
    // A default uid would be wrong on any host that does not happen to have
    // that account, and wrong quietly.
    expect(() => loadRunnerIdentity({ REPRISE_RUN_GID: "1001" })).toThrow(
      /REPRISE_RUN_UID/u
    );
    expect(() => loadRunnerIdentity({ REPRISE_RUN_UID: "1001" })).toThrow(
      /REPRISE_RUN_GID/u
    );
  });

  it("refuses a value that is not a positive integer", () => {
    for (const uid of ["", "nobody", "-1", "1001.5", "1e3"]) {
      expect(() =>
        loadRunnerIdentity({ REPRISE_RUN_GID: "1001", REPRISE_RUN_UID: uid })
      ).toThrow(/REPRISE_RUN_UID/u);
    }
  });
});

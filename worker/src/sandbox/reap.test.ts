import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseProcStatus, processesForUid, reapUid } from "./reap.js";

/**
 * The reap reads `/proc`, which the macOS dev host does not have — so the tests
 * hand it a fixture tree instead. That is the whole reason `procRoot` and
 * `kill` are parameters: the pass loop is the part most likely to be wrong, and
 * it should not take a hostile process to exercise it.
 */

const RUN_UID = 1001;

const status = (uid: number, state = "S") =>
  [
    "Name:\tsleep",
    `State:\t${state} (sleeping)`,
    `Uid:\t${uid}\t${uid}\t${uid}\t${uid}`,
    "",
  ].join("\n");

let procRoot: string;

const addProcess = async (pid: number, uid: number, state = "S") => {
  await mkdir(path.join(procRoot, String(pid)), { recursive: true });
  await writeFile(
    path.join(procRoot, String(pid), "status"),
    status(uid, state)
  );
};

beforeEach(async () => {
  procRoot = await mkdtemp(path.join(tmpdir(), "reprise-proc-"));
});

afterEach(async () => {
  await rm(procRoot, { force: true, recursive: true });
});

describe("parseProcStatus", () => {
  it("reads the real uid and the run state", () => {
    expect(parseProcStatus(status(1001))).toEqual({
      realUid: 1001,
      state: "S",
    });
  });

  it("returns null for a body missing either field, rather than guessing", () => {
    // A truncated read must not be silently classified as "not ours", so the
    // caller sees null and treats it as unknown.
    expect(parseProcStatus("Name:\tsleep\n")).toBeNull();
  });
});

describe("processesForUid", () => {
  it("finds the processes whose real uid matches", async () => {
    await addProcess(1234, RUN_UID);
    await addProcess(1235, RUN_UID);
    await addProcess(1236, 1002);

    expect(await processesForUid(RUN_UID, procRoot)).toEqual([1234, 1235]);
  });

  it("ignores zombies, which hold no descriptors and cannot be killed again", async () => {
    // Counting a zombie as a survivor would stop the reap converging: the
    // signal does nothing, so the census would never empty.
    await addProcess(1234, RUN_UID, "Z");

    expect(await processesForUid(RUN_UID, procRoot)).toEqual([]);
  });

  it("ignores the non-numeric entries /proc carries alongside pids", async () => {
    await mkdir(path.join(procRoot, "self"), { recursive: true });
    await writeFile(path.join(procRoot, "self", "status"), status(RUN_UID));
    await addProcess(1234, RUN_UID);

    expect(await processesForUid(RUN_UID, procRoot)).toEqual([1234]);
  });

  it("never lists the worker's own pid", async () => {
    await addProcess(process.pid, RUN_UID);

    expect(await processesForUid(RUN_UID, procRoot)).toEqual([]);
  });
});

describe("processesForUid — a census it cannot take is not an empty census", () => {
  it("propagates a read failure that is not the process having exited", async () => {
    // ENOENT means the pid vanished between the readdir and the read, which is
    // benign. EACCES from a `hidepid=` mount, or EMFILE, means we do not know
    // who owns that process — and reading that as "not ours" would repeat the
    // exact mistake #78 was about: taking the error that proves the census
    // failed as proof that it succeeded.
    await addProcess(1234, RUN_UID);
    // A directory where a file is expected: the read fails with EISDIR.
    await mkdir(path.join(procRoot, "1235", "status"), { recursive: true });

    await expect(processesForUid(RUN_UID, procRoot)).rejects.toThrow();
  });

  it("ignores a pid that exits between the listing and the read", async () => {
    await addProcess(1234, RUN_UID);
    // Present in the listing, no status file — exactly what a race looks like.
    await mkdir(path.join(procRoot, "1235"), { recursive: true });

    expect(await processesForUid(RUN_UID, procRoot)).toEqual([1234]);
  });
});

describe("reapUid", () => {
  it("signals every process the uid owns and reports none left", async () => {
    await addProcess(1234, RUN_UID);
    await addProcess(1235, RUN_UID);
    const killed: number[] = [];

    const survivors = await reapUid(RUN_UID, {
      kill: (pid) => {
        killed.push(pid);
        // A killed process leaves /proc, which is what the next census sees.
        void rm(path.join(procRoot, String(pid)), {
          force: true,
          recursive: true,
        });
      },
      procRoot,
    });

    expect(killed).toEqual([1234, 1235]);
    expect(survivors).toEqual([]);
  });

  it("leaves another uid's processes alone", async () => {
    await addProcess(1236, 1002);
    const killed: number[] = [];

    await reapUid(RUN_UID, { kill: (pid) => killed.push(pid), procRoot });

    expect(killed).toEqual([]);
  });

  it("gives up after bounded passes and reports the survivors", async () => {
    // A process that will not die — D-state, or a kill we are not allowed to
    // send. Looping forever here would reproduce the hang this whole change
    // exists to remove, so the reap stops and hands the fact back.
    await addProcess(1234, RUN_UID);

    const survivors = await reapUid(RUN_UID, {
      kill: () => {
        /* refuses to die */
      },
      procRoot,
    });

    expect(survivors).toEqual([1234]);
  });
});

import { spawn } from "node:child_process";
import type { Readable } from "node:stream";

import { buildJailArgv } from "./argv.js";
import type { JailLimits } from "./limits.js";
import { classifyOutcome } from "./outcome.js";
import type { JailOutcome } from "./outcome.js";

/**
 * `prlimit` applies the rlimits and execs the runner in place — see
 * `buildJailArgv` for why a shell is deliberately not involved.
 */
const PRLIMIT = "/usr/bin/prlimit";

/**
 * How long the runner's children may keep the output pipes open after the
 * leader itself has exited. A fork bomb's children outlive their parent and
 * would otherwise hold the pipes — and this call — open indefinitely.
 */
const PIPE_DRAIN_GRACE_MS = 200;

/**
 * Accumulate a stream up to a byte ceiling, discarding the remainder. Counting
 * bytes rather than string length keeps the cap honest for multi-byte output.
 */
const capture = (stream: Readable | null, maxBytes: number) => {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let overflowed = false;

  stream?.on("data", (chunk: Buffer) => {
    const room = maxBytes - bytes;
    if (room <= 0) {
      overflowed = true;
      return;
    }
    if (chunk.length > room) {
      chunks.push(chunk.subarray(0, room));
      bytes = maxBytes;
      overflowed = true;
      return;
    }
    chunks.push(chunk);
    bytes += chunk.length;
  });

  return {
    text: () => Buffer.concat(chunks).toString("utf-8"),
    truncated: () => overflowed,
  };
};

export interface JailSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly limits: JailLimits;
  /** Required, not optional: a caller cannot forget to drop privileges. */
  readonly uid: number;
  readonly gid: number;
}

const assertUnprivileged = (spec: JailSpec): void => {
  if (spec.uid === 0 || spec.gid === 0) {
    throw new Error(
      "jail: refusing to run as root; the crude tier's only filesystem boundary is the unprivileged uid"
    );
  }
};

export interface JailResult {
  readonly outcome: JailOutcome;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  /** True when output hit `maxOutputBytes` and the rest was discarded. */
  readonly truncated: boolean;
}

/**
 * Run one program under the crude jail: unprivileged uid, rlimits, wall-clock
 * timeout, and a group-wide SIGKILL.
 *
 * This is the I/O edge. The decisions it makes — the limit argv, the outcome
 * taxonomy — live in pure modules beside it so they are testable without
 * spawning anything.
 *
 * Contains threat-model attacks #1 (fork bomb), #2 (OOM) and #3 (infinite
 * loop). It does NOT contain #5 (network exfil) or #6 (container escape), and
 * only reduces #4 (filesystem escape) — which is why execution stays behind the
 * OV-1 key while this is the active tier.
 */
export const runInJail = async (spec: JailSpec): Promise<JailResult> => {
  assertUnprivileged(spec);

  // Validates the limits and throws before anything is spawned.
  const argv = buildJailArgv(spec.limits, spec.command, spec.args);
  const startedAt = performance.now();

  // A child process reports completion through events, not a promise, so the
  // constructor is the only way to bridge it. There is no library promise here
  // to return instead.
  // oxlint-disable-next-line promise/avoid-new
  return await new Promise<JailResult>((resolve, reject) => {
    const child = spawn(PRLIMIT, argv, {
      cwd: spec.cwd,
      // New process group, so one kill reaches every child the runner spawned.
      // Without this a fork bomb's children would survive the timeout.
      detached: true,
      // Empty, not inherited. The host environment can hold credentials, and
      // none of it is any of the runner's business.
      env: {},
      gid: spec.gid,
      // stdin is closed rather than inherited: the runner reads EOF instead of
      // blocking on a terminal that will never produce input.
      stdio: ["ignore", "pipe", "pipe"],
      uid: spec.uid,
    });

    const stdout = capture(child.stdout, spec.limits.maxOutputBytes);
    const stderr = capture(child.stderr, spec.limits.maxOutputBytes);

    let timedOut = false;
    let exit: { code: number | null; signal: string | null } | null = null;
    let graceTimer: NodeJS.Timeout | undefined;

    const killGroup = () => {
      if (child.pid === undefined) {
        return;
      }
      try {
        // Negative pid targets the whole process group. SIGKILL rather than
        // SIGTERM because hostile code can install a handler for SIGTERM.
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // ESRCH — the group is already gone, which is the outcome we wanted.
      }
    };

    const wallClock = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, spec.limits.wallClockMs);

    child.on("error", (error) => {
      clearTimeout(wallClock);
      clearTimeout(graceTimer);
      reject(error);
    });

    child.on("exit", (code, signal) => {
      exit = { code, signal };
      // The leader is gone; anything still holding the pipes is an orphan.
      graceTimer = setTimeout(killGroup, PIPE_DRAIN_GRACE_MS);
    });

    // `close` rather than `exit`: it fires once the pipes are drained, so no
    // output written just before death is lost.
    child.on("close", () => {
      clearTimeout(wallClock);
      clearTimeout(graceTimer);

      resolve({
        durationMs: Math.round(performance.now() - startedAt),
        outcome: classifyOutcome({
          code: exit?.code ?? null,
          signal: exit?.signal ?? null,
          timedOut,
        }),
        stderr: stderr.text(),
        stdout: stdout.text(),
        truncated: stdout.truncated() || stderr.truncated(),
      });
    });
  });
};

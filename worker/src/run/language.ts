/**
 * What Reprise can run, and how.
 *
 * v1.0 is stdlib-only (OV-2), so a runtime here is an interpreter path and the
 * flags it needs — there is no dependency install step to describe. The list is
 * deliberately short: every entry is an interpreter that has to exist in the
 * sandbox image, so adding one is an infrastructure change, not a config edit.
 */

export const LANGUAGES = ["python"] as const;

export type Language = (typeof LANGUAGES)[number];

export interface LanguageRuntime {
  /**
   * Absolute path, never a bare name. The jail spawns with an empty
   * environment, so there is no PATH to search — and searching an
   * attacker-influenced PATH is not something we would want to do anyway.
   */
  readonly command: string;
  /** The file the submitted code is written to inside the run workspace. */
  readonly entryFile: string;
  /** Interpreter flags, placed before the entry file in the argv. */
  readonly flags: readonly string[];
}

const RUNTIMES: Readonly<Record<Language, LanguageRuntime>> = {
  python: {
    command: "/usr/bin/python3",
    entryFile: "main.py",
    // -u is a correctness flag, not a tuning one. Python block-buffers stdout
    // when it is not a tty, and the SIGKILL that ends a timed-out run discards
    // whatever is still in that buffer. Without it, a program that prints and
    // then hangs reports `timeout` with empty stdout — output the user watched
    // their program produce, lost on the way back.
    flags: ["-u"],
  },
};

/**
 * Membership in the supported list, not presence of a key.
 *
 * The argument comes off the wire, so a plain lookup would answer yes to
 * `constructor` and `__proto__` and then hand back something that is not a
 * runtime at all.
 */
export const isLanguage = (value: string): value is Language =>
  (LANGUAGES as readonly string[]).includes(value);

export const runtimeFor = (language: Language): LanguageRuntime =>
  RUNTIMES[language];

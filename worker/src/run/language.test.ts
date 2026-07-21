import { describe, expect, it } from "vitest";

import { isLanguage, LANGUAGES, runtimeFor } from "./language.js";

describe("the language registry", () => {
  it("recognises the languages it lists", () => {
    for (const language of LANGUAGES) {
      expect(isLanguage(language)).toBe(true);
    }
  });

  it("rejects a language it does not support", () => {
    expect(isLanguage("brainfuck")).toBe(false);
  });

  it("rejects a prototype key posing as a language", () => {
    // The registry is looked up by a caller-supplied string, so the guard has
    // to be membership in the list rather than "is this key present".
    expect(isLanguage("constructor")).toBe(false);
    expect(isLanguage("__proto__")).toBe(false);
  });
});

describe("python", () => {
  it("runs an entry file rather than an inline -c string", () => {
    const runtime = runtimeFor("python");

    // Code goes through a file, so it survives quotes, newlines and any size a
    // command line could not carry.
    expect(runtime.entryFile).toBe("main.py");
    expect(runtime.flags).not.toContain("-c");
  });

  it("runs unbuffered", () => {
    // Without -u, Python block-buffers stdout when it is not a tty, and a
    // SIGKILL at the wall clock discards the buffer — losing output the
    // program had already printed. See the Linux suite for the proof.
    expect(runtimeFor("python").flags).toContain("-u");
  });

  it("names an absolute interpreter path", () => {
    // No PATH lookup: the jail spawns with an empty environment, and an
    // attacker-controlled PATH is not a search we want to perform anyway.
    expect(runtimeFor("python").command.startsWith("/")).toBe(true);
  });
});

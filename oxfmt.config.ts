import { defineConfig } from "oxfmt";
import ultracite from "ultracite/oxfmt";

export default defineConfig({
  ...ultracite,
  ignorePatterns: [
    ...ultracite.ignorePatterns,
    // The formatter governs code, not prose. flagship-design-plan.md is the
    // approved spec and reviews/ is its audit trail; rewriting either would
    // edit the record and shift the line numbers the issues cite.
    "**/*.md",
    "reviews/**",
  ],
});

import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";

export default defineConfig({
  extends: [core],
  ignorePatterns: core.ignorePatterns,
  overrides: [
    {
      // Two core rules describe a plain-TypeScript codebase accurately and a
      // Nest one wrongly. They are relaxed for `api/` alone, so the rest of the
      // workspace keeps enforcing them.
      files: ["api/**/*.ts"],
      rules: {
        // A filter, guard or interceptor implements a Nest interface whose
        // methods receive everything they need as arguments. The rule's advice
        // — make it static — would stop it satisfying the interface at all.
        "eslint/class-methods-use-this": "off",
        // `@Module` classes are intentionally empty: the decorator's metadata
        // IS the declaration. The rule already anticipates this case; this
        // turns on its own escape hatch rather than disabling it.
        "typescript/no-extraneous-class": [
          "error",
          { allowWithDecorator: true },
        ],
      },
    },
  ],
});

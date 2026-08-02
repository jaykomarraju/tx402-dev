import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/coverage/**",
      "**/.venv/**",
      "packages/tx402-python/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    // Type-aware linting applies to the TypeScript sources only. Repo tooling and config
    // files are plain Node ESM and are not members of any tsconfig project.
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // SEC-003: nothing in library code may write to the console. Diagnostics go through
      // the injected Tx402Logger; the CLI renders from the structured event stream.
      "no-console": "error",
      "@typescript-eslint/explicit-module-boundary-types": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // The CLI is the one place allowed to write to stdout/stderr (SPEC §11).
    files: ["packages/tx402/src/cli/**/*.ts"],
    rules: { "no-console": "off" },
  },
  {
    files: ["**/*.test.ts", "tools/**/*.js"],
    rules: {
      "no-console": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/explicit-module-boundary-types": "off",
    },
  },
  {
    // Repo tooling runs on Node directly and is not part of the TypeScript project.
    files: ["**/*.js"],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
        URL: "readonly",
        __dirname: "readonly",
      },
    },
  },
);

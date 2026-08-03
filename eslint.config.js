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
      // Hand-written declarations for the JS tools. They belong to no tsconfig project, so
      // the type-aware linter cannot parse them; `tsc` still checks them at every import.
      "tools/**/*.d.ts",
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
        // `ignoreRestSiblings` is what allows the omit-a-key idiom, which is how the
        // manifest's signing input is built: `const { signature: _s, ...unsigned } = doc`.
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
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
        Buffer: "readonly",
        TextEncoder: "readonly",
        TextDecoder: "readonly",
        fetch: "readonly",
        __dirname: "readonly",
      },
    },
    rules: {
      // Spread first: an explicit `rules` key replaces the one from the spread above, and
      // dropping `disableTypeChecked` would re-enable type-aware rules on files that have
      // no TypeScript program behind them.
      ...tseslint.configs.disableTypeChecked.rules,
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
    },
  },
);

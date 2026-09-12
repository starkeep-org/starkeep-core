import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";
import reactHooks from "eslint-plugin-react-hooks";

export default [
  {
    files: ["packages/*/src/**/*.ts", "apps/*/src/**/*.ts", "apps/*/*.ts"],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        projectService: true,
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
    },
    rules: {
      ...tseslint.configs["recommended"].rules,
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
  {
    /**
     * admin-web's browser half must never import the modules that spawn
     * processes and read the filesystem.
     *
     * The line was held by a `server-only` import, which is a marker package
     * the framework's bundler resolves and refuses in a client graph. There is
     * no such package in this tree — it is not in admin-web's dependencies and
     * `vitest.config.ts` has to alias it to a stub — so a bundler that does not
     * know the convention enforces nothing. This rule catches the edit that
     * introduces the import; `__tests__/server-module-isolation.test.ts` walks
     * the whole graph in CI and catches one that arrives indirectly.
     */
    files: [
      "apps/admin-web/src/components/**/*.{ts,tsx}",
      "apps/admin-web/src/hooks/**/*.{ts,tsx}",
      "apps/admin-web/app/**/page.tsx",
      "apps/admin-web/app/**/layout.tsx",
    ],
    languageOptions: {
      parser: tsparser,
      parserOptions: { projectService: true },
    },
    plugins: {
      // Registered because the components carry `eslint-disable-line
      // react-hooks/exhaustive-deps` directives written against the framework's
      // own lint setup. Without the plugin those directives name a rule eslint
      // does not know, which is itself an error.
      "react-hooks": reactHooks,
    },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "**/lib/app-scan",
                "**/lib/daemon-control",
                "**/lib/exec-commands",
                "@/lib/app-scan",
                "@/lib/daemon-control",
                "@/lib/exec-commands",
              ],
              message:
                "This module reaches node:child_process or node:fs and must stay server-side. " +
                "Call the API route that owns it instead; importing it here puts Node built-ins " +
                "in the browser bundle.",
            },
            {
              group: ["node:child_process", "node:fs", "node:fs/promises"],
              message:
                "Node built-ins do not exist in the browser. The work belongs in a route handler.",
            },
          ],
        },
      ],
    },
  },
  {
    ignores: ["**/dist/**", "**/node_modules/**", "**/*.config.*"],
  },
];

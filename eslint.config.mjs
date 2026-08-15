/*
 * The same rule set the Obsidian community directory runs during automated
 * review. Keep `npm run lint` clean and the "Source code" section of the scan
 * has nothing to report.
 */

import obsidianmd from 'eslint-plugin-obsidianmd';

export default [
  {
    ignores: ['main.js', 'node_modules/**', 'tests/**', 'scripts/**', 'esbuild.config.mjs'],
  },
  ...obsidianmd.configs.recommended,
];

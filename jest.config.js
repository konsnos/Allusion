module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  // Resolve the non-relative imports (`src/...`, `common/...`) that webpack resolves through aliases.
  modulePaths: ['<rootDir>'],
  // Claude Code worktrees (.claude/worktrees/*) hold copies of the repository, tests included.
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/.claude/'],
  modulePathIgnorePatterns: ['<rootDir>/.claude/'],
  transform: {
    // Default imports of CommonJS modules (`import fse from 'fs-extra'`), as webpack allows them.
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: { esModuleInterop: true } }],
  },
  setupFiles: [
    // FIXME: I did not manage to get Dexie working in an actual Electron test environment. Testing in JavaScript is
    // cursed, so indexeddb is replaced by an in-memory implementation.
    'fake-indexeddb/auto',
    // Crypto module is not stable in the node version we use, nor can we use the browser.
    '<rootDir>/tests/setup/jest.crypto.js',
  ],
};

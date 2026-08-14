import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Tests never reach the network. The fixture adapters are the only outbound
    // implementations wired into the test container, which is what makes the whole
    // pipeline developable with zero credentials.
    globals: false,
  },
});

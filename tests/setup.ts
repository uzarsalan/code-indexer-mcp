// Global test setup
beforeEach(() => {
  jest.clearAllMocks();
});

// Suppress console.log in tests unless there's an error
const originalConsoleLog = console.log;
const originalConsoleError = console.error;

console.log = jest.fn();
console.error = jest.fn();
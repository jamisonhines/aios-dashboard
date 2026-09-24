const timeoutMs = Number(process.env.AIOS_TEST_FILE_TIMEOUT_MS) || 90_000;
const timer = setTimeout(() => {
  console.error(`TEST FILE TIMEOUT: ${process.argv[1]} exceeded ${timeoutMs}ms`);
  process.exit(1);
}, timeoutMs);
timer.unref?.();

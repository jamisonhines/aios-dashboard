// Tests for the Dispatch-launch command builder: buildLaunchCommand (pure).
// Mirror of the function under test (kept in sync with main.ts). Run: node launchModel.test.mjs
import assert from "node:assert";

function shellQuoteSingle(value) {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

function escapeAppleScriptString(value) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function buildInnerShellCommand(claudeBinary, vaultPath, prompt) {
  const parts = ["cd", shellQuoteSingle(vaultPath), "&&", shellQuoteSingle(claudeBinary)];
  if (prompt != null) parts.push(shellQuoteSingle(prompt));
  return parts.join(" ");
}

function buildLaunchCommand(mode, claudeBinary, vaultPath, prompt, customCommand) {
  if (mode === "custom") {
    const vaultArg = shellQuoteSingle(vaultPath);
    const promptArg = prompt != null ? shellQuoteSingle(prompt) : "";
    const substituted = customCommand
      .split("{vault}")
      .join(vaultArg)
      .split("{prompt}")
      .join(promptArg);
    return ["/bin/sh", "-c", substituted];
  }

  const inner = buildInnerShellCommand(claudeBinary, vaultPath, prompt);
  const escaped = escapeAppleScriptString(inner);

  if (mode === "iterm") {
    const script =
      `tell application "iTerm2"\n` +
      `activate\n` +
      `create window with default profile\n` +
      `tell current session of current window\n` +
      `write text "${escaped}"\n` +
      `end tell\n` +
      `end tell`;
    return ["osascript", "-e", script];
  }

  const script =
    `tell application "Terminal"\n` +
    `activate\n` +
    `do script "${escaped}"\n` +
    `end tell`;
  return ["osascript", "-e", script];
}

// --- terminal mode, null prompt: plain interactive session, no trailing arg ---
{
  const argv = buildLaunchCommand("terminal", "claude", "/Users/jaymo/AIOS", null, "");
  assert.equal(argv[0], "osascript", "terminal mode drives osascript");
  assert.equal(argv[1], "-e", "second argv element is the -e flag");
  const script = argv[2];
  assert.ok(script.includes('tell application "Terminal"'), "targets Terminal.app");
  const expectedInner = buildInnerShellCommand("claude", "/Users/jaymo/AIOS", null);
  assert.equal(expectedInner, "cd '/Users/jaymo/AIOS' && 'claude'", "no trailing prompt argument when prompt is null");
  assert.ok(script.includes(escapeAppleScriptString(expectedInner)), "cds into vault then runs claude with no prompt arg");
}

// --- terminal mode, prompt with single quotes: shell-quote then AppleScript-quote ---
{
  const prompt = "it's a test";
  const argv = buildLaunchCommand("terminal", "claude", "/vault", prompt, "");
  const script = argv[2];
  const inner = buildInnerShellCommand("claude", "/vault", prompt);
  const escaped = escapeAppleScriptString(inner);
  // The shell-level quoting must have actually happened (embedded '\'' present pre-escape).
  assert.ok(inner.includes("'it'\\''s a test'"), "shell-quoting escapes the embedded single quote");
  // The AppleScript-level escaping must double every backslash produced by shell-quoting,
  // so the do-script line stays a single valid AppleScript string literal.
  assert.ok(script.includes(`do script "${escaped}"`), "full do script line embeds the AppleScript-escaped inner command");
  assert.notEqual(escaped, inner, "AppleScript escaping changes the string (backslashes get doubled)");
}

// --- terminal mode, prompt with double quotes: AppleScript-escapes them ---
{
  const prompt = 'say "hello" now';
  const argv = buildLaunchCommand("terminal", "claude", "/vault", prompt, "");
  const script = argv[2];
  const inner = buildInnerShellCommand("claude", "/vault", prompt);
  const escaped = escapeAppleScriptString(inner);
  assert.ok(inner.includes('"hello"'), "prompt keeps its raw double quotes before AppleScript escaping");
  assert.ok(escaped.includes('\\"hello\\"'), "double quotes are backslash-escaped for the AppleScript literal");
  assert.ok(script.includes(`do script "${escaped}"`), "escaped inner command embedded whole");
}

// --- iterm mode: targets iTerm2, uses write text ---
{
  const argv = buildLaunchCommand("iterm", "claude", "/vault", "hi", "");
  const script = argv[2];
  const escaped = escapeAppleScriptString(buildInnerShellCommand("claude", "/vault", "hi"));
  assert.ok(script.includes('tell application "iTerm2"'), "targets iTerm2");
  assert.ok(script.includes("write text"), "uses write text to run the command");
  assert.ok(script.includes(`write text "${escaped}"`), "inner shell command embedded in write text");
}

// --- custom mode: substitutes {vault} and {prompt}, shell-quoted, no AppleScript ---
{
  const argv = buildLaunchCommand(
    "custom",
    "claude",
    "/Users/jaymo/AIOS",
    "do the thing",
    "code {vault} && echo {prompt}"
  );
  assert.deepEqual(argv.slice(0, 2), ["/bin/sh", "-c"], "custom mode runs via /bin/sh -c");
  assert.equal(
    argv[2],
    "code '/Users/jaymo/AIOS' && echo 'do the thing'",
    "placeholders substituted with shell-quoted values"
  );
}

// --- custom mode, null prompt: {prompt} substitutes to empty string ---
{
  const argv = buildLaunchCommand("custom", "claude", "/vault", null, "code {vault} {prompt}");
  assert.equal(argv[2], "code '/vault' ", "null prompt substitutes to empty string, not the literal placeholder");
}

// --- custom mode with an apostrophe in the vault path: still safely single-quoted ---
{
  const argv = buildLaunchCommand("custom", "claude", "/Users/jaymo/O'Brien Vault", null, "{vault}");
  assert.equal(argv[2], "'/Users/jaymo/O'\\''Brien Vault'", "vault path with an apostrophe is shell-escaped");
}

console.log("launchModel: all assertions passed");

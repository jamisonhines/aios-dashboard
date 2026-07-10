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

function buildInnerShellCommandNoCd(claudeBinary, prompt) {
  const parts = [shellQuoteSingle(claudeBinary)];
  if (prompt != null) parts.push(shellQuoteSingle(prompt));
  return parts.join(" ");
}

function buildLaunchCommand(mode, claudeBinary, vaultPath, prompt, customCommand, ideAppName, openVaultFolder, autoSession, sessionTarget, newSessionCommand) {
  if (mode === "app") {
    const appName = ideAppName || "Antigravity";
    if (autoSession && sessionTarget === "extension") {
      const paletteCmd = newSessionCommand || "Claude Code: New Session";
      let script =
        `tell application "${escapeAppleScriptString(appName)}" to activate\n` +
        `delay 1.5\n` +
        `tell application "System Events"\n` +
        `keystroke "p" using {command down, shift down}\n` +
        `end tell\n` +
        `delay 0.5\n` +
        `set the clipboard to "${escapeAppleScriptString(paletteCmd)}"\n` +
        `tell application "System Events"\n` +
        `keystroke "v" using {command down}\n` +
        `delay 0.4\n` +
        `key code 36\n` +
        `end tell\n` +
        `delay 1.5\n`;
      if (prompt != null) {
        script +=
          `set the clipboard to "${escapeAppleScriptString(prompt)}"\n` +
          `tell application "System Events"\n` +
          `keystroke "v" using {command down}\n` +
          `delay 0.3\n` +
          `key code 36\n` +
          `end tell`;
      }
      return ["osascript", "-e", script.trimEnd()];
    }
    if (autoSession) {
      const shellCmd = buildInnerShellCommandNoCd(claudeBinary, prompt);
      const script =
        `tell application "${escapeAppleScriptString(appName)}" to activate\n` +
        `delay 1.5\n` +
        `tell application "System Events"\n` +
        `keystroke "\`" using {control down, shift down}\n` +
        `end tell\n` +
        `delay 1.2\n` +
        `set the clipboard to "${escapeAppleScriptString(shellCmd)}"\n` +
        `tell application "System Events"\n` +
        `keystroke "v" using {command down}\n` +
        `delay 0.3\n` +
        `key code 36\n` +
        `end tell`;
      return ["osascript", "-e", script];
    }
    const argv = ["open", "-a", appName];
    if (openVaultFolder) argv.push(vaultPath);
    return argv;
  }
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


// --- app mode: open -a with the app name and raw vault path (no shell quoting needed, argv form) ---
{
  const argv = buildLaunchCommand("app", "claude", "/Users/x/My Vault", "some prompt", "", "Antigravity");
  assert.deepEqual(argv, ["open", "-a", "Antigravity"], "app mode default: activate only, no folder argument");
}

// --- app mode with openVaultFolder: passes the vault path (may spawn a new window) ---
{
  const argv = buildLaunchCommand("app", "claude", "/Users/x/My Vault", null, "", "Antigravity", true);
  assert.deepEqual(argv, ["open", "-a", "Antigravity", "/Users/x/My Vault"], "openVaultFolder adds the path");
}

// --- app mode: falls back to Antigravity when no app name given ---
{
  const argv = buildLaunchCommand("app", "claude", "/v", null, "", "");
  assert.equal(argv[2], "Antigravity", "empty app name falls back to the default");
}


// --- app mode with autoSession: osascript drives the IDE terminal ---
{
  const argv = buildLaunchCommand("app", "claude", "/v", "fix the 'intake' pile", "", "Antigravity IDE", false, true);
  assert.equal(argv[0], "osascript", "autoSession uses osascript");
  const script = argv[2];
  assert.ok(script.includes('tell application "Antigravity IDE" to activate'), "activates the right app");
  const clipLine = script.split("\n").find((l) => l.startsWith("set the clipboard to "));
  assert.ok(clipLine, "script sets the clipboard");
  // round-trip: unescape the AppleScript literal and check the shell command
  const unescaped = clipLine.slice('set the clipboard to "'.length, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  assert.equal(unescaped, buildInnerShellCommandNoCd("claude", "fix the 'intake' pile"), "clipboard carries the exact shell-quoted claude command");
  assert.ok(script.includes("key code 36"), "presses return");
}


// --- app mode, extension target: palette-driven Claude Code session ---
{
  const argv = buildLaunchCommand("app", "claude", "/v", "mine the journal", "", "Antigravity IDE", false, true, "extension", "Claude Code: New Session");
  const script = argv[2];
  assert.ok(script.includes('keystroke "p" using {command down, shift down}'), "opens the command palette");
  assert.ok(script.includes('set the clipboard to "Claude Code: New Session"'), "pastes the palette command");
  assert.ok(script.includes('set the clipboard to "mine the journal"'), "pastes the prompt");
}

// --- extension target with null prompt: opens the session, sends nothing ---
{
  const argv = buildLaunchCommand("app", "claude", "/v", null, "", "X", false, true, "extension", "Claude Code: New Session");
  assert.ok(!argv[2].includes("delay 0.3"), "no prompt paste block when prompt is null");
}

console.log("launchModel: all assertions passed");

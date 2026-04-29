# Windows Shell Encoding Fix

## Problem

When the agent executes shell commands on Windows systems, the output appears garbled with characters like `����` instead of proper text. This happens because:

1. **Windows default encoding**: Windows shells (CMD, PowerShell) use GBK/GB2312 or other legacy code pages by default (e.g., code page 936 for Simplified Chinese)
2. **UTF-8 decoding mismatch**: The agent's `Stream.decodeText()` expects UTF-8 encoded output
3. **Result**: Non-ASCII characters are incorrectly decoded, producing mojibake (garbled text)

## Solution

The fix is implemented in `packages/opencode/src/tool/bash.ts` with the following changes:

### 1. PowerShell Encoding Fix

For PowerShell commands, we prepend a command to set the output encoding to UTF-8:

```typescript
const psCommand = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${command}`
```

This ensures PowerShell outputs UTF-8 encoded text that can be correctly decoded.

### 2. CMD Encoding Fix

For CMD (Command Prompt) commands, we prepend `chcp 65001` to switch to UTF-8 code page:

```typescript
const cmdCommand = `chcp 65001 >nul && ${command}`
```

- `chcp 65001`: Sets the active code page to 65001 (UTF-8)
- `>nul`: Suppresses the "Active code page: 65001" message
- `&&`: Ensures the actual command only runs if chcp succeeds

### 3. Environment Variables

We also set environment variables to help with encoding:

```typescript
const winEnv = process.platform === "win32" ? { ...env, PYTHONIOENCODING: "utf-8" } : env
```

- `PYTHONIOENCODING=utf-8`: Ensures Python scripts output UTF-8

## Testing

To test if the fix works:

1. On a Windows system, run a command that outputs non-ASCII characters:
   ```bash
   echo 你好世界
   ```

2. Before the fix: Output appears as `����`
3. After the fix: Output appears correctly as `你好世界`

## Technical Details

### Code Changes

All changes are marked with `testagent_change` comments in:
- `packages/opencode/src/tool/bash.ts`

### Affected Functions

1. `cmd()` - Modified to prepend encoding commands
2. `shellEnv()` - Modified to set UTF-8 environment variables

### Platform Detection

The fix only applies when `process.platform === "win32"` to avoid affecting Unix-like systems.

## References

- Windows Code Pages: https://docs.microsoft.com/en-us/windows/win32/intl/code-page-identifiers
- PowerShell OutputEncoding: https://docs.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_character_encoding
- UTF-8 Code Page (65001): https://en.wikipedia.org/wiki/UTF-8

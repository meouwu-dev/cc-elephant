@echo off
:: Shim that delegates to the LSP wrapper proxy.
:: Place this directory on PATH before the real typescript-language-server.
set "SCRIPT_DIR=%~dp0.."
bun "%SCRIPT_DIR%\lsp-wrapper.ts" %*

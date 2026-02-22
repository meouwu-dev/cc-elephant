export function raiseWindow(pid: number): void {
  if (process.platform !== "win32") return;
  Bun.spawn([
    "powershell",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `(New-Object -ComObject WScript.Shell).AppActivate(${pid})`,
  ]);
}

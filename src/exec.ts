// Runs a command without a shell and returns its stdout. Throws with stderr on failure.
export async function run(cmd: string[]): Promise<string> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`${cmd[0]} exited ${code}: ${stderr.slice(-2000) || stdout.slice(-2000)}`);
  return stdout;
}

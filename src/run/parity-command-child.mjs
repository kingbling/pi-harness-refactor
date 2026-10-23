import { spawn } from 'node:child_process';

// This process leads the dedicated observation group. The harness cannot handle SIGKILL,
// so its child also checks for reparenting and stops the readers it owns.
const parent = Number(process.argv[2]);
let child;
const stop = () => {
  try { process.kill(-process.pid, 'SIGKILL'); }
  catch { child?.kill('SIGKILL'); process.exit(1); }
};
try {
  if (!Number.isSafeInteger(parent) || parent < 1 || process.ppid !== parent) stop();
  const command = JSON.parse(process.argv[3]);
  child = spawn(command.cmd, command.args, { env: process.env, stdio: 'inherit' });
  const watch = setInterval(() => { if (process.ppid !== parent) stop(); }, 250);
  watch.unref();
  child.once('error', error => { process.stderr.write(`Observation command could not start (${error.code ?? error.name})\n`); process.exit(1); });
  child.once('exit', (code, signal) => { if (signal) stop(); else process.exit(code ?? 1); });
} catch {
  process.stderr.write('Observation launcher failed\n');
  stop();
}

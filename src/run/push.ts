import { execFile, execFileSync } from "node:child_process";
import { join } from "node:path";
import pc from "picocolors";
import { loadConfig, saveConfig, type Config } from "../config.ts";

/**
 * `target.git.push`: when "on" and the target repo has a remote, the migration branch is pushed after merges. On
 * the side (lanes never wait), at most once a minute, and once more when the run ends. Never asks for a password:
 * a remote that needs one fails and says so in the log.
 */

/** The remote to push to: the configured one, else origin, else the repo's only remote. */
export function pushRemote(repo: string, preferred?: string): string | undefined {
	let remotes: string[] = [];
	try {
		remotes = execFileSync("git", ["-C", repo, "remote"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).split("\n").map((r) => r.trim()).filter(Boolean);
	} catch {
		return undefined;
	}
	if (preferred) return remotes.includes(preferred) ? preferred : undefined;
	return remotes.includes("origin") ? "origin" : remotes.length === 1 ? remotes[0] : undefined;
}

function pushOnce(repo: string, remote: string, branch: string): Promise<string | undefined> {
	return new Promise((res) => {
		execFile("git", ["-C", repo, "push", "--quiet", remote, `${branch}:${branch}`], { timeout: 120_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: process.env["GIT_SSH_COMMAND"] ?? "ssh -o BatchMode=yes" } }, (err, _out, stderr) =>
			res(err ? String(stderr || err.message).trim().split("\n").slice(-2).join(" ") : undefined),
		);
	});
}

export interface Pusher {
	afterMerge(): void;
	finish(): Promise<void>;
}

export function createPusher(o: { config: Config; root: string; log: (l: string) => void; everyMs?: number }): Pusher {
	const every = o.everyMs ?? 60_000;
	let dirty = false;
	let last = 0;
	let running: Promise<void> | undefined;
	let timer: NodeJS.Timeout | undefined;
	let lastError = "";
	// the setting is read at push time: `br push on` applies to a running run
	const settings = () => {
		try {
			return loadConfig(join(o.root, "bigrefactor.config.json")).config.target.git;
		} catch {
			return o.config.target.git;
		}
	};
	const push = () => {
		if (running || !dirty) return;
		const git = settings();
		if (git.push !== "on") return;
		const remote = pushRemote(o.config.target.path, git.remote);
		if (!remote) {
			if (lastError !== "no remote") o.log(pc.yellow(`push: the target repo has no remote${git.remote ? ` named ${git.remote}` : ""}; nothing pushed`));
			lastError = "no remote";
			return;
		}
		dirty = false;
		last = Date.now();
		running = pushOnce(o.config.target.path, remote, git.branch)
			.then((err) => {
				if (!err) {
					if (lastError) o.log(pc.green(`push: ${git.branch} → ${remote} works again`));
					lastError = "";
					return;
				}
				dirty = true; // try again with the next merge
				if (err !== lastError) o.log(pc.yellow(`push to ${remote} failed: ${err}`));
				lastError = err;
			})
			.finally(() => (running = undefined));
	};
	return {
		afterMerge() {
			dirty = true;
			const wait = last + every - Date.now();
			if (wait <= 0) return push();
			timer ??= setTimeout(() => ((timer = undefined), push()), wait);
		},
		async finish() {
			if (timer) clearTimeout(timer);
			timer = undefined;
			await running;
			push();
			await running;
		},
	};
}

/** `br push [on|off] [remote]`: show or change the setting. */
export function pushSetting(configPath: string, args: string[]): string {
	const { config, root } = loadConfig(configPath);
	const [mode, remote] = args;
	if (mode === "on" || mode === "off") {
		config.target.git.push = mode;
		if (remote) config.target.git.remote = remote;
		saveConfig(root, config);
	} else if (mode) throw new Error("usage: br push [on|off] [remote]");
	const g = config.target.git;
	const found = pushRemote(config.target.path, g.remote);
	return `push ${g.push}: ${g.branch} → ${found ?? (g.remote ? `${g.remote} (no such remote in ${config.target.path})` : `no remote in ${config.target.path}`)}${g.push === "on" ? " (after merges, at most once a minute, and when a run ends)" : ""}\nchange: br push on|off [remote]  ·  in Pi: /br push on|off [remote]`;
}

import { execFile, execFileSync } from "node:child_process";
import { join } from "node:path";
import pc from "picocolors";
import { loadConfig, saveConfig, type Config } from "../config.ts";
import { mainBranch } from "../git.ts";

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
	let finished = false;
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
		const branch = mainBranch(o.config.target.path, git.branch);
		running = pushOnce(o.config.target.path, remote, branch)
			.then((err) => {
				if (!err) {
					if (lastError) o.log(pc.green(`push: ${branch} → ${remote} works again`));
					lastError = "";
					return;
				}
				dirty = true; // try again with the next merge
				if (err !== lastError) o.log(pc.yellow(`push to ${remote} failed: ${err}`));
				lastError = err;
			})
			.finally(() => {
				running = undefined;
				// merges that landed while this push ran (or a failed push) go out with the next one, not with some later merge
				if (dirty && !finished) schedule();
			});
	};
	const schedule = () => {
		const wait = last + every - Date.now();
		if (wait <= 0) return push();
		timer ??= setTimeout(() => ((timer = undefined), push()), wait);
	};
	return {
		afterMerge() {
			dirty = true;
			schedule();
		},
		async finish() {
			finished = true;
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
		config.target.git.pushAskedAt = new Date().toISOString(); // the owner decided: onboarding never asks (or overwrites) again
		saveConfig(root, config);
	} else if (mode) throw new Error("usage: br push [on|off] [remote]");
	const g = config.target.git;
	const found = pushRemote(config.target.path, g.remote);
	return `push ${g.push}: ${mainBranch(config.target.path, g.branch)} → ${found ?? (g.remote ? `${g.remote} (no such remote in ${config.target.path})` : `no remote in ${config.target.path}`)}${g.push === "on" ? " (after merges, at most once a minute, and when a run ends)" : ""}\nchange: br push on|off [remote]  ·  in Pi: /br push on|off [remote]`;
}

function remoteUrl(repo: string, remote: string): string | undefined {
	try {
		return execFileSync("git", ["-C", repo, "remote", "get-url", remote], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim() || undefined;
	} catch {
		return undefined;
	}
}

/** Can this machine reach the remote without a password prompt? undefined = yes, else git's message. */
function reachable(repo: string, remote: string): string | undefined {
	try {
		execFileSync("git", ["-C", repo, "ls-remote", "--heads", remote], { timeout: 30_000, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: process.env["GIT_SSH_COMMAND"] ?? "ssh -o BatchMode=yes" } });
		return undefined;
	} catch (e: any) {
		return String(e?.stderr ?? e?.message ?? e).trim().split("\n").slice(-1)[0];
	}
}

/**
 * Onboarding: where the new code goes. Shows the target repo's remote (if any) and asks whether the run pushes
 * the migration branch there, to another URL, or not at all. Returns what to store in target.git.
 */
export async function askPush(config: Config, ui: { select(m: string, o: Array<{ value: string; label: string; hint?: string }>, i?: string): Promise<string | undefined>; text(m: string, i: string): Promise<string | undefined>; log(l: string): void }, yes: boolean): Promise<{ push: "on" | "off"; remote?: string }> {
	const repo = config.target.path;
	const remote = pushRemote(repo, config.target.git.remote);
	const url = remote ? remoteUrl(repo, remote) : undefined;
	if (yes) return { push: config.target.git.push, remote: config.target.git.remote };
	const pick = await ui.select(
		url ? `The new repo has the remote ${remote} → ${url}. Push the ${mainBranch(repo, config.target.git.branch)} branch there after merges?` : `The new repo (${repo}) has no remote. Should the run push the ${mainBranch(repo, config.target.git.branch)} branch somewhere after merges?`,
		[
			...(url ? [{ value: "on", label: `yes, push to ${remote}`, hint: "on the side, at most once a minute and when a run ends" }] : []),
			{ value: "url", label: url ? "push to another URL (type it)" : "yes: add a remote (type its URL)" },
			{ value: "off", label: "no, keep it local", hint: "br push on later" },
		],
		url ? "on" : "off",
	);
	if (pick === "on") return { push: "on", remote };
	if (pick !== "url") return { push: "off", remote: config.target.git.remote };
	const typed = (await ui.text("Remote URL of the new repo (git@… or https://…)", ""))?.trim();
	if (!typed) return { push: "off", remote: config.target.git.remote };
	const name = remote && remote !== "origin" ? "bigrefactor" : "origin";
	execFileSync("git", ["-C", repo, "remote", ...(remoteUrl(repo, name) ? ["set-url", name, typed] : ["add", name, typed])], { stdio: ["ignore", "pipe", "pipe"] });
	const err = reachable(repo, name);
	ui.log(err ? `  ${name} → ${typed}: not reachable without a password yet (${err}); pushes retry after merges` : `  ${name} → ${typed}: reachable`);
	return { push: "on", remote: name };
}

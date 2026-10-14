import { execFile } from "node:child_process";
import { join } from "node:path";
import pc from "picocolors";
import { loadConfig, saveConfig, type Config } from "../config.ts";
import { mainBranch } from "../git.ts";
import { exec } from "../proc.ts";

/**
 * `target.git.push`: when "on" and the target repo has a remote, the migration branch is pushed after merges. On
 * the side (lanes never wait), at most once a minute, and once more when the run ends. Never asks for a password:
 * a remote that needs one fails and says so in the log.
 */

/** A remote given as a URL or path (git@host:x, https://…, /path) rather than a remote name: git pushes to it as it is. */
const isUrl = (r: string) => /:|^\.{0,2}\//.test(r);

/** The remote to push to: the configured one (a remote name, or a URL), else origin, else the repo's only remote. */
export async function pushRemote(repo: string, preferred?: string): Promise<string | undefined> {
	let remotes: string[] = [];
	try {
		remotes = (await exec("git", ["-C", repo, "remote"])).split("\n").map((r) => r.trim()).filter(Boolean);
	} catch {
		return undefined;
	}
	if (preferred) return remotes.includes(preferred) ? preferred : isUrl(preferred) ? preferred : undefined;
	return remotes.includes("origin") ? "origin" : remotes.length === 1 ? remotes[0] : undefined;
}

/** git without a password prompt: a remote that needs one fails instead of hanging. */
const noPrompt = () => ({ ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: process.env["GIT_SSH_COMMAND"] ?? "ssh -o BatchMode=yes" });

function pushOnce(repo: string, remote: string, branch: string): Promise<string | undefined> {
	return new Promise((res) => {
		execFile("git", ["-C", repo, "push", "--quiet", remote, `${branch}:${branch}`], { timeout: 120_000, env: noPrompt() }, (err, _out, stderr) =>
			// git's own "hint:" lines are advice for a person at a terminal, not the error
			res(err ? String(stderr || err.message).trim().split("\n").filter((l) => !/^hint:/.test(l)).slice(-2).join(" ") : undefined),
		);
	});
}

/** git refused because the remote branch has commits this repo does not have (another history, or someone pushed). */
const rejected = (err: string) => /\[rejected\]|non-fast-forward|fetch first/.test(err);

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
		// taken at once: a second push() while the remote is looked up waits for this one
		let pushed = false;
		running = (async () => {
			const remote = await pushRemote(o.config.target.path, git.remote);
			if (!remote) {
				if (lastError !== "no remote") o.log(pc.yellow(`push: the target repo has no remote${git.remote ? ` named ${git.remote}` : ""}; nothing pushed`));
				lastError = "no remote";
				return;
			}
			pushed = true;
			dirty = false;
			last = Date.now();
			const branch = await mainBranch(o.config.target.path, git.branch);
			const err = await pushOnce(o.config.target.path, remote, branch);
			if (!err) {
				if (lastError) o.log(pc.green(`push: ${branch} → ${remote} works again`));
				lastError = "";
				return;
			}
			dirty = true; // try again with the next merge
			if (err !== lastError)
				o.log(
					pc.yellow(
						rejected(err)
							? `push to ${remote} refused: its ${branch} has commits this repo does not have. br push replace overwrites it with this repo's ${branch}; br push off stops pushing`
							: `push to ${remote} failed: ${err}`,
					),
				);
			lastError = err;
		})()
			.catch((e) => o.log(pc.yellow(`push failed: ${e?.message ?? e}`)))
			.finally(() => {
				running = undefined;
				// merges that landed while this push ran (or a failed push) go out with the next one, not with some later merge
				if (pushed && dirty && !finished) schedule();
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

/** `br push [on|off] [remote]`: show or change the setting. `br push replace`: overwrite the remote branch once. */
export async function pushSetting(configPath: string, args: string[]): Promise<string> {
	const { config, root } = loadConfig(configPath);
	const [mode, remote] = args;
	if (mode === "replace") return await replaceRemote(config);
	if (mode === "on" || mode === "off") {
		config.target.git.push = mode;
		// a URL becomes a remote of the target repo (as onboarding does), so git and the owner see it
		if (remote) config.target.git.remote = isUrl(remote) ? await addRemote(config.target.path, remote) : remote;
		config.target.git.pushAskedAt = new Date().toISOString(); // the owner decided: onboarding never asks (or overwrites) again
		saveConfig(root, config);
	} else if (mode) throw new Error("usage: br push [on|off] [remote] | br push replace");
	const g = config.target.git;
	const found = await pushRemote(config.target.path, g.remote);
	return `push ${g.push}: ${await mainBranch(config.target.path, g.branch)} → ${found ?? (g.remote ? `${g.remote} (no such remote in ${config.target.path})` : `no remote in ${config.target.path}`)}${g.push === "on" ? " (after merges, at most once a minute, and when a run ends)" : ""}\nchange: br push on|off [remote]  ·  in Pi: /br push on|off [remote]`;
}

/**
 * The owner's call when the remote branch has another history: this repo's branch replaces it. Only what was
 * there a moment ago is overwritten (--force-with-lease): a push that lands in between is refused, not lost.
 */
async function replaceRemote(config: Config): Promise<string> {
	const repo = config.target.path;
	const g = config.target.git;
	const remote = await pushRemote(repo, g.remote);
	if (!remote) throw new Error(`no remote in ${repo}; br push on <url> first`);
	const branch = await mainBranch(repo, g.branch);
	const run = async (args: string[]) => (await exec("git", ["-C", repo, ...args], { timeout: 120_000, env: noPrompt() })).trim();
	try {
		const there = (await run(["ls-remote", "--heads", remote, branch])).split(/\s/)[0] ?? "";
		await run(["push", "--quiet", `--force-with-lease=refs/heads/${branch}:${there}`, remote, `${branch}:${branch}`]);
		return `replaced ${branch} on ${remote}${there ? ` (was ${there.slice(0, 8)})` : ""} with this repo's ${branch} (${await run(["rev-parse", "--short", branch])})`;
	} catch (e: any) {
		throw new Error(String(e?.stderr || e?.message || e).trim().split("\n").filter((l) => !/^hint:/.test(l)).slice(-2).join(" "));
	}
}

/** Adds (or points) a remote at `url`: origin, unless origin goes elsewhere; returns its name. */
async function addRemote(repo: string, url: string): Promise<string> {
	const origin = await remoteUrl(repo, "origin");
	const name = origin && origin !== url ? "bigrefactor" : "origin";
	await exec("git", ["-C", repo, "remote", ...((await remoteUrl(repo, name)) ? ["set-url", name, url] : ["add", name, url])]);
	return name;
}

async function remoteUrl(repo: string, remote: string): Promise<string | undefined> {
	try {
		return (await exec("git", ["-C", repo, "remote", "get-url", remote])).trim() || undefined;
	} catch {
		return undefined;
	}
}

/** Can this machine reach the remote without a password prompt? undefined = yes, else git's message. */
async function reachable(repo: string, remote: string): Promise<string | undefined> {
	try {
		await exec("git", ["-C", repo, "ls-remote", "--heads", remote], { timeout: 30_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: process.env["GIT_SSH_COMMAND"] ?? "ssh -o BatchMode=yes" } });
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
	const remote = await pushRemote(repo, config.target.git.remote);
	const url = remote ? await remoteUrl(repo, remote) : undefined;
	if (yes) return { push: config.target.git.push, remote: config.target.git.remote };
	const pick = await ui.select(
		url ? `The new repo has the remote ${remote} → ${url}. Push the ${await mainBranch(repo, config.target.git.branch)} branch there after merges?` : `The new repo (${repo}) has no remote. Should the run push the ${await mainBranch(repo, config.target.git.branch)} branch somewhere after merges?`,
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
	const name = await addRemote(repo, typed);
	const err = await reachable(repo, name);
	ui.log(err ? `  ${name} → ${typed}: not reachable without a password yet (${err}); pushes retry after merges` : `  ${name} → ${typed}: reachable`);
	return { push: "on", remote: name };
}

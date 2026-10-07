import { execFileSync, spawn } from "node:child_process";
import type { ModelClient } from "../models/types.ts";

/**
 * Tools a picked stack needs that this machine lacks (php, composer, …): not a manifest problem, and not a dead
 * end either. The owner is told what is missing and offered the install command for this OS's package manager;
 * on "run" it runs here with its output in the activity feed, then the tools are checked again. Nothing installs
 * without the owner's go: `--yes` stops with the exact command, and a command that needs sudo is shown for the
 * owner to run themselves (in Pi: `! <command>`).
 */

export class MissingToolsError extends Error {
	readonly stack: string;
	readonly tools: string[];
	readonly command?: string;
	// plain fields, no parameter properties: Node's type stripping (strip-only) cannot run those
	constructor(stack: string, tools: string[], command?: string) {
		super(`the ${stack} toolchain needs ${tools.join(", ")} on this machine (not found on PATH); ${command ? `install it with \`${command}\`` : "install it"} and pick ${stack} again`);
		this.stack = stack;
		this.tools = tools;
		this.command = command;
	}
}

export type Manager = "brew" | "apt-get" | "dnf" | "pacman" | "apk" | "winget";

/** tool → package, per package manager; null = the manager has no package for it (fall back to the model / the owner). */
const PACKAGES: Record<string, Partial<Record<Manager, string>>> = {
	php: { brew: "php", "apt-get": "php-cli", dnf: "php-cli", pacman: "php", apk: "php", winget: "PHP.PHP" },
	composer: { brew: "composer", "apt-get": "composer", dnf: "composer", pacman: "composer", apk: "composer", winget: "Composer.Composer" },
	symfony: { brew: "symfony-cli/tap/symfony-cli" },
	node: { brew: "node", "apt-get": "nodejs", dnf: "nodejs", pacman: "nodejs", apk: "nodejs", winget: "OpenJS.NodeJS" },
	npm: { brew: "node", "apt-get": "npm", dnf: "npm", pacman: "npm", apk: "npm", winget: "OpenJS.NodeJS" },
	npx: { brew: "node", "apt-get": "npm", dnf: "npm", pacman: "npm", apk: "npm", winget: "OpenJS.NodeJS" },
	pnpm: { brew: "pnpm" },
	yarn: { brew: "yarn" },
	python: { brew: "python", "apt-get": "python3", dnf: "python3", pacman: "python", apk: "python3", winget: "Python.Python.3.12" },
	python3: { brew: "python", "apt-get": "python3", dnf: "python3", pacman: "python", apk: "python3", winget: "Python.Python.3.12" },
	pip: { brew: "python", "apt-get": "python3-pip", dnf: "python3-pip", pacman: "python-pip", apk: "py3-pip" },
	java: { brew: "openjdk", "apt-get": "default-jdk", dnf: "java-latest-openjdk-devel", pacman: "jdk-openjdk", apk: "openjdk21", winget: "Microsoft.OpenJDK.21" },
	javac: { brew: "openjdk", "apt-get": "default-jdk", dnf: "java-latest-openjdk-devel", pacman: "jdk-openjdk", apk: "openjdk21" },
	mvn: { brew: "maven", "apt-get": "maven", dnf: "maven", pacman: "maven", apk: "maven" },
	gradle: { brew: "gradle", "apt-get": "gradle", dnf: "gradle", pacman: "gradle" },
	dotnet: { brew: "dotnet-sdk", "apt-get": "dotnet-sdk-8.0", dnf: "dotnet-sdk-8.0", pacman: "dotnet-sdk", winget: "Microsoft.DotNet.SDK.8" },
	go: { brew: "go", "apt-get": "golang", dnf: "golang", pacman: "go", apk: "go", winget: "GoLang.Go" },
	ruby: { brew: "ruby", "apt-get": "ruby-full", dnf: "ruby", pacman: "ruby", apk: "ruby" },
	gem: { brew: "ruby", "apt-get": "ruby-full", dnf: "ruby", pacman: "ruby", apk: "ruby" },
	bundle: { brew: "ruby", "apt-get": "ruby-bundler", dnf: "rubygem-bundler", pacman: "ruby-bundler" },
	rails: {},
	cargo: { brew: "rust", "apt-get": "cargo", dnf: "cargo", pacman: "rust", apk: "cargo" },
	rustc: { brew: "rust", "apt-get": "rustc", dnf: "rust", pacman: "rust", apk: "rust" },
	elixir: { brew: "elixir", "apt-get": "elixir", dnf: "elixir", pacman: "elixir" },
	mix: { brew: "elixir", "apt-get": "elixir", dnf: "elixir", pacman: "elixir" },
};

const INSTALL: Record<Manager, { argv: string[]; sudo: boolean }> = {
	brew: { argv: ["brew", "install"], sudo: false },
	"apt-get": { argv: ["apt-get", "install", "-y"], sudo: true },
	dnf: { argv: ["dnf", "install", "-y"], sudo: true },
	pacman: { argv: ["pacman", "-S", "--noconfirm"], sudo: true },
	apk: { argv: ["apk", "add"], sudo: true },
	winget: { argv: ["winget", "install", "-e", "--id"], sudo: false },
};

/** `command -v` for one tool (injectable for tests). */
export type Probe = (tool: string) => boolean;
export const onPath: Probe = (tool) => {
	if (!/^[\w.+-]+$/.test(tool)) return false;
	try {
		execFileSync("sh", ["-c", `command -v ${tool}`], { stdio: "pipe" });
		return true;
	} catch {
		return false;
	}
};

export interface InstallPlan {
	manager?: Manager;
	/** argv of the install command, when every missing tool maps to a package (or the model named one). */
	argv?: string[];
	/** The command as the owner sees it (with `sudo` when it needs root). */
	display?: string;
	needsSudo: boolean;
	/** Tools no known package covers: the owner (or the model) has to say how. */
	unknown: string[];
}

/** The package manager of this machine, first one found (brew before the distro managers). */
export function packageManager(probe: Probe = onPath, platform = process.platform): Manager | undefined {
	const order: Manager[] = platform === "win32" ? ["winget"] : platform === "darwin" ? ["brew"] : ["apt-get", "dnf", "pacman", "apk", "brew"];
	return order.find((m) => probe(m));
}

export function installPlan(tools: string[], probe: Probe = onPath, platform = process.platform, isRoot = process.getuid?.() === 0): InstallPlan {
	const manager = packageManager(probe, platform);
	if (!manager) return { needsSudo: false, unknown: tools };
	const pkgs = new Set<string>();
	const unknown: string[] = [];
	for (const t of tools) {
		const p = PACKAGES[t]?.[manager];
		if (p) pkgs.add(p);
		else unknown.push(t);
	}
	if (!pkgs.size) return { manager, needsSudo: false, unknown };
	const base = INSTALL[manager];
	// winget installs one id per call
	const argv = manager === "winget" ? [...base.argv, [...pkgs][0]!] : [...base.argv, ...pkgs];
	const needsSudo = base.sudo && !isRoot;
	return { manager, argv, display: `${needsSudo ? "sudo " : ""}${argv.join(" ")}`, needsSudo, unknown };
}

/** The model names an install command for tools no table covers. Shown to the owner, never run unseen. */
async function askModel(client: ModelClient, model: string, tools: string[], manager: Manager | undefined): Promise<string | undefined> {
	const schema = { type: "object", additionalProperties: false, required: ["command"], properties: { command: { type: "string", description: "one shell command line installing every tool, or empty when unsure" } } };
	try {
		const res = await client.chat({ model, schema, effort: "low", messages: [{ role: "system", content: "You give the official, current install command for developer tools. Answer only with the JSON object." }, { role: "user", content: `OS: ${process.platform}; package manager: ${manager ?? "none found"}. Install command for: ${tools.join(", ")}.` }] });
		const cmd = String((res.json as { command?: string } | undefined)?.command ?? "").trim();
		return cmd || undefined;
	} catch {
		return undefined;
	}
}

export type Runner = (argv: string[], log: (line: string) => void) => Promise<{ ok: boolean; output: string }>;
/** Runs the install command (no shell for a known plan; `sh -c` only for a model-named command the owner approved). */
export const runInstall: Runner = (argv, log) =>
	new Promise((res) => {
		const child = spawn(argv[0]!, argv.slice(1), { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, HOMEBREW_NO_AUTO_UPDATE: process.env["HOMEBREW_NO_AUTO_UPDATE"] ?? "1" } });
		let output = "";
		let partial = "";
		const onData = (b: Buffer) => {
			const s = partial + b.toString();
			const lines = s.split("\n");
			partial = lines.pop() ?? "";
			for (const l of lines) if (l.trim()) log(`    ${l}`);
			output = (output + b.toString()).slice(-4000);
		};
		child.stdout.on("data", onData);
		child.stderr.on("data", onData);
		child.on("error", (e) => res({ ok: false, output: String(e.message) }));
		child.on("close", (code) => {
			if (partial.trim()) log(`    ${partial}`);
			res({ ok: code === 0, output });
		});
	});

export interface ToolPrompter {
	select(message: string, options: Array<{ value: string; label: string; hint?: string }>, initial?: string): Promise<string | undefined>;
	log(line: string): void;
}

/**
 * Until every tool is on PATH: offer to install (or to check again after the owner installed it). Resolves true
 * once all are present, false when the owner picks another stack. `yes` never installs: it throws with the command.
 */
export async function ensureTools(o: {
	stack: string;
	tools: string[];
	ui: ToolPrompter;
	yes?: boolean;
	log?: (line: string) => void;
	probe?: Probe;
	run?: Runner;
	client?: ModelClient;
	model?: string;
	platform?: NodeJS.Platform;
	isRoot?: boolean;
}): Promise<boolean> {
	const probe = o.probe ?? onPath;
	const run = o.run ?? runInstall;
	const log = o.log ?? o.ui.log;
	let lastError = "";
	for (;;) {
		const missing = o.tools.filter((t) => !probe(t));
		if (!missing.length) return true;
		const plan = installPlan(missing, probe, o.platform, o.isRoot);
		let display = plan.display;
		let argv = plan.argv;
		let viaShell = false;
		if (plan.unknown.length && o.client && o.model) {
			const named = await askModel(o.client, o.model, plan.unknown, plan.manager);
			if (named) {
				display = display ? `${display} && ${named}` : named;
				argv = ["sh", "-c", display];
				viaShell = true;
			}
		}
		const sudo = plan.needsSudo || /\bsudo\b/.test(display ?? "");
		if (o.yes) throw new MissingToolsError(o.stack, missing, display);
		const RUN = "run", CHECK = "check", OTHER = "other";
		const how = !display ? `install ${missing.join(", ")} (no package manager command known for ${plan.manager ?? "this machine"})` : sudo ? `it needs root: run it yourself (in Pi: ! ${display})` : `command: ${display}`;
		const options = [
			...(display && !sudo ? [{ value: RUN, label: `install now: ${display} (recommended)`, hint: viaShell ? "suggested by a model; check it before running" : plan.manager } as const] : []),
			{ value: CHECK, label: "I installed it myself, check again", hint: sudo && display ? display : undefined },
			{ value: OTHER, label: "pick another stack" },
		];
		const v = await o.ui.select(`${o.stack} needs ${missing.join(", ")} on this machine (not found on PATH).\n   ${how}${lastError ? `\n   last attempt failed: ${lastError}` : ""}`, options, options[0]!.value);
		if (v === undefined) throw new Error("onboarding cancelled");
		if (v === OTHER) return false;
		if (v === CHECK) {
			lastError = missing.filter((t) => !probe(t)).length ? `still missing: ${missing.filter((t) => !probe(t)).join(", ")}` : "";
			continue;
		}
		log(`  installing ${missing.join(", ")}: ${display}`);
		const r = await run(argv!, log);
		if (!r.ok) {
			lastError = r.output.split("\n").filter(Boolean).slice(-3).join(" · ").slice(0, 300) || "the command failed";
			log(`  install failed: ${lastError}`);
			continue;
		}
		const still = missing.filter((t) => !probe(t));
		lastError = still.length ? `installed, but ${still.join(", ")} still not on PATH (open a new shell or add it to PATH)` : "";
		if (!still.length) log(`  ${missing.join(", ")} installed`);
	}
}

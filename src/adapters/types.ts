/**
 * Stack adapters. The core is stack-agnostic; everything that knows a language or framework
 * lives behind these two interfaces. `init` picks adapters from the interview answers.
 */

export interface IndexedSymbol {
	/** Stable id: `<path>::<Qualified::Name>`. */
	id: string;
	path: string;
	kind: "class" | "function" | "method" | "const" | "interface" | "trait" | "enum" | "route" | "template" | "other";
	name: string;
	line: number;
	exported: boolean;
	/** Hash of the normalized AST (identifiers kept, whitespace/comments dropped) for dedupe candidates. */
	astHash?: string;
	signature?: string;
	/** Last line of the declaration (inclusive); slices the symbol without re-parsing. */
	endLine?: number;
}

/**
 * Code map, per function/method: where it is, its comments lifted out of the code, and its call sites with what
 * the adapter knows about each receiver. The core resolves the calls (src/inventory/codemap.ts), so the adapter
 * only reports syntax: names, positions, declared types.
 */
export interface CodeComment {
	line: number;
	endLine: number;
	/** 0-based columns of the comment's first and last character (exclusive end) on line / endLine. */
	col: number;
	endCol: number;
	text: string;
	/** The comment's words without the language's comment markers (what a reader is shown). */
	body: string;
	/** doc = documentation of the function; code = commented-out code; banner = license/author/separator boilerplate; note = everything else. */
	kind: "doc" | "code" | "banner" | "note";
}

export interface CodeCall {
	line: number;
	/** function: bare call; static: Scope::name; member: receiver.name; new: constructor. */
	kind: "function" | "static" | "member" | "new";
	name: string;
	/** static: the class name, or self / parent (relative to the enclosing class). */
	scope?: string;
	/** member: `this` for the enclosing object, else the receiver variable as written. */
	receiver?: string;
	/** member call on the result of another call in the same function (index into calls). */
	receiverCall?: number;
}

export interface CodeFunction {
	/** Same id as the IndexedSymbol of the function/method. */
	id: string;
	/** Class (or other container) it belongs to, if any. */
	container?: string;
	name: string;
	line: number;
	endLine: number;
	signature: string;
	/** Declared return type, if the language states one. */
	returns?: string;
	comments: CodeComment[];
	calls: CodeCall[];
	/** Local variable → declared/constructed type (parameters, `new X`, doc annotations). */
	locals: Record<string, string>;
	/** Local variable → index of the call whose result it holds (typed later from that callee's return type). */
	assigned: Record<string, number>;
}

export interface CodeContainer {
	name: string;
	/** Parent class (extends), for method lookup through inheritance. */
	parent?: string;
	/** Traits/mixins whose methods it has. */
	uses?: string[];
}

export interface SourceTraits {
	/** Source text touches process-global state (sessions, cookies, globals): a unit risk signal. */
	globalState?: RegExp;
	/** One-line examples of constructs that are artifacts of this language and are not carried over (quoted to agents). */
	languageArtifacts?: string[];
	/** Shell commands that would change the legacy checkout or its dependencies (refused in agent sessions). */
	mutatingCommands?: RegExp;
	/** Directory names that are technical layers of this ecosystem, never business areas (lowercase). */
	layerDirs?: string[];
	/** Directories holding third-party dependencies or build output (skipped by surveys and scans). */
	vendorDirs?: string[];
}

/** How a target ecosystem manages its project and packages; the core never assumes a package manager. */
export interface TargetToolchain {
	/** Package ecosystem name for prompts ("npm", "maven", "pypi"). */
	ecosystem: string;
	/** Shape of a valid package name in this ecosystem (anchored at the start; the match is the name). */
	packageName: RegExp;
	/** Example package names for prompts. */
	packageExamples: string[];
	/** The project is scaffolded (its manifest exists). */
	isProjectReady(dir: string): boolean;
	/** Files whose change means dependencies changed (re-submits units parked on the environment). */
	manifestFiles: string[];
	/** Packages the project declares. */
	installedPackages(dir: string): string[];
	/** Command that adds packages to the project. */
	addPackages(dir: string, packages: string[]): { cmd: string; args: string[] };
	/** Dependency dirs shared from the main project into unit worktrees (symlinked, never copied). */
	worktreeLinks: string[];
	/** Generated paths (dependencies, build output) that are never committed or reviewed. */
	ignoredPaths: string[];
}

export interface IndexedDep {
	from: string; // symbol id or file path (for includes)
	to: string; // symbol id, file path, or bare name (resolved later)
	kind: "include" | "call" | "new" | "extends" | "implements" | "use" | "static_call" | "template" | "load";
}

/**
 * A framework concern and what happens to it in the target platform.
 *  platform: the new framework provides it (DI, routing, ORM) — nothing to port, map the calls;
 *  port:     application-specific logic living in framework classes — becomes units;
 *  drop:     obsolete in the target (PHP-only concerns);
 *  review:   unknown — a human or the escalate model decides.
 */
export interface FrameworkConcern {
	match: RegExp; // over the framework class/file name
	/** Generic concern key (loading, orm, routing, auth, rendering, commands, cache, mail, jobs, events, helpers, i18n, logging, http, install, tests, misc). */
	concern: string;
	/** What the legacy framework did, in stack-neutral words. */
	legacy: string;
	verdict: "platform" | "port" | "drop" | "review";
}

/** A third-party library the legacy app depends on, with the adapter's suggested successor (if known). */
export interface ExternalDep {
	name: string;
	version?: string;
	dev?: boolean;
	successor?: string;
	verdict: "platform" | "replace" | "drop" | "review";
	note?: string;
}

export interface IndexedRoute {
	id: string;
	method?: string;
	path: string;
	handlerSymbol?: string; // symbol id if resolvable, else `Class::method`
}

export interface IndexedQuery {
	symbolId: string;
	kind: "sql" | "orm" | "builder";
	tables: string[];
	text?: string;
}

export interface FileIndex {
	path: string;
	lang: string;
	loc: number;
	hash: string;
	symbols: IndexedSymbol[];
	deps: IndexedDep[];
	routes: IndexedRoute[];
	queries: IndexedQuery[];
	/** Bare identifiers that appear inside string literals (dynamic-dispatch signal). */
	literalRefs: string[];
	/** Markers like `new $cls`, `call_user_func`, variable includes. */
	dynamicMarkers: string[];
	/** Code map (optional: adapters without it fall back to symbol-level deps only). */
	functions?: CodeFunction[];
	containers?: CodeContainer[];
}

export interface SourceAdapter {
	id: string;
	/** File globs this adapter owns (relative to the source root). */
	include: string[];
	exclude: string[];
	/** Language-specific data-store signals (package manifests, DSN strings) for `br init`'s survey. */
	dbSignals?(root: string): Array<{ engine: string; evidence: string }>;
	/** Autodetect from the repo; returns a confidence 0..1 and detected framework/version if any. */
	detect(root: string): Promise<{ confidence: number; framework?: string; version?: string }>;
	indexFile(root: string, relPath: string, source: string): Promise<FileIndex>;
	/** How code of this language is shown to models for reading (read_function): indentation is syntax in some languages. */
	reading?: { indentSignificant?: boolean };
	/** Name semantics the core needs to resolve calls: true when class/function/method names match regardless of case. */
	names?: { caseInsensitive?: boolean };
	/**
	 * What only this language knows, for core heuristics and prompts. Every field is optional; absent = the core
	 * makes no claim (a fact stays unknown for a model to judge) instead of assuming one language's conventions.
	 */
	traits?: SourceTraits;
	/** Route table extraction when it is not derivable per file (framework route files, CLI dumps). */
	indexRoutes?(root: string): Promise<IndexedRoute[]>;
	/** Which tier a symbol belongs to, from its own shape (deps decide the rest). */
	classifyTier?(sym: IndexedSymbol, file: FileIndex): "T0" | "T1" | "T2" | "T3" | undefined;
	/** Unit kind from file shape (template, routes, data_access, ...); deps/tier fill the rest. */
	classifyKind?(file: FileIndex): string | undefined;
	/** Registration files (route tables, module wiring) are not migrated by agents: the target adapter regenerates them from the ledger. */
	isRegistrationFile?(path: string): boolean;
	/** Commands the tester session may run against the old code. */
	oldTestCommand?(root: string): string;
	/** Front controllers / entry scripts that have no inbound references but are alive. */
	isEntryPoint?(path: string): boolean;
	/**
	 * Directories (relative prefixes) holding the legacy FRAMEWORK, as opposed to the application. They are
	 * indexed so names resolve, but never become units: each framework class is mapped per concern
	 * (see `frameworkConcerns` and `br frameworks`).
	 */
	frameworkDirs?(root: string): string[];
	frameworkConcerns?: FrameworkConcern[];
	/** Files that form one natural unit (e.g. model + facade pair) → same group key; never cut apart by cycle cutting and merged when `inventory.mergeGroups`. */
	unitGroupOf?(path: string): string | undefined;
	/** Names a file is known by at runtime besides its symbols (template keys, command names…); a string literal hit keeps it alive. */
	fileAliases?(path: string): string[];
	/** Framework-profile generation (`br profile`): the worked example + format doc the model sees, and a code validator for what it wrote. */
	profileExample?(): { example: unknown; schemaDoc: string };
	/** Drop any cached framework profile so the next call re-reads `.bigrefactor/framework-profile.json` (after `br profile`). */
	reloadProfile?(): void;
	validateProfile?(json: unknown): string[];
	/** Declared third-party dependencies (composer/pip/gems…) with successor suggestions. */
	externalDeps?(root: string): ExternalDep[];
	/**
	 * How truth is established on the OLD code: the tester writes `scriptName` in the unit's truth dir, the
	 * orchestrator runs it with `run()` from the source root and expects ONE JSON array of
	 * {symbol, inputs, expected} on stdout. `instructions` tells the tester how to load legacy code.
	 */
	truth: {
		scriptName: string;
		run(sourceRoot: string, scriptPath: string): { cmd: string; args: string[] };
		instructions: string;
	};
	/**
	 * Where one source file belongs in the target: its legacy feature `area` (kebab-case, no dots; one area =
	 * one feature module per target stack) and its `surface` (ui → the UI target, server → the backend).
	 * `root` (the legacy source root) lets the adapter canonicalize names against the whole tree; callers go
	 * through placeUnit (src/run/placement.ts), which always passes it. Undefined = not sure: the core falls back to a
	 * generic guess and lets a model (then a human) decide. `area` may be missing while `surface` is certain (the
	 * adapter knows a file is server code but not its feature): the model then picks only the area, never the stack.
	 */
	placeFile?(path: string, root?: string): { area?: string; surface: "server" | "ui" } | undefined;
	/**
	 * Name parts only legacy file names carry (file kinds, extensions, lowercase). A target file or class name
	 * containing one is named after a legacy file: structure_ok fails it.
	 */
	legacyWords?: string[];
	/** Official docs to fetch at init (llms.txt style URLs preferred). */
	docs: Array<{ name: string; url: string }>;
}

/** A symbol that exists in the NEW codebase (what later units can reuse). */
export interface TargetSymbol {
	id: string; // `<relpath>::<Name>` or `<relpath>::<Class>.<method>`
	path: string;
	kind: string; // controller|service|repository|module|dto|helper|class|function|const|interface|enum|method|…
	name: string;
	line: number;
	signature?: string;
	doc?: string;
	/** "class", decorators, "shared"; "internal" = not exported/private (reuse check only, never indexed). */
	tags: string[];
	/** Normalized body hash (identifiers kept, whitespace/comments dropped) for duplicate detection. */
	bodyHash?: string;
}

/** What the gate knows beyond the files when it checks structure. */
export interface StructureContext {
	/** The file did not exist before this unit (git: untracked). Without it every file counts as existing. */
	isNew?(path: string): boolean;
	/** Paths an approved tidy task names: their shape needs no further reason. */
	sanctioned?: string[];
	/** SourceAdapter.legacyWords: name parts of legacy file kinds a target name must not carry. */
	legacyWords?: string[];
}

/** Where things live in the target project. Everything path-shaped in the core goes through this. */
export interface TargetLayout {
	/** Feature directory of one legacy area, relative to the project (e.g. "src/features/invoice"). */
	moduleDir(area: string): string;
	/** Concrete file-shape rules inside one feature dir (fed verbatim to rules generation and task cards). */
	structureDoc: string;
	/**
	 * Problems with the files a unit wrote (paths relative to the project) against structureDoc; empty = fine.
	 * Lines starting with "warning:" are shown, never failed. `ctx` (the gate) says which files are new and which a
	 * tidy task sanctions, so shapes allowed only with a reason (a second file of a kind) can be judged.
	 */
	checkStructure?(files: string[], moduleDir: string, area: string, projectDir: string, ctx?: StructureContext): string[];
	/**
	 * Drift findings of the whole project tree against structureDoc (naming, size cap, one class per responsibility),
	 * one `<project-relative path>: <finding>` per line; `only` limits them to those files. Without `only`, area-wide
	 * findings are anchored at `<moduleDir>/` (several same-kind classes in one area). Folders outside the feature
	 * root and shared dirs are the core's part (it knows the scaffold).
	 */
	checkTree?(projectDir: string, only?: string[]): string[];
	/** Per-file findings that do not depend on the folder layout (size cap, one class per file); `moduleDir`/`area` when the file is in a feature folder. */
	fileFindings?(projectDir: string, file: string, moduleDir?: string, area?: string): string[];
	/** Add-only zones for cross-cutting helpers (reuse, never edit from a feature unit). Trailing slash. */
	sharedDirs: string[];
	/** Where the database lives in the project (schema, entities, migrations, data scripts): the DB lane writes only here. Trailing slash. */
	dataDirs?: string[];
	/** Globs (relative to the project) the tester may write ported tests to, for one module dir. */
	testFileGlobs(moduleDir: string): string[];
	isTestFile(path: string): boolean;
	/** Extensions the target indexer should look at. */
	sourceExtensions: string[];
	/** tree-sitter grammar id for a path, or undefined when the core should not syntax-check it. */
	lang(path: string): string | undefined;
	/** Anti-gaming: a test marked skipped/only/todo. */
	skipMarker: RegExp;
	/** One line for the tester on how to write the interface draft (type system, DTO idiom). */
	interfaceHint: string;
	/** ast-grep `language` ids this stack's source files need; rules written for one are copied for the others. */
	astGrepLanguages?: string[];
	/** One line for the tester on how to write ported tests (file naming, framework). */
	testHint: string;
	/** The comment that marks a kept legacy quirk in code of this stack, e.g. `// LEGACY: <why>`. */
	legacyMarker(why: string): string;
	/** One line on how data access is written in this stack (DTOs, repositories); quoted where a unit touches tables. */
	dataAccessHint?: string;
	/** Directories of the project that are never source (dependencies, build output, tests) for scans. */
	ignoreDirs: string[];
}

/**
 * One decision that nails the target stack down at init (ORM, database, styling, data fetching…).
 * The chosen option contributes its docs and its platform text; answers live in config.target.choices.
 */
export interface StackChoice {
	key: string; // e.g. "orm"
	question: string;
	default: string; // option id
	options: StackChoiceOption[];
}
export interface StackChoiceOption {
	id: string;
	label: string;
	hint?: string;
	/** Official docs to fetch when chosen (added to the adapter's base docs). */
	docs?: Array<{ name: string; url: string }>;
	/** Concern key → platform text, overriding the adapter's defaults when chosen. */
	platform?: Record<string, string>;
	/** Packages the scaffold step adds when chosen (informational for rules; setup installs them). */
	packages?: string[];
	/** Why setup cannot produce this option yet; such options are never offered or recommended. */
	unavailable?: string;
}

export interface TargetAdapter {
	/** Concern key (see FrameworkConcern) → what this platform provides for it. Missing key = "review". */
	platform?: Record<string, string>;
	/** Decisions asked at init; see StackChoice. */
	stackChoices?: StackChoice[];
	id: string;
	/** Which surface this stack owns: placement sends ui units to the first "ui" stack, the rest to the "server" one. */
	role: "server" | "ui";
	/** Sub-directory of the target repo this stack lives in when several stacks share one repo (e.g. "api", "web"). */
	subdir: string;
	/** A project already built and tested for this stack (generated adapters): setup moves it into place instead of building again. */
	seedProject?: string;
	layout: TargetLayout;
	/** The framework's own feature-folder convention, proposed at onboarding; the confirmed answer is the stack's layout.json. */
	layoutRules?: import("../rules/layout-rules.ts").LayoutRules;
	toolchain: TargetToolchain;
	/** Other names users and docs use for this stack (lowercase), e.g. "nest". */
	aliases?: string[];
	/** Index one target file's exports for `target_lookup`/`shared_lookup`. Omit to disable target indexing. */
	indexFile?(root: string, relPath: string): Promise<TargetSymbol[]>;
	/**
	 * Language-specific diagnosis of a failed gate step (e.g. TS2307 "cannot find module"): which file is at
	 * fault and what fixes it. Undefined = no rule matched (the orchestrator asks a model).
	 */
	diagnose?(projectDir: string, failedStep: string, output: string, isTestFile: (p: string) => boolean, expectedPackages: string[]): Diagnosis | undefined;
	/** A minimal test file proving the toolchain works on a fresh project (setup probe). */
	probeTest?(projectDir: string): { path: string; content: string };
	/** Problems where the bootstrapped project does not match the stack choices (empty = consistent). */
	verifyChoices?(projectDir: string, chosen: Array<{ key: string; id: string; packages?: string[] }>): ChoiceProblem[];
	/** Facts read from the project config that agents must respect (module resolution, strict flags…). */
	projectNotes?(root: string): string[];
	detect(root: string): Promise<{ confidence: number; version?: string }>;
	/** Create the empty target project if missing. */
	/** Offline fallback only: setup asks the setup model to create the project (scaffoldHint says how the official generator is used). */
	scaffoldProject(root: string): Promise<void>;
	/** How the project is created with the stack's official tools, for the setup model (it checks --help for the installed version). */
	scaffoldHint?: string;
	build(root: string): { cmd: string; args: string[] };
	lint(root: string, files: string[]): { cmd: string; args: string[] };
	test(root: string, relatedFiles: string[]): { cmd: string; args: string[] };
	/** Paths the implementer may never write (protected). */
	protectedGlobs: string[];
	/** Registration files generated from the ledger, never agent-edited. */
	generatedFiles: string[];
	/**
	 * Rewrite the registration/wiring files from what exists in the project (and the ledger) after a unit lands.
	 * Stack-specific (Nest: app.module.ts imports; React: routes; Django: urls.py). Returns changed paths; the
	 * scheduler commits them. Must be idempotent and must never touch agent-owned files.
	 */
	generateRegistration?(root: string, ctx: { ledger: import("../ledger/db.ts").Ledger }): Promise<string[]>;
	/** Pattern kinds this target produces, used by pattern_examples. */
	patternKinds: string[];
	docs: Array<{ name: string; url: string }>;
}

/** What the environment doctor concluded about a failed gate step. */
export interface Diagnosis {
	/** retest = the tests are wrong (tester rewrites them); reimplement = the code is wrong; fix = a setup change only a human (or setup) may make; unknown */
	action: "retest" | "reimplement" | "fix" | "unknown";
	/** one sentence for the log and the question */
	summary: string;
	/** exact shell command for `fix` (run in the target project) */
	command?: string;
	/** instruction appended to the next tester/implementer prompt */
	note?: string;
	/** rule = certain (deterministic match); model = a model's reading */
	by: "rule" | "model";
}

/** A mismatch between the bootstrapped project and the stack choices. */
export interface ChoiceProblem {
	text: string;
	/** true = every unit's gate would fail the same way (a run must not start); false = only units using it */
	everyUnit: boolean;
	/** exact command that fixes it, when known */
	fix?: string;
}

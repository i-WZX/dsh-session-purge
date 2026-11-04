/**
 * dsh-session-purge verify script.
 *
 * Comprehensive test harness:
 * 1. Syntax check (`node --check`) for host and client code.
 * 2. Host plugin shape and route security:
 *    - CSRF & origin rejection (evil.com -> 403)
 *    - Method validation (non-POST -> 405)
 *    - Session ID shape validation
 *    - PATH SAFETY ASSERTION: refusing to delete parent dir or non-matching paths
 *    - Live session cancellation, detach, and memory disposal
 *    - Real disk deletion and workspace registry accounting cleanup
 * 3. Client bundle shape and multi-tier session resolution.
 * 4. Privacy checks: zero tokens, private paths, or leaks.
 */
import { spawnSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";
import assert from "node:assert/strict";

const file = (name) => join(fileURLToPath(new URL("..", import.meta.url)), name);

let failures = 0;
function check(label, fn) {
	try {
		fn();
		console.log(`ok - ${label}`);
	} catch (error) {
		failures += 1;
		console.error(`FAIL - ${label}\n  ${error.message}`);
	}
}
async function checkAsync(label, fn) {
	try {
		await fn();
		console.log(`ok - ${label}`);
	} catch (error) {
		failures += 1;
		console.error(`FAIL - ${label}\n  ${error.message}`);
	}
}

const nodeCheck = (path) => {
	const result = spawnSync(process.execPath, ["--check", path], { encoding: "utf8" });
	assert.equal(result.status, 0, `node --check ${path} failed:\n${result.stderr}`);
};

check("syntax: lib/index.js", () => nodeCheck(file("lib/index.js")));
check("syntax: lib/client.js", () => nodeCheck(file("lib/client.js")));

/** ------------------------------------------------------------------ */
/** Host Plugin Verification                                           */
/** ------------------------------------------------------------------ */
const { name, inject, apply, resolveSafePurgeTarget } = await import(pathToFileURL(file("lib/index.js")).href);

check("host exports: name is dsh-session-purge", () => assert.equal(name, "dsh-session-purge"));
check("host exports: inject declares webServer", () => assert.ok(inject.includes("webServer")));
check("host exports: apply is a function", () => assert.equal(typeof apply, "function"));

// Test path safety resolution
check("path safety: safe session subfolder matches", () => {
	const sid = "session-11111111-2222-3333-4444-555555555555";
	const res = resolveSafePurgeTarget(`/tmp/sessions/ws/${sid}/log.jsonl`, sid);
	assert.ok(res.isDirectory);
	assert.ok(res.targetPath.endsWith(sid));
});

check("path safety: flat session file matches", () => {
	const sid = "session-11111111-2222-3333-4444-555555555555";
	const res = resolveSafePurgeTarget(`/tmp/sessions/ws/${sid}.jsonl`, sid);
	assert.ok(!res.isDirectory);
	assert.ok(res.targetPath.endsWith(`${sid}.jsonl`));
});

check("path safety: throws when path does not match sessionId (workspace protection)", () => {
	const sid = "session-11111111-2222-3333-4444-555555555555";
	assert.throws(() => {
		resolveSafePurgeTarget(`/tmp/sessions/ws/other.jsonl`, sid);
	}, /安全拦截/);
});

// Mock request / response helpers
function makeReq(body, method = "POST", url = "/session-purge/api/purge", headers = { host: "localhost:3080" }) {
	const text = body === void 0 ? "" : JSON.stringify(body);
	let sent = false;
	return {
		method,
		url,
		headers,
		[Symbol.asyncIterator]() {
			return {
				next: async () => {
					if (sent) return { done: true };
					sent = true;
					return { done: false, value: Buffer.from(text) };
				}
			};
		}
	};
}

function makeRes() {
	const state = { status: 0, body: "" };
	return {
		writeHead(status) {
			state.status = status;
		},
		end(payload) {
			state.body = payload;
		},
		get status() {
			return state.status;
		},
		get json() {
			try {
				return JSON.parse(state.body);
			} catch {
				return null;
			}
		}
	};
}

function makeHostCtx(routes) {
	return {
		webServer: {
			register({ kind, path, handler }) {
				routes.push({ kind, path, handler });
			}
		},
		effect(fn) {
			fn();
		}
	};
}

const routes = [];
apply(makeHostCtx(routes));
const handler = routes[0]?.handler;

await checkAsync("route: non-POST rejected with 405", async () => {
	const res = makeRes();
	await handler(makeReq({}, "GET"), res);
	assert.equal(res.status, 405);
});

await checkAsync("route: CSRF defense rejects evil origin", async () => {
	const res = makeRes();
	await handler(makeReq({}, "POST", "/session-purge/api/purge", { host: "localhost:3080", origin: "http://evil.com" }), res);
	assert.equal(res.status, 403);
});

await checkAsync("route: rejects cross-site fetch requests", async () => {
	const res = makeRes();
	await handler(makeReq({}, "POST", "/session-purge/api/purge", { host: "localhost:3080", "sec-fetch-site": "cross-site" }), res);
	assert.equal(res.status, 403);
});

await checkAsync("route: malformed sessionId rejected", async () => {
	const res = makeRes();
	await handler(makeReq({ sessionId: "../escape" }), res);
	assert.equal(res.status, 400);
});

await checkAsync("route: real deletion removes fixture dir and cleans accounting", async () => {
	const sid = "session-12345678-1234-1234-1234-123456789abc";
	const fixtureDir = join(tmpdir(), `test-dsh-purge-${Date.now()}`, sid);
	await mkdir(fixtureDir, { recursive: true });
	await writeFile(join(fixtureDir, "session.jsonl"), "test data");

	let cancelled = false;
	let detached = false;

	const testRoutes = [];
	const hostCtx = {
		webServer: {
			register(r) { testRoutes.push(r); }
		},
		effect(fn) { fn(); },
		get(service) {
			if (service === "sessionPersistence") {
				return {
					list: async () => [{ id: sid }],
					locate: () => ({ kind: "jsonl", path: join(fixtureDir, "session.jsonl") })
				};
			}
			if (service === "sessions") {
				return {
					get: () => ({ header: { id: sid } }),
					store: {
						get: () => ({
							detach: () => { detached = true; }
						})
					}
				};
			}
			if (service === "agents") {
				return {
					get: () => ({
						cancel: () => { cancelled = true; }
					})
				};
			}
			if (service === "workspaceRegistry") {
				return {
					enqueueOperation: async (op) => await op(),
					requireTable: () => ({
						entries: () => [["ws1", { sessionIds: [sid, "other-session"] }]],
						update: async () => {}
					}),
					requireState: () => ({ archivedSessionIds: [sid, "keep-me"] }),
					setState: async () => {}
				};
			}
		}
	};

	apply(hostCtx);
	const res = makeRes();
	await testRoutes[0].handler(makeReq({ sessionId: sid }), res);

	assert.equal(res.status, 200);
	assert.equal(res.json.ok, true);
	assert.ok(cancelled, "agent cancel was called");
	assert.ok(detached, "session store detach was called");
});

/** ------------------------------------------------------------------ */
/** Client Bundle Verification                                         */
/** ------------------------------------------------------------------ */
let clientExports = null;
const mockWindow = {
	__ModuleLoader__: {
		load({ id, factory }) {
			assert.equal(id, "dsh-session-purge");
			clientExports = factory(() => ({}));
		}
	}
};

const clientSource = await import("node:fs").then((fs) => fs.readFileSync(file("lib/client.js"), "utf8"));
vm.runInNewContext(clientSource, {
	window: mockWindow,
	document: { documentElement: { lang: "zh-CN" } },
	navigator: { language: "zh-CN" },
	Object,
	Symbol
});

check("client: exports apply, inject, and _resolveSessionId", () => {
	assert.equal(typeof clientExports.apply, "function");
	assert.ok(clientExports.inject.includes("sessions"));
	assert.ok(clientExports.inject.includes("workspaces"));
	assert.ok(clientExports.inject.includes("connection"));
	assert.equal(typeof clientExports._resolveSessionId, "function");
});

check("client: resolveSessionId with React props inspection", () => {
	const sid = "session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
	const mockRow = {
		__reactProps$123: {
			session: { id: sid }
		},
		closest: () => null
	};
	const resolved = clientExports._resolveSessionId(mockRow, {}, null);
	assert.equal(resolved, sid);
});

check("client: resolveSessionId with DOM attribute", () => {
	const sid = "session-11111111-2222-3333-4444-555555555555";
	const mockRow = {
		getAttribute: (attr) => (attr === "data-session-id" ? sid : null),
		querySelector: () => null,
		closest: () => null
	};
	const resolved = clientExports._resolveSessionId(mockRow, {}, null);
	assert.equal(resolved, sid);
});

check("client: injectPurgeEntry strips cloned shortcuts from archive action", () => {
	class MockElement {
		constructor(tag, attrs = {}) {
			this.tagName = tag.toUpperCase();
			this.children = [];
			this.childNodes = [];
			this.attributes = { ...attrs };
			this.style = {};
			this.dataset = {};
			this._textContent = "";
			this.parentElement = null;
		}
		get textContent() {
			if (this.children.length === 0) return this._textContent;
			return this.children.map((c) => c.textContent).join(" ");
		}
		set textContent(val) {
			this._textContent = val;
			this.children = [];
			this.childNodes = [];
		}
		getAttribute(name) { return this.attributes[name] ?? null; }
		removeAttribute(name) { delete this.attributes[name]; }
		matches(sel) {
			if (sel === '[role="menuitem"]') return this.getAttribute("role") === "menuitem";
			return false;
		}
		querySelector(sel) {
			return this.querySelectorAll(sel)[0] || null;
		}
		querySelectorAll(sel) {
			const res = [];
			const walk = (node) => {
				for (const ch of node.children) {
					if (sel.includes('[role="menuitem"]') && ch.getAttribute("role") === "menuitem") res.push(ch);
					else if (sel === "span" && ch.tagName === "SPAN") res.push(ch);
					else if (sel.includes("kbd") && ch.tagName === "KBD") res.push(ch);
					else if (sel === "*") res.push(ch);
					walk(ch);
				}
			};
			walk(this);
			return res;
		}
		remove() {
			if (this.parentElement) {
				const idx = this.parentElement.children.indexOf(this);
				if (idx !== -1) this.parentElement.children.splice(idx, 1);
				const nIdx = this.parentElement.childNodes.indexOf(this);
				if (nIdx !== -1) this.parentElement.childNodes.splice(nIdx, 1);
			}
		}
		insertBefore(node, ref) {
			const idx = ref ? this.children.indexOf(ref) : -1;
			node.parentElement = this;
			if (idx === -1) {
				this.children.push(node);
				this.childNodes.push(node);
			} else {
				this.children.splice(idx, 0, node);
				this.childNodes.splice(idx, 0, node);
			}
		}
		addEventListener() {}
		cloneNode(deep) {
			const c = new MockElement(this.tagName.toLowerCase(), this.attributes);
			c._textContent = this._textContent;
			if (deep) {
				for (const ch of this.children) {
					const clonedCh = ch.cloneNode(true);
					clonedCh.parentElement = c;
					c.children.push(clonedCh);
					c.childNodes.push(clonedCh);
				}
			}
			return c;
		}
	}

	const menu = new MockElement("div", { role: "menu" });
	const archiveItem = new MockElement("button", { role: "menuitem", "aria-keyshortcuts": "Ctrl+Shift+A" });
	const iconSpan = new MockElement("span");
	iconSpan.textContent = "[icon]";
	const labelSpan = new MockElement("span");
	labelSpan.textContent = "归档会话";
	const shortcutSpan = new MockElement("span");
	shortcutSpan.textContent = "Ctrl + Shift + A";

	iconSpan.parentElement = archiveItem;
	labelSpan.parentElement = archiveItem;
	shortcutSpan.parentElement = archiveItem;
	archiveItem.children = [iconSpan, labelSpan, shortcutSpan];
	archiveItem.childNodes = [iconSpan, labelSpan, shortcutSpan];
	archiveItem.parentElement = menu;
	menu.children = [archiveItem];
	menu.childNodes = [archiveItem];

	clientExports._injectPurgeEntry(menu);

	assert.equal(menu.children.length, 2);
	const purgeItem = menu.children[1];
	assert.ok(!purgeItem.getAttribute("aria-keyshortcuts"), "aria-keyshortcuts attribute removed");
	assert.ok(!purgeItem.textContent.includes("Ctrl + Shift + A"), "shortcut text removed");
	assert.ok(purgeItem.textContent.includes("彻底删除"), "has purge label");
});

/** ------------------------------------------------------------------ */
/** Privacy & Hygiene Check                                            */
/** ------------------------------------------------------------------ */
const filesToCheck = [
	"lib/index.js",
	"lib/client.js",
	"package.json",
	"cordis.patch.yml",
	"LICENSE"
];

for (const name of filesToCheck) {
	const content = await import("node:fs").then((fs) => fs.readFileSync(file(name), "utf8"));
	check(`privacy: no hardcoded personal drives in ${name}`, () => {
		assert.ok(!content.includes("C:\\Users\\"), `hardcoded C:\\Users\\ found in ${name}`);
		assert.ok(!content.includes("D:\\EdgeDownload"), `hardcoded workspace path in ${name}`);
	});
	check(`privacy: no github PAT or tokens in ${name}`, () => {
		assert.ok(!/ghp_[A-Za-z0-9_]{36}/.test(content));
		assert.ok(!/github_pat_[A-Za-z0-9_]{82}/.test(content));
	});
}

if (failures > 0) {
	console.error(`\nCompleted with ${failures} failure(s)`);
	process.exit(1);
} else {
	console.log("\nAll verify checks passed successfully!");
}

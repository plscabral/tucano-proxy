/**
 * Tucano Proxy extension for Pi (pi.dev).
 *
 * Pi has no native MCP support, so this extension talks to Tucano's MCP
 * Streamable-HTTP endpoint (JSON-RPC 2.0, stateless) directly and exposes
 * each Tucano tool to Pi via pi.registerTool().
 *
 * Config resolution: TUCANO_MCP_URL / TUCANO_MCP_TOKEN env vars first,
 * then ~/.pi/agent/tucano.json ({ "url", "token" }).
 *
 * If Tucano is closed at startup, tools/list fails and we fall back to the
 * bundled tucano-tools.json snapshot so Pi still registers all tools and
 * never shows a startup error. Failures surface only when a tool actually
 * runs, as a plain text result the LLM can relay to the user.
 */
import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

interface TucanoToolSpec {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
}

interface TucanoConfig {
	url: string;
	token: string;
	binary?: string;
	autolaunch?: boolean;
	dataDir?: string;
	session?: string;
}

const DEFAULT_URL = "http://127.0.0.1:7878/mcp";
const CONFIG_PATH = join(homedir(), ".pi", "agent", "tucano.json");
const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_PATH = join(EXTENSION_DIR, "tucano-tools.json");

const NOT_RUNNING_MESSAGE =
	"Tucano Proxy is unavailable. Start the configured CLI session or open the desktop app with MCP enabled, then try again.";
const UNAUTHORIZED_MESSAGE = "Tucano Proxy rejected this token. Reinstall the integration from Settings > MCP.";

function loadConfig(): TucanoConfig {
	const envUrl = process.env.TUCANO_MCP_URL;
	const envToken = process.env.TUCANO_MCP_TOKEN;

	let fileUrl: string | undefined;
	let fileToken: string | undefined;
	let extra: Partial<TucanoConfig> = {};
	const configPath = existsSync(join(EXTENSION_DIR, "config.json")) ? join(EXTENSION_DIR, "config.json") : CONFIG_PATH;
	if (existsSync(configPath)) {
		try {
			const parsed = JSON.parse(readFileSync(configPath, "utf8")) as Partial<TucanoConfig>;
			extra = parsed;
			fileUrl = parsed.url;
			fileToken = parsed.token;
		} catch {
			// Malformed config file: fall through to defaults/env only.
		}
	}

	return {
		binary: extra.binary,
		autolaunch: extra.autolaunch,
		dataDir: process.env.TUCANO_MCP_DATA_DIR || extra.dataDir,
		session: process.env.TUCANO_MCP_SESSION || extra.session,
		url: envUrl || fileUrl || DEFAULT_URL,
		token: envToken || fileToken || "",
	};
}

function loadSnapshotTools(): TucanoToolSpec[] {
	try {
		return JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8")) as TucanoToolSpec[];
	} catch {
		return [];
	}
}

async function rpc(
	config: TucanoConfig,
	method: string,
	params: unknown,
	timeoutMs: number,
): Promise<{ status: number; body: any }> {
	if (method === "tools/call" && config.binary) {
		return new Promise((resolve, reject) => {
			const child = spawn(config.binary!, ["mcp-stdio"], {
				env: {
					...process.env,
					TUCANO_MCP_URL: config.url,
					TUCANO_MCP_TOKEN: config.token,
					TUCANO_MCP_AUTOLAUNCH: config.autolaunch ? "1" : "0",
					TUCANO_MCP_DATA_DIR: config.dataDir,
					TUCANO_MCP_SESSION: config.session,
				},
				stdio: ["pipe", "pipe", "ignore"],
			});
			let output = "";
			const timer = setTimeout(() => { child.kill(); reject(new Error("Tucano MCP request timed out")); }, timeoutMs);
			child.stdout.on("data", (chunk) => { output += chunk.toString(); });
			child.stdin.on("error", () => {});
			child.on("error", (error) => { clearTimeout(timer); reject(error); });
			child.on("close", () => {
				clearTimeout(timer);
				try { resolve({ status: 200, body: JSON.parse(output.trim()) }); } catch (error) { reject(error); }
			});
			child.stdin.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) + "\n");
		});
	}
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	// Belt and suspenders: some fetch implementations don't reliably cancel a
	// still-connecting request on abort(), so race a hard timeout as well —
	// startup/tool calls must never hang, only fail fast with a clear message.
	const hardTimeout = new Promise<never>((_, reject) => {
		setTimeout(() => reject(new Error("Tucano MCP request timed out")), timeoutMs + 250);
	});
	try {
		const res = await Promise.race([
			fetch(config.url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${config.token}`,
				},
				body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params: params ?? {} }),
				signal: controller.signal,
			}),
			hardTimeout,
		]);
		let body: any = null;
		try {
			body = await res.json();
		} catch {
			body = null;
		}
		return { status: res.status, body };
	} finally {
		clearTimeout(timer);
	}
}

function extractResultText(result: unknown): string {
	const content = (result as { content?: unknown } | null)?.content;
	if (Array.isArray(content)) {
		const text = content
			.map((part) => (part && typeof part === "object" && typeof (part as any).text === "string" ? (part as any).text : ""))
			.join("\n")
			.trim();
		if (text) return text;
	}
	return JSON.stringify(result);
}

async function discoverTools(config: TucanoConfig): Promise<TucanoToolSpec[] | null> {
	try {
		const { status, body } = await rpc(config, "tools/list", {}, 2000);
		if (status === 200 && Array.isArray(body?.result?.tools)) {
			return body.result.tools as TucanoToolSpec[];
		}
		return null;
	} catch {
		return null;
	}
}

export default async function (pi: ExtensionAPI) {
	const config = loadConfig();
	const tools = (await discoverTools(config)) ?? loadSnapshotTools();

	for (const tool of tools) {
		pi.registerTool({
			name: tool.name,
			label: tool.name,
			description: tool.description,
			promptSnippet: tool.description,
			parameters: tool.inputSchema as any,
			async execute(_toolCallId, params) {
				const config = loadConfig();
				let response: { status: number; body: any };
				try {
					response = await rpc(config, "tools/call", { name: tool.name, arguments: params ?? {} }, 65000);
				} catch {
					return { content: [{ type: "text", text: NOT_RUNNING_MESSAGE }] };
				}

				if (response.status === 401) {
					return { content: [{ type: "text", text: UNAUTHORIZED_MESSAGE }] };
				}

				const rpcError = response.body?.error;
				if (rpcError) {
					return { content: [{ type: "text", text: rpcError.message || "Tucano Proxy returned an error." }] };
				}

				return { content: [{ type: "text", text: extractResultText(response.body?.result) }] };
			},
		});
	}
}

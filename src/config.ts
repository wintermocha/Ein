import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { einCommand } from "./cli-invocation";

export class SetupError extends Error {
  override readonly name = "SetupError";
}

const channelId = z.string().regex(/^[CDG][A-Z0-9]+$/);
const watchChannelId = z.string().regex(/^[CG][A-Z0-9]+$/);
const userId = z.string().regex(/^[UW][A-Z0-9]+$/);
const runnerSchema = z.enum(["omo", "claude", "codex"]);
const projectId = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
const projectSchema = z.strictObject({
  path: z.string().min(1),
  channels: z.array(watchChannelId).default([]),
});
// Zod records omit these keys. Reject them so a configured project cannot silently disappear.
const projectsSchema = z.unknown().refine(value => value !== null && typeof value === "object"
  && !Object.hasOwn(value, "__proto__") && !Object.hasOwn(value, "constructor"))
  .pipe(z.record(projectId, projectSchema));
export type Runner = z.infer<typeof runnerSchema>;
export type Project = z.infer<typeof projectSchema>;

const configSchema = z.strictObject({
  team: z.string().regex(/^T[A-Z0-9]+$/),
  appId: z.string().regex(/^A[A-Z0-9]+$/),
  botUser: userId,
  ownerUser: userId,
  ownerDm: z.string().regex(/^D[A-Z0-9]+$/).optional(),
  watchChannels: z.array(watchChannelId),
  blockedUsers: z.array(userId).default([]),
  otherUserReplyRate: z.record(channelId, z.number().min(0).max(1)).default({}),
  botTokenFile: z.string().min(1).optional(),
  appTokenFile: z.string().min(1).optional(),
  stateFile: z.string().min(1).default("~/.local/state/ein/inbound.sqlite"),
  herdrWorkspace: z.string().trim().min(1).regex(/^[^\x00-\x1f\x7f]+$/u).optional(),
  runner: runnerSchema.optional(),
  projects: projectsSchema.default({}),
});

export type Config = z.infer<typeof configSchema>;

function pathFrom(base: string, path: string): string {
  if (path === "~") return homedir();
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : resolve(base, path);
}

function readConfig(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new SetupError(`설정 파일이 없습니다. ${einCommand} setup으로 Slack을 연결하세요.`);
    }
    throw new SetupError("Could not read config as a JSON file.");
  }
}

export function loadConfig(file: string): Config {
  const path = pathFrom(process.cwd(), file);
  const parsed = configSchema.safeParse(readConfig(path));
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path[0];
    throw new SetupError(`Invalid config: ${typeof field === "string" ? field : "unexpected or missing field"}.`);
  }
  const config = parsed.data;
  const relative = (value: string) => pathFrom(dirname(path), value);
  const projects: Record<string, Project> = Object.create(null);
  const channels = new Set<string>();
  for (const [id, project] of Object.entries(config.projects)) {
    for (const channel of project.channels) {
      if (channels.has(channel)) throw new SetupError("Invalid config: projects.channels must be unique.");
      channels.add(channel);
    }
    projects[id] = { ...project, path: relative(project.path) };
  }
  return { ...config, projects, stateFile: relative(config.stateFile),
    botTokenFile: config.botTokenFile && relative(config.botTokenFile),
    appTokenFile: config.appTokenFile && relative(config.appTokenFile) };
}

export function requireOrchestration(config: Config): Runner {
  if (!config.runner) throw new SetupError("Set runner to omo, claude or codex for orchestration.");
  for (const project of Object.values(config.projects)) {
    try {
      accessSync(project.path, constants.X_OK);
      if (statSync(project.path).isDirectory()) continue;
    } catch {
      // Filesystem errors may include the private project path.
    }
    throw new SetupError("Invalid config: projects.path must be an accessible directory.");
  }
  for (const executable of [config.runner, "herdr"]) {
    if (!Bun.which(executable)) throw new SetupError(`Missing executable on PATH: ${executable}.`);
  }
  return config.runner;
}

function token(kind: "app" | "bot", file?: string): string {
  const env = kind === "app" ? "EIN_APP_TOKEN" : "EIN_BOT_TOKEN";
  let value = process.env[env]?.trim();
  if (!value && file) {
    try {
      value = readFileSync(file, "utf8").trim();
    } catch {
      throw new SetupError(`Cannot read the configured ${kind} token file.`);
    }
  }
  if (!value || !value.startsWith(kind === "app" ? "xapp-" : "xoxb-") || /\s/.test(value)) {
    throw new SetupError(`Configure ${env} or ${kind}TokenFile with a Slack ${kind} token.`);
  }
  return value;
}

export function credentials(config: Config) {
  return { appToken: token("app", config.appTokenFile), botToken: token("bot", config.botTokenFile) };
}

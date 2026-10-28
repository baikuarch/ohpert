import fs from 'node:fs';
import os from 'node:os';
import type { AiSettings, CommandSettings } from '../types.js';
import { SETTINGS_FILE } from '../config.js';

interface StoredSettings {
  ai?: Partial<AiSettings>;
  commands?: Partial<CommandSettings>;
  workspaceRoots?: string[];
}

const FALLBACK_BASE_URL = 'https://api.openai.com/v1';
const FALLBACK_MODEL = 'gpt-4o-mini';

const DEFAULTS: StoredSettings = {
  ai: {
    apiKey: '',
    planningModel: '',
    codingModel: '',
    reviewModel: '',
    temperature: 0.2,
    maxTokens: 16000,
    maxTurns: 28,
  },
  commands: {
    test: '',
    build: '',
    lint: '',
  },
  workspaceRoots: [os.homedir()],
};

function read(): StoredSettings {
  try {
    const raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
    const parsed = JSON.parse(raw) as StoredSettings;
    return {
      ai: { ...DEFAULTS.ai, ...(parsed.ai || {}) },
      commands: { ...DEFAULTS.commands, ...(parsed.commands || {}) },
      workspaceRoots: parsed.workspaceRoots?.length ? parsed.workspaceRoots : DEFAULTS.workspaceRoots,
    };
  } catch {
    return { ...DEFAULTS, ai: { ...DEFAULTS.ai }, commands: { ...DEFAULTS.commands } };
  }
}

function write(next: StoredSettings) {
  // settings.json may contain the LLM API key: keep it private to the owner.
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(SETTINGS_FILE, 0o600);
  } catch {
    /* best effort on filesystems without POSIX permissions */
  }
}

export function getRawSettings() {
  return read();
}

/** Tighten permissions on an existing settings file (may predate the 0600 write). */
export function secureSettingsFile() {
  try {
    fs.chmodSync(SETTINGS_FILE, 0o600);
  } catch {
    /* missing file or no POSIX permissions */
  }
}

export function saveAiSettings(patch: Partial<AiSettings>) {
  const cur = read();
  cur.ai = { ...cur.ai, ...patch };
  write(cur);
  return cur.ai;
}

export function saveCommandSettings(patch: Partial<CommandSettings>) {
  const cur = read();
  cur.commands = { ...cur.commands, ...patch };
  write(cur);
  return cur.commands;
}

export function saveWorkspaceRoots(roots: string[]) {
  const cur = read();
  cur.workspaceRoots = roots;
  write(cur);
  return cur.workspaceRoots;
}

/**
 * Resolution order: explicit app settings -> environment -> built-in default.
 * Env wins only when app settings leave apiKey/url empty, so an unauthenticated
 * local gateway keeps working out of the box.
 */
export function resolveAiSettings(): AiSettings {
  const stored = read().ai || {};
  const envBase = process.env.OHPERT_LLM_BASE_URL || process.env.OPENAI_BASE_URL || '';
  const envKey = process.env.OHPERT_LLM_API_KEY || process.env.OPENAI_API_KEY || '';
  const envModel = process.env.OHPERT_LLM_MODEL || '';

  const apiKey = stored.apiKey?.trim() || envKey;
  const baseURL = (stored.baseURL?.trim() || envBase || FALLBACK_BASE_URL).replace(/\/+$/, '');
  const model = stored.model?.trim() || envModel || FALLBACK_MODEL;

  let source: AiSettings['source'] = 'none';
  if (stored.apiKey?.trim()) source = 'settings';
  else if (envKey) source = 'env';
  else source = 'settings'; // local gateway may not need a key

  return {
    baseURL,
    apiKey,
    model,
    planningModel: stored.planningModel?.trim() || model,
    codingModel: stored.codingModel?.trim() || model,
    reviewModel: stored.reviewModel?.trim() || model,
    temperature: stored.temperature ?? 0.2,
    maxTokens: stored.maxTokens ?? 16000,
    maxTurns: stored.maxTurns ?? 28,
    source,
  };
}

export function publicAiSettings() {
  const ai = resolveAiSettings();
  return {
    ...ai,
    apiKey: ai.apiKey ? `${ai.apiKey.slice(0, 4)}••••${ai.apiKey.slice(-4)}` : '',
    hasApiKey: Boolean(ai.apiKey),
  };
}

import { readFile } from 'fs/promises';
import { resolve } from 'path';
import { logger } from './logger.js';

export type TransportConfigStdio = {
  type: 'stdio';
  name?: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  active?: boolean;
  installDirectory?: string;
  installCommands?: string[];
}

export type TransportConfigSSE = {
  type: 'sse';
  name?: string;
  url: string;
  active?: boolean;
  apiKey?: string;
  bearerToken?: string;
}

export type TransportConfigHTTP = {
  type: 'http';
  name?: string;
  url: string;
  active?: boolean;
  apiKey?: string;
  bearerToken?: string;
}

export type TransportConfig = (TransportConfigStdio | TransportConfigSSE | TransportConfigHTTP) & { name?: string, active?: boolean, type: 'stdio' | 'sse' | 'http' };

export interface ProxySettings {
  retrySseToolCall?: boolean;
  sseToolCallMaxRetries?: number;
  sseToolCallRetryDelayBaseMs?: number;
  retryHttpToolCall?: boolean;
  httpToolCallMaxRetries?: number;
  httpToolCallRetryDelayBaseMs?: number;
  retryStdioToolCall?: boolean;
  stdioToolCallMaxRetries?: number;
  stdioToolCallRetryDelayBaseMs?: number;
}

export const DEFAULT_SERVER_TOOLNAME_SEPERATOR = '__';
export const SERVER_TOOLNAME_SEPERATOR_ENV_VAR = 'SERVER_TOOLNAME_SEPERATOR';

export interface Config {
  mcpServers: Record<string, TransportConfig>;
  proxy?: ProxySettings;
  serverToolnameSeparator?: string;
}

export interface ToolSettings {
  enabled: boolean;
  exposedName?: string;
  exposedDescription?: string;
}

export interface ToolConfig {
  tools: Record<string, ToolSettings>;
}

export function isSSEConfig(config: TransportConfig): config is TransportConfigSSE {
  return config.type === 'sse';
}

export function isStdioConfig(config: TransportConfig): config is TransportConfigStdio {
  return config.type === 'stdio';
}

export function isHttpConfig(config: TransportConfig): config is TransportConfigHTTP {
  return config.type === 'http';
}

export const loadConfig = async (): Promise<Config> => {
  const defaultEnvProxySettings = {
    retrySseToolCall: true,
    sseToolCallMaxRetries: 2,
    sseToolCallRetryDelayBaseMs: 300,
    retryHttpToolCall: true,
    httpToolCallMaxRetries: 2,
    httpToolCallRetryDelayBaseMs: 300,
    retryStdioToolCall: true,
    stdioToolCallMaxRetries: 2,
    stdioToolCallRetryDelayBaseMs: 300,
  };

  let serverToolnameSeparator = DEFAULT_SERVER_TOOLNAME_SEPERATOR;
  const envSeparator = process.env[SERVER_TOOLNAME_SEPERATOR_ENV_VAR];
  const separatorRegex = /^[a-zA-Z0-9_-]+$/;

  if (envSeparator !== undefined && envSeparator.trim() !== '') {
    const trimmedSeparator = envSeparator.trim();
    if (trimmedSeparator.length >= 2 && separatorRegex.test(trimmedSeparator)) {
      serverToolnameSeparator = trimmedSeparator;
      logger.log(`Using server toolname separator from environment variable ${SERVER_TOOLNAME_SEPERATOR_ENV_VAR}: "${serverToolnameSeparator}"`);
    } else {
      logger.warn(`Invalid value for environment variable ${SERVER_TOOLNAME_SEPERATOR_ENV_VAR}: "${envSeparator}". Using default: "${DEFAULT_SERVER_TOOLNAME_SEPERATOR}".`);
      serverToolnameSeparator = DEFAULT_SERVER_TOOLNAME_SEPERATOR;
    }
  } else {
    serverToolnameSeparator = DEFAULT_SERVER_TOOLNAME_SEPERATOR;
  }

  try {
    const configPath = resolve(process.cwd(), 'config', 'mcp_server.json');
    console.log(`Attempting to load configuration from: ${configPath}`);
    const fileContents = await readFile(configPath, 'utf-8');
    const parsedConfig = JSON.parse(fileContents) as Config;

    if (typeof parsedConfig !== 'object' || parsedConfig === null || typeof parsedConfig.mcpServers !== 'object') {
      throw new Error('Invalid config format: mcpServers object not found.');
    }

    parsedConfig.proxy = parsedConfig.proxy || {};

    const sseRetryEnv = process.env.RETRY_SSE_TOOL_CALL;
    parsedConfig.proxy.retrySseToolCall = (sseRetryEnv && sseRetryEnv.trim() !== '') ? sseRetryEnv.toLowerCase() === 'true' : defaultEnvProxySettings.retrySseToolCall;

    const sseMaxRetriesEnv = process.env.SSE_TOOL_CALL_MAX_RETRIES;
    parsedConfig.proxy.sseToolCallMaxRetries = (sseMaxRetriesEnv && !isNaN(parseInt(sseMaxRetriesEnv, 10))) ? parseInt(sseMaxRetriesEnv, 10) : defaultEnvProxySettings.sseToolCallMaxRetries;

    const sseDelayBaseEnv = process.env.SSE_TOOL_CALL_RETRY_DELAY_BASE_MS;
    parsedConfig.proxy.sseToolCallRetryDelayBaseMs = (sseDelayBaseEnv && !isNaN(parseInt(sseDelayBaseEnv, 10))) ? parseInt(sseDelayBaseEnv, 10) : defaultEnvProxySettings.sseToolCallRetryDelayBaseMs;

    const httpRetryEnv = process.env.RETRY_HTTP_TOOL_CALL;
    parsedConfig.proxy.retryHttpToolCall = (httpRetryEnv && httpRetryEnv.trim() !== '') ? httpRetryEnv.toLowerCase() === 'true' : defaultEnvProxySettings.retryHttpToolCall;

    const maxRetriesEnv = process.env.HTTP_TOOL_CALL_MAX_RETRIES;
    parsedConfig.proxy.httpToolCallMaxRetries = (maxRetriesEnv && !isNaN(parseInt(maxRetriesEnv, 10))) ? parseInt(maxRetriesEnv, 10) : defaultEnvProxySettings.httpToolCallMaxRetries;

    const delayBaseEnv = process.env.HTTP_TOOL_CALL_RETRY_DELAY_BASE_MS;
    parsedConfig.proxy.httpToolCallRetryDelayBaseMs = (delayBaseEnv && !isNaN(parseInt(delayBaseEnv, 10))) ? parseInt(delayBaseEnv, 10) : defaultEnvProxySettings.httpToolCallRetryDelayBaseMs;

    const stdioRetryEnv = process.env.RETRY_STDIO_TOOL_CALL;
    parsedConfig.proxy.retryStdioToolCall = (stdioRetryEnv && stdioRetryEnv.trim() !== '') ? stdioRetryEnv.toLowerCase() === 'true' : defaultEnvProxySettings.retryStdioToolCall;

    const stdioMaxRetriesEnv = process.env.STDIO_TOOL_CALL_MAX_RETRIES;
    parsedConfig.proxy.stdioToolCallMaxRetries = (stdioMaxRetriesEnv && !isNaN(parseInt(stdioMaxRetriesEnv, 10))) ? parseInt(stdioMaxRetriesEnv, 10) : defaultEnvProxySettings.stdioToolCallMaxRetries;

    const stdioDelayBaseEnv = process.env.STDIO_TOOL_CALL_RETRY_DELAY_BASE_MS;
    parsedConfig.proxy.stdioToolCallRetryDelayBaseMs = (stdioDelayBaseEnv && !isNaN(parseInt(stdioDelayBaseEnv, 10))) ? parseInt(stdioDelayBaseEnv, 10) : defaultEnvProxySettings.stdioToolCallRetryDelayBaseMs;

    logger.log("Loaded config with final proxy settings (after env overrides):", JSON.stringify(parsedConfig.proxy).slice(1, -1));

    parsedConfig.serverToolnameSeparator = serverToolnameSeparator;

    return parsedConfig;

  } catch (error: any) {
    logger.error(`Error loading config/mcp_server.json: ${error.message}`);

    const proxySettingsFromEnvOrDefaults: ProxySettings = { ...defaultEnvProxySettings };

    logger.log("Using proxy settings from environment/defaults due to mcp_server.json load error:", proxySettingsFromEnvOrDefaults);
    return {
      mcpServers: {},
      proxy: proxySettingsFromEnvOrDefaults,
      serverToolnameSeparator: serverToolnameSeparator,
    };
  }
};


export const loadToolConfig = async (): Promise<ToolConfig> => {
 const defaultConfig: ToolConfig = { tools: {} };
try {
 const configPath = resolve(process.cwd(), 'config', 'tool_config.json');
 logger.log(`Attempting to load tool configuration from: ${configPath}`);
 const fileContents = await readFile(configPath, 'utf-8');
 const parsedConfig = JSON.parse(fileContents) as ToolConfig;

 if (typeof parsedConfig !== 'object' || parsedConfig === null || typeof parsedConfig.tools !== 'object') {
     logger.warn('Invalid tool_config.json format: "tools" object not found or invalid. Using default.');
     return defaultConfig;
 }
 for (const toolKey in parsedConfig.tools) {
     if (typeof parsedConfig.tools[toolKey]?.enabled !== 'boolean') {
          logger.warn(`Invalid setting for tool "${toolKey}" in tool_config.json: 'enabled' is missing or not a boolean. Assuming enabled.`);
     }
 }

 logger.log(`Successfully loaded tool configuration for ${Object.keys(parsedConfig.tools).length} tools.`);
 return parsedConfig;
} catch (error: any) {
  if (error.code === 'ENOENT') {
     logger.log('config/tool_config.json not found. Using default (all tools enabled).');
  } else {
     logger.error(`Error loading config/tool_config.json: ${error.message}`);
     logger.warn('Using default tool configuration (all tools enabled) due to error.');
  }
 return defaultConfig;
}
};

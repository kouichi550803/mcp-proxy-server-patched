import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { DEFAULT_REQUEST_TIMEOUT_MSEC } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  Tool,
  ListToolsResultSchema,
  ListPromptsResultSchema,
  ListResourcesResultSchema,
  ReadResourceResultSchema,
  ListResourceTemplatesRequestSchema,
  ListResourceTemplatesResultSchema,
  ResourceTemplate,
  CompatibilityCallToolResultSchema,
  GetPromptResultSchema,
  McpError
} from "@modelcontextprotocol/sdk/types.js";
import { createClients, ConnectedClient, reconnectSingleClient } from './client.js';
import { logger } from './logger.js';
import { Config, loadConfig, TransportConfig, isSSEConfig, isStdioConfig, isHttpConfig, ToolConfig, loadToolConfig, DEFAULT_SERVER_TOOLNAME_SEPERATOR } from './config.js';
import { z } from 'zod';
import * as eventsource from 'eventsource';

global.EventSource = eventsource.EventSource;

// --- Shared State ---
let currentConnectedClients: ConnectedClient[] = [];
const toolToClientMap = new Map<string, { client: ConnectedClient, toolInfo: Tool }>();
const resourceToClientMap = new Map<string, ConnectedClient>();
const promptToClientMap = new Map<string, ConnectedClient>();
let currentToolConfig: ToolConfig = { tools: {} };
let currentActiveServersConfig: Record<string, TransportConfig> = {};
let currentSeparator: string = DEFAULT_SERVER_TOOLNAME_SEPERATOR;

const defaultProxySettingsFull: Required<NonNullable<Config['proxy']>> = {
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

let currentProxyConfig: Required<NonNullable<Config['proxy']>> = { ...defaultProxySettingsFull };

export const updateBackendConnections = async (newServerConfig: Config, newToolConfig: ToolConfig) => {
    logger.log("Starting update of backend connections...");
    currentToolConfig = newToolConfig;
    currentProxyConfig = {
        ...defaultProxySettingsFull,
        ...(newServerConfig.proxy || {}),
    };
    currentSeparator = newServerConfig.serverToolnameSeparator || DEFAULT_SERVER_TOOLNAME_SEPERATOR;
    logger.log(`Using server toolname separator: "${currentSeparator}"`);

    const activeServersConfigLocal: Record<string, TransportConfig> = {};
    for (const serverKey in newServerConfig.mcpServers) {
        if (Object.prototype.hasOwnProperty.call(newServerConfig.mcpServers, serverKey)) {
            const serverConf = newServerConfig.mcpServers[serverKey];
            const isActive = !(serverConf.active === false || String(serverConf.active).toLowerCase() === 'false');
            if (isActive) {
                activeServersConfigLocal[serverKey] = serverConf;
            } else {
                 logger.log(`Skipping inactive server during update: ${serverKey}`);
            }
        }
    }
    currentActiveServersConfig = activeServersConfigLocal;

    const newClientKeys = new Set(Object.keys(activeServersConfigLocal));
    const currentClientKeys = new Set(currentConnectedClients.map(c => c.name));

    const clientsToRemove = currentConnectedClients.filter(c => !newClientKeys.has(c.name));
    const clientsToKeep = currentConnectedClients.filter(c => newClientKeys.has(c.name));
    const keysToAdd = Object.keys(activeServersConfigLocal).filter(key => !currentClientKeys.has(key));

    if (clientsToRemove.length > 0) {
        await Promise.all(clientsToRemove.map(async ({ name, cleanup }) => {
            try {
                await cleanup();
            } catch (error: any) {
                logger.error(`  Error cleaning up client ${name}: ${error.message}`);
            }
        }));
    }

    let newlyConnectedClients: ConnectedClient[] = [];
    if (keysToAdd.length > 0) {
        const configToAdd: Record<string, TransportConfig> = {};
        keysToAdd.forEach(key => { configToAdd[key] = activeServersConfigLocal[key]; });
        newlyConnectedClients = await createClients(configToAdd);
    }

    currentConnectedClients = [...clientsToKeep, ...newlyConnectedClients];

    toolToClientMap.clear();
    resourceToClientMap.clear();
    promptToClientMap.clear();

    for (const connectedClient of currentConnectedClients) {
        try {
            const result = await connectedClient.client.request({ method: 'tools/list', params: {} }, ListToolsResultSchema);
            if (result.tools && result.tools.length > 0) {
                for (const tool of result.tools) {
                    const qualifiedName = `${connectedClient.name}${currentSeparator}${tool.name}`;
                    const toolSettings = currentToolConfig.tools[qualifiedName];
                    const isEnabled = !toolSettings || toolSettings.enabled !== false;
                    if (isEnabled) {
                        toolToClientMap.set(qualifiedName, { client: connectedClient, toolInfo: tool });
                    }
                }
            }
        } catch (error: any) {
             if (!(error?.name === 'McpError' && error?.code === -32601)) {
                 logger.error(`Error fetching tools from ${connectedClient.name} during map update:`, error?.message || error);
             }
        }
    }

    for (const connectedClient of currentConnectedClients) {
         try {
             const result = await connectedClient.client.request({ method: 'resources/list', params: {} }, ListResourcesResultSchema);
             if (result.resources) {
                 result.resources.forEach(resource => resourceToClientMap.set(resource.uri, connectedClient));
             }
         } catch (error: any) {
              if (!(error?.name === 'McpError' && error?.code === -32601)) {
                  logger.error(`Error fetching resources from ${connectedClient.name} during map update:`, error?.message || error);
              }
         }
    }

    for (const connectedClient of currentConnectedClients) {
         try {
             const result = await connectedClient.client.request({ method: 'prompts/list', params: {} }, ListPromptsResultSchema);
             if (result.prompts) {
                 result.prompts.forEach(prompt => promptToClientMap.set(prompt.name, connectedClient));
             }
         } catch (error: any) {
              if (!(error?.name === 'McpError' && error?.code === -32601)) {
                  logger.error(`Error fetching prompts from ${connectedClient.name} during map update:`, error?.message || error);
              }
         }
    }
    logger.log("Backend connections update finished.");
};

async function refreshBackendConnection(serverKey: string, serverConfig: TransportConfig): Promise<boolean> {
  logger.log(`Attempting to refresh backend connection for server: ${serverKey}`);
  const existingClientIndex = currentConnectedClients.findIndex(c => c.name === serverKey);
  let oldCleanup: (() => Promise<void>) | undefined = undefined;
  let existingConfig: TransportConfig | undefined = currentConnectedClients[existingClientIndex]?.config;

  if (existingClientIndex !== -1 && currentConnectedClients[existingClientIndex]) {
    oldCleanup = currentConnectedClients[existingClientIndex].cleanup;
    existingConfig = currentConnectedClients[existingClientIndex].config;
  } else {
    existingConfig = currentActiveServersConfig[serverKey];
  }

  if (!existingConfig) {
    logger.error(`Configuration for server ${serverKey} not found. Cannot refresh.`);
    return false;
  }
  const configToUse = serverConfig || existingConfig;

  try {
    const reconnectedClientParts = await reconnectSingleClient(serverKey, configToUse, oldCleanup);

    const newConnectedClientEntry: ConnectedClient = {
      ...reconnectedClientParts,
      name: serverKey,
    };

    if (existingClientIndex !== -1) {
      currentConnectedClients[existingClientIndex] = newConnectedClientEntry;
    } else {
      currentConnectedClients.push(newConnectedClientEntry);
    }

    for (const [key, value] of toolToClientMap.entries()) {
      if (value.client.name === serverKey) {
        toolToClientMap.delete(key);
      }
    }
    for (const [key, value] of resourceToClientMap.entries()) {
      if (value.name === serverKey) {
        resourceToClientMap.delete(key);
      }
    }
    for (const [key, value] of promptToClientMap.entries()) {
      if (value.name === serverKey) {
        promptToClientMap.delete(key);
      }
    }

    const connectedClient = newConnectedClientEntry;
    try {
        const result = await connectedClient.client.request({ method: 'tools/list', params: {} }, ListToolsResultSchema);
        if (result.tools && result.tools.length > 0) {
            for (const tool of result.tools) {
                const qualifiedName = `${connectedClient.name}${currentSeparator}${tool.name}`;
                const toolSettings = currentToolConfig.tools[qualifiedName];
                const isEnabled = !toolSettings || toolSettings.enabled !== false;
                if (isEnabled) {
                    toolToClientMap.set(qualifiedName, { client: connectedClient, toolInfo: tool });
                }
            }
        }
    } catch (error: any) {
         if (!(error?.name === 'McpError' && error?.code === -32601)) {
             logger.error(`Error fetching tools from ${connectedClient.name} during refresh:`, error?.message || error);
         }
    }

    try {
         const result = await connectedClient.client.request({ method: 'resources/list', params: {} }, ListResourcesResultSchema);
         if (result.resources) {
             result.resources.forEach(resource => resourceToClientMap.set(resource.uri, connectedClient));
         }
     } catch (error: any) {
          if (!(error?.name === 'McpError' && error?.code === -32601)) {
              logger.error(`Error fetching resources from ${connectedClient.name} during refresh:`, error?.message || error);
          }
     }

    try {
         const result = await connectedClient.client.request({ method: 'prompts/list', params: {} }, ListPromptsResultSchema);
         if (result.prompts) {
             result.prompts.forEach(prompt => promptToClientMap.set(prompt.name, connectedClient));
         }
     } catch (error: any) {
          if (!(error?.name === 'McpError' && error?.code === -32601)) {
              logger.error(`Error fetching prompts from ${connectedClient.name} during refresh:`, error?.message || error);
          }
     }
    return true;

  } catch (error: any) {
    logger.error(`Failed to refresh backend connection for ${serverKey}: ${error.message}`);
    if (existingClientIndex !== -1) {
        currentConnectedClients.splice(existingClientIndex, 1);
    }
    for (const [key, value] of toolToClientMap.entries()) {
      if (value.client.name === serverKey) toolToClientMap.delete(key);
    }
    for (const [key, value] of resourceToClientMap.entries()) {
      if (value.name === serverKey) resourceToClientMap.delete(key);
    }
    for (const [key, value] of promptToClientMap.entries()) {
      if (value.name === serverKey) promptToClientMap.delete(key);
    }
    return false;
  }
}

export const getCurrentProxyState = () => {
    const tools = Array.from(toolToClientMap.entries()).map(([qualifiedName, { client: connectedClient, toolInfo }]) => {
        return {
            name: toolInfo.name,
            serverName: connectedClient?.name || 'Unknown',
            description: toolInfo.description
        };
    });
    return { tools, serverToolnameSeparator: currentSeparator };
};

const isConnectionError = (err: any): boolean => {
  if (err && err.message) {
    const lowerMessage = err.message.toLowerCase();
    return lowerMessage.includes("disconnected") ||
           lowerMessage.includes("not connected") ||
           lowerMessage.includes("connection closed") ||
           lowerMessage.includes("transport is closed") ||
           lowerMessage.includes("failed to fetch") || 
           lowerMessage.includes("not found") ||
           lowerMessage.includes("404") || 
           lowerMessage.includes("eof") ||
           lowerMessage.includes("tls") ||
           lowerMessage.includes("timeout") ||
           lowerMessage.includes("timed out"); 
  }
  return false;
};

export const createServer = async () => {
  const initialServerConfig = await loadConfig();
  const initialToolConfig = await loadToolConfig();

  const initialActiveServers: Record<string, TransportConfig> = {};
    for (const serverKey in initialServerConfig.mcpServers) {
        if (Object.prototype.hasOwnProperty.call(initialServerConfig.mcpServers, serverKey)) {
            const serverConf = initialServerConfig.mcpServers[serverKey];
            const isActive = !(serverConf.active === false || String(serverConf.active).toLowerCase() === 'false');
            if (isActive) {
                initialActiveServers[serverKey] = serverConf;
            }
        }
    }
  currentActiveServersConfig = initialActiveServers;
  currentProxyConfig = {
      ...defaultProxySettingsFull,
      ...(initialServerConfig.proxy || {}),
  };

  await updateBackendConnections(initialServerConfig, initialToolConfig);

  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  const server = new Server(
    {
      name: "mcp_proxy_server",
      version: "1.0.0",
    },
    {
      capabilities: {
        prompts: {},
        resources: { subscribe: true },
        tools: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    const enabledTools: Tool[] = [];
    const toolOverrides = currentToolConfig.tools || {};

    for (const [originalQualifiedName, { client: connectedClient, toolInfo }] of toolToClientMap.entries()) {
        const overrideSettings = toolOverrides[originalQualifiedName];
        const exposedName = overrideSettings?.exposedName || originalQualifiedName;
        const exposedDescription = overrideSettings?.exposedDescription || toolInfo.description;

        enabledTools.push({
            name: exposedName,
            description: exposedDescription,
            inputSchema: toolInfo.inputSchema,
        });
    }
    return { tools: enabledTools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name: requestedExposedName, arguments: args } = request.params;
    let originalQualifiedName: string | undefined;
    let mapEntry: { client: ConnectedClient, toolInfo: Tool } | undefined;

    const toolOverrides = currentToolConfig.tools || {};

    for (const [key, { client, toolInfo: currentToolInfo }] of toolToClientMap.entries()) {
        const overrideSettings = toolOverrides[key];
        const currentExposedName = overrideSettings?.exposedName || key;

        if (currentExposedName === requestedExposedName) {
            originalQualifiedName = key;
            mapEntry = { client, toolInfo: currentToolInfo };
            break;
        }
    }

    if (!mapEntry || !originalQualifiedName) {
        const errorMessage = `Attempted to call tool with exposed name "${requestedExposedName}", but no corresponding enabled tool or override configuration found.`;
        logger.error(errorMessage);
        throw new McpError(-32601, errorMessage);
    }

    let { client: clientForTool, toolInfo } = mapEntry;
    const originalToolNameForBackend = toolInfo.name;

    const maxRetries = clientForTool.transportType === 'sse' ? (currentProxyConfig.retrySseToolCall ? currentProxyConfig.sseToolCallMaxRetries : 0) :
                       clientForTool.transportType === 'stdio' ? (currentProxyConfig.retryStdioToolCall ? currentProxyConfig.stdioToolCallMaxRetries : 0) :
                       clientForTool.transportType === 'http' ? (currentProxyConfig.retryHttpToolCall ? currentProxyConfig.httpToolCallMaxRetries : 0) : 0;
    const retryDelayBaseMs = clientForTool.transportType === 'sse' ? currentProxyConfig.sseToolCallRetryDelayBaseMs :
                             clientForTool.transportType === 'stdio' ? (currentProxyConfig.retryStdioToolCall ? currentProxyConfig.stdioToolCallRetryDelayBaseMs : 0) :
                             clientForTool.transportType === 'http' ? (currentProxyConfig.retryHttpToolCall ? currentProxyConfig.httpToolCallRetryDelayBaseMs : 0) : 0;

    let lastError: any = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (attempt >= 0) {            
            if (attempt > 0) {
              const delay = retryDelayBaseMs * Math.pow(2, attempt - 1) + (Math.random() * retryDelayBaseMs * 0.5);
              logger.log(`Tool call failed for '${requestedExposedName}'. Attempt ${attempt}/${maxRetries}. Retrying in ${delay.toFixed(0)}ms...`);
              await sleep(delay);
            }
            // For SSE and HTTP, attempt reconnect before retrying the call if the last error was a connection error.
            //
            // PATCHED (kouichi550803): upstream unconditionally forced a reconnect on
            // `attempt === 0`, i.e. on every single SSE tool call regardless of whether
            // the existing connection was healthy. That meant every tool invocation paid
            // for a full disconnect/reconnect cycle (cleanup -> refreshBackendConnection
            // -> repopulate maps) before the call was even attempted, adding latency and
            // a fresh failure point on every call. We now only force a reconnect on
            // retries after an actual connection error was observed; the first attempt
            // reuses the existing connection as-is.
            //
            // PATCHED further (kouichi550803): this reconnect-on-retry step used to be
            // gated on `transportType === 'sse'` only. HTTP (Streamable HTTP) backends
            // never got a fresh connection on retry — a wedged/stale client+transport
            // object for an 'http' backend would just be retried against as-is, up to
            // maxRetries times, guaranteeing the same failure (or same multi-minute hang)
            // on every attempt. Observed in production: bitbank (http transport) timed out
            // repeatedly across 3 separate user requests over several minutes, while a
            // fresh independent call to the same backend succeeded instantly — consistent
            // with a stuck http client/transport that retries alone could never clear.
            // Extending the same reconnect-before-retry logic to 'http' closes that gap.
            if (clientForTool.transportType === 'sse' || clientForTool.transportType === 'http') {
                if (attempt > 0 && isConnectionError(lastError)) {
                    logger.log(`Connection handling (${clientForTool.transportType}) for tool '${requestedExposedName}' on server '${clientForTool.name}'. Attempting reconnect.`);
                    const clientTransportConfig = currentActiveServersConfig[clientForTool.name];
                    if (!clientTransportConfig) {
                        logger.error(`Cannot proceed: TransportConfig for server '${clientForTool.name}' not found.`);
                        throw new McpError(-32000, `TransportConfig for server '${clientForTool.name}' not found for tool '${requestedExposedName}'.`);
                    }
                    const refreshed = await refreshBackendConnection(clientForTool.name, clientTransportConfig);
                    if (refreshed) {
                        logger.log(`Successfully reconnected to server '${clientForTool.name}' via ${clientForTool.transportType}.`);
                        const newMapEntry = toolToClientMap.get(originalQualifiedName);
                        if (!newMapEntry) {
                            logger.error(`Tool '${originalQualifiedName}' not found in map after successful refresh for server '${clientForTool.name}'.`);
                            throw new McpError(-32000, `Tool '${originalQualifiedName}' disappeared after refresh for server '${clientForTool.name}'.`);
                        }
                        clientForTool = newMapEntry.client;
                        toolInfo = newMapEntry.toolInfo;
                    } else {
                        logger.error(`Reconnection to server '${clientForTool.name}' failed.`);
                        throw new McpError(-32000, `Reconnection to server '${clientForTool.name}' failed for tool '${requestedExposedName}'.`);
                    }
                }
            }
         }

        try {
            logger.log(`Forwarding tool call for exposed name '${requestedExposedName}' (original qualified name: '${originalQualifiedName}'). Forwarding to server '${clientForTool.name}' as tool '${originalToolNameForBackend}' (Attempt ${attempt + 1})`);
            const backendResponse = await clientForTool.client.request(
                {
                    method: 'tools/call',
                    params: { name: originalToolNameForBackend, arguments: args || {}, _meta: { progressToken: request.params._meta?.progressToken } }
                },
                CompatibilityCallToolResultSchema,
                { timeout: DEFAULT_REQUEST_TIMEOUT_MSEC }
            );
            return backendResponse;
        } catch (error: any) {
            lastError = error;
            logger.warn(`Attempt ${attempt + 1} to call tool '${requestedExposedName}' failed: ${error.message}`);

            const isRetryableError = isConnectionError(error) || (error?.name === 'McpError' && error?.code === -32001);
            const shouldRetry = (clientForTool.transportType === 'sse' && currentProxyConfig.retrySseToolCall && isRetryableError) ||
                                (clientForTool.transportType === 'stdio' && currentProxyConfig.retryStdioToolCall && isRetryableError) ||
                                (clientForTool.transportType === 'http' && currentProxyConfig.retryHttpToolCall && isRetryableError);


            if (!shouldRetry && attempt === 0) {
                 logger.error(`Tool call for '${requestedExposedName}' failed with non-retryable error on first attempt: ${error.message}`, error);
                 if (error instanceof McpError) {
                     throw error;
                 } else {
                     throw new McpError(error?.code || -32000, error.message || 'An unknown error occurred', error?.data);
                 }
            }

             if (!shouldRetry && attempt > 0) {
                 logger.error(`Tool call for '${requestedExposedName}' failed with non-retryable error after retries: ${error.message}`, error);
                 if (error instanceof McpError) {
                     throw error;
                 } else {
                     throw new McpError(error?.code || -32000, error.message || 'An unknown error occurred', error?.data);
                 }
            }
        }
    }

    const errorMessage = `Error calling tool '${requestedExposedName}' after ${maxRetries} retries (on backend server '${clientForTool.name}', original tool name '${originalToolNameForBackend}'): ${lastError?.message || 'An unknown error occurred'}`;
    logger.error(errorMessage, lastError);
    throw new McpError(lastError?.code || -32000, errorMessage, lastError?.data);
});

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { name } = request.params;
    const clientForPrompt = promptToClientMap.get(name);

    if (!clientForPrompt) {
      throw new Error(`Unknown prompt: ${name}`);
    }

    try {
      const response = await clientForPrompt.client.request(
        {
          method: 'prompts/get' as const,
          params: {
            name,
            arguments: request.params.arguments || {},
            _meta: request.params._meta || {
              progressToken: undefined
            }
          }
        },
        GetPromptResultSchema
      );

      return response;
    } catch (error: any) {
      const errorMessage = `Error getting prompt '${name}' from backend server '${clientForPrompt.name}': ${error.message || 'An unknown error occurred'}`;
      logger.error(errorMessage, error);
      throw new Error(errorMessage);
    }
  });

  server.setRequestHandler(ListPromptsRequestSchema, async (request) => {
    const allPrompts: z.infer<typeof ListPromptsResultSchema>['prompts'] = [];
     for (const [name, connectedClient] of promptToClientMap.entries()) {
         allPrompts.push({
             name: name,
             description: `[${connectedClient.name}] Prompt (details omitted in list)`,
             inputSchema: {},
         });
        }
       return {
         prompts: allPrompts,
      nextCursor: undefined
    };
  });

   server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
       const allResources: z.infer<typeof ListResourcesResultSchema>['resources'] = [];
       for (const [uri, connectedClient] of resourceToClientMap.entries()) {
           allResources.push({
               uri: uri,
               name: `[${connectedClient.name}] Resource (details omitted in list)`,
               description: undefined,
               methods: [],
           });
       }
       return {
           resources: allResources,
           nextCursor: undefined
       };
   });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;
    const clientForResource = resourceToClientMap.get(uri);

    if (!clientForResource) {
      throw new Error(`Unknown resource: ${uri}`);
    }

    try {
      return await clientForResource.client.request(
        {
          method: 'resources/read',
          params: {
            uri,
            _meta: request.params._meta
          }
        },
        ReadResourceResultSchema
      );
    } catch (error: any) {
      const errorMessage = `Error reading resource '${uri}' from backend server '${clientForResource.name}': ${error.message || 'An unknown error occurred'}`;
      logger.error(errorMessage, error);
      throw new Error(errorMessage);
    }
  });

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async (request) => {
    const allTemplates: ResourceTemplate[] = [];

    for (const connectedClient of currentConnectedClients) {
      try {
        const result = await connectedClient.client.request(
          {
            method: 'resources/templates/list' as const,
            params: {
              cursor: request.params?.cursor,
              _meta: request.params?._meta || {
                progressToken: undefined
              }
            }
          },
          ListResourceTemplatesResultSchema
        );

        if (result.resourceTemplates) {
          const templatesWithSource = result.resourceTemplates.map((template: ResourceTemplate) => ({
            ...template,
            name: `[${connectedClient.name}] ${template.name || ''}`,
            description: template.description ? `[${connectedClient.name}] ${template.description}` : undefined
          }));
          allTemplates.push(...templatesWithSource);
        }
      } catch (error: any) {
        const isMethodNotFoundError = error?.name === 'McpError' && error?.code === -32601;

        if (isMethodNotFoundError) {
          logger.warn(`Warning: Method 'resources/templates/list' not found on server ${connectedClient.name}. Proceeding without templates from this source.`);
        } else {
          const errorMessage = `Error fetching resource templates from backend server '${connectedClient.name}': ${error.message || 'An unknown error occurred'}`;
          logger.error(errorMessage, error);
        }
      }
    }

    return {
      resourceTemplates: allTemplates,
      nextCursor: request.params?.cursor
    };
  });

  const cleanup = async () => {
    await Promise.all(currentConnectedClients.map(async ({ name, cleanup: clientCleanup }) => {
        try {
            await clientCleanup();
        } catch(error: any) {
             logger.error(`  Error cleaning up client ${name}: ${error.message}`);
        }
    }));
    currentConnectedClients = [];
  };

  return { server, cleanup };
};

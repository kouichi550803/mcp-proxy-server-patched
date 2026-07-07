import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport, StreamableHTTPServerTransportOptions } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { Request, Response, NextFunction } from "express";
import session from 'express-session';
import { ServerResponse } from "node:http";
import { readFile, writeFile, access, mkdir } from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { exec as execCallback, spawn } from 'child_process';
import { promisify } from 'util';
import { createServer, updateBackendConnections, getCurrentProxyState } from "./mcp-proxy.js";
import http from 'http';
import { fileURLToPath } from 'url';
import { Tool, ListToolsResultSchema, JSONRPCMessage, JSONRPCError } from "@modelcontextprotocol/sdk/types.js";
import { Config, loadConfig, isStdioConfig, loadToolConfig } from './config.js';
import { logger } from './logger.js';
import { terminalRouter, activeTerminals, TERMINAL_OUTPUT_SSE_CONNECTIONS, ActiveTerminal } from './terminal.js';

const exec = promisify(execCallback);

declare module 'express-session' {
  interface SessionData {
    user?: { username: string };
  }
}

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
const expressServer = http.createServer(app);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CONFIG_PATH = path.resolve(__dirname, '..', 'config', 'mcp_server.json');
const TOOL_CONFIG_PATH = path.resolve(__dirname, '..', 'config', 'tool_config.json');
const SECRET_FILE_PATH = path.resolve(__dirname, '..', 'config', '.session_secret');
const publicPath = path.join(__dirname, '..', 'public');

const sseTransports = new Map<string, SSEServerTransport>();
const streamableHttpTransports = new Map<string, StreamableHTTPServerTransport>();

// PATCHED (kouichi550803): stale-transport reaper.
//
// The onclose/onerror handlers below are supposed to remove a transport from
// its map as soon as the underlying connection ends, but in practice (e.g.
// when this proxy sits behind another reverse proxy / webhook bridge that
// pools or silently drops connections without ever signalling a close) that
// callback can simply never fire. Observed symptom: `Active transports:`
// climbing into the hundreds over a session with no corresponding decrease.
// Since we cannot guarantee onclose fires, we independently track last-seen
// activity per session and periodically force-close (and remove) anything
// that has been idle for longer than STALE_TRANSPORT_MAX_IDLE_MS. This bounds
// memory/resource growth even when the SDK-level cleanup path is silently
// skipped by the network layer.
const transportLastActivity = new Map<string, number>();
const STALE_TRANSPORT_MAX_IDLE_MS = 30 * 60 * 1000;
const STALE_TRANSPORT_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

function touchTransportActivity(sessionId: string | undefined) {
  if (!sessionId) return;
  transportLastActivity.set(sessionId, Date.now());
}

function forgetTransportActivity(sessionId: string | undefined) {
  if (!sessionId) return;
  transportLastActivity.delete(sessionId);
}

function sweepStaleTransports() {
  const now = Date.now();
  let closedCount = 0;

  for (const [sessionId, transport] of Array.from(streamableHttpTransports.entries())) {
    const lastSeen = transportLastActivity.get(sessionId) ?? 0;
    if (now - lastSeen > STALE_TRANSPORT_MAX_IDLE_MS) {
      streamableHttpTransports.delete(sessionId);
      transportLastActivity.delete(sessionId);
      closedCount++;
      try {
        if (typeof (transport as any).close === 'function') {
          Promise.resolve((transport as any).close()).catch(() => {});
        }
      } catch { /* best-effort */ }
    }
  }

  for (const [sessionId, transport] of Array.from(sseTransports.entries())) {
    const lastSeen = transportLastActivity.get(sessionId) ?? 0;
    if (now - lastSeen > STALE_TRANSPORT_MAX_IDLE_MS) {
      sseTransports.delete(sessionId);
      transportLastActivity.delete(sessionId);
      closedCount++;
      try {
        if (typeof (transport as any).close === 'function') {
          Promise.resolve((transport as any).close()).catch(() => {});
        }
      } catch { /* best-effort */ }
    }
  }

  if (closedCount > 0) {
    logger.log(`[stale-transport-reaper] Force-closed ${closedCount} idle transport(s). Active streamableHttp: ${streamableHttpTransports.size}, Active sse: ${sseTransports.size}.`);
  }
}

setInterval(sweepStaleTransports, STALE_TRANSPORT_SWEEP_INTERVAL_MS).unref();

const { server, cleanup } = await createServer();

const allowedKeysRaw = process.env.ALLOWED_KEYS || "";
const allowedKeys = new Set(allowedKeysRaw.split(',').map(k => k.trim()).filter(k => k.length > 0));

const allowedTokensRaw = process.env.ALLOWED_TOKENS || "";
const allowedTokens = new Set(allowedTokensRaw.split(',').map(t => t.trim()).filter(t => t.length > 0));

const authEnabled = allowedKeys.size > 0 || allowedTokens.size > 0;
logger.log(`MCP Endpoint Authentication: ${authEnabled ? `Enabled. ${allowedKeys.size} key(s) and ${allowedTokens.size} token(s) configured.` : 'Disabled.'}`);

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'password';
const SESSION_SECRET_ENV = process.env.SESSION_SECRET;

if (ADMIN_PASSWORD === 'password') {
    logger.warn("WARNING: Using default admin password. Set ADMIN_PASSWORD environment variable for security.");
}

const rawEnableAdminUI = process.env.ENABLE_ADMIN_UI;
const enableAdminUI = typeof rawEnableAdminUI === 'string' && (rawEnableAdminUI.toLowerCase() === 'true' || rawEnableAdminUI === '1' || rawEnableAdminUI.toLowerCase() === 'yes');

async function getSessionSecret(): Promise<string> {
    if (SESSION_SECRET_ENV && SESSION_SECRET_ENV !== 'unsafe-default-secret' && SESSION_SECRET_ENV.trim() !== '') {
        return SESSION_SECRET_ENV;
    }

    try {
        await access(SECRET_FILE_PATH);
        const secretFromFile = await readFile(SECRET_FILE_PATH, 'utf-8');
        if (secretFromFile.trim() !== '') {
            return secretFromFile.trim();
        }
    } catch (error: any) {
        if (error.code !== 'ENOENT') {
            logger.error("Error accessing session secret file, attempting to generate new:", error);
        }
    }

    const newSecret = crypto.randomBytes(32).toString('hex');
    try {
        await mkdir(path.dirname(SECRET_FILE_PATH), { recursive: true });
        await writeFile(SECRET_FILE_PATH, newSecret, { encoding: 'utf-8', mode: 0o600 });
        return newSecret;
    } catch (writeError) {
        logger.error("FATAL: Could not write new session secret file:", writeError);
        return 'temporary-insecure-secret-' + crypto.randomBytes(16).toString('hex');
    }
}

const adminSseConnections = new Map<string, ServerResponse>();

if (enableAdminUI) {
    logger.log("Admin UI is ENABLED.");

    const sessionSecret = await getSessionSecret();

    app.use(session({
        secret: sessionSecret,
        resave: false,
        saveUninitialized: false,
        cookie: { secure: process.env.NODE_ENV === 'production', httpOnly: true, maxAge: 1000 * 60 * 60 * 24 }
    }));

    const isAuthenticated = (req: Request, res: Response, next: NextFunction) => {
        if (req.session.user) {
            next();
        } else {
            if (req.headers.accept?.includes('application/json')) {
                 res.status(401).json({ error: 'Unauthorized' });
            } else {
                 res.status(401).send('Unauthorized. Please login via the admin interface.');
            }
        }
    };


    app.post('/admin/login', (req, res) => {
        const { username, password } = req.body;
        if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
            req.session.user = { username: username };
            res.json({ success: true });
        } else {
            res.status(401).json({ success: false, error: 'Invalid credentials' });
        }
    });

    app.post('/admin/logout', (req, res) => {
        req.session.destroy((err) => {
            if (err) {
                return res.status(500).json({ success: false, error: 'Failed to logout' });
            }
            res.clearCookie('connect.sid');
            res.json({ success: true });
        });
    });

    app.get('/admin/config', isAuthenticated, async (req, res) => {
        try {
            const configData = await readFile(CONFIG_PATH, 'utf-8');
            res.setHeader('Content-Type', 'application/json');
            res.send(configData);
        } catch (error: any) {
            if (error.code === 'ENOENT') {
                 res.status(404).json({ error: 'Configuration file not found.' });
            } else {
                 res.status(500).json({ error: 'Failed to read configuration file.' });
            }
        }
    });

    app.post('/admin/config', isAuthenticated, async (req, res) => {
        try {
            const newConfigData = req.body;
            if (typeof newConfigData !== 'object' || newConfigData === null) {
                return res.status(400).json({ error: 'Invalid configuration format: Expected a JSON object.' });
            }
            const configString = JSON.stringify(newConfigData, null, 2);
            await writeFile(CONFIG_PATH, configString, 'utf-8');
            res.json({ success: true });
        } catch (error) {
            res.status(500).json({ error: 'Failed to write configuration file.' });
        }
    });


    app.get('/admin/tools/list', isAuthenticated, async (req, res) => {
        try {
            const { tools } = getCurrentProxyState();
            res.json({ tools });
        } catch (error: any) {
            res.status(500).json({ error: 'Failed to retrieve tool list from proxy state.' });
        }
    });

    app.get('/admin/tools/config', isAuthenticated, async (req, res) => {
        try {
            const toolConfigData = await readFile(TOOL_CONFIG_PATH, 'utf-8');
            res.setHeader('Content-Type', 'application/json');
            res.send(toolConfigData);
        } catch (error: any) {
            if (error.code === 'ENOENT') {
                 res.json({ tools: {} });
            } else {
                 res.status(500).json({ error: 'Failed to read tool configuration file.' });
            }
        }
    });

    app.post('/admin/tools/config', isAuthenticated, async (req, res) => {
        try {
            const newToolConfigData = req.body;
            if (typeof newToolConfigData !== 'object' || newToolConfigData === null || typeof newToolConfigData.tools !== 'object') {
                return res.status(400).json({ error: 'Invalid tool configuration format: Expected { "tools": { ... } }.' });
            }
            const configString = JSON.stringify(newToolConfigData, null, 2);
            await writeFile(TOOL_CONFIG_PATH, configString, 'utf-8');
            res.json({ success: true, message: "Configuration saved. Restart proxy server to apply changes." });
        } catch (error) {
            res.status(500).json({ error: 'Failed to write tool configuration file.' });
        }
    });

    app.post('/admin/server/reload', isAuthenticated, async (req, res) => {
        try {
            const latestServerConfig = await loadConfig();
            const latestToolConfig = await loadToolConfig();
            await updateBackendConnections(latestServerConfig, latestToolConfig);
            res.json({ success: true, message: 'Server configuration reloaded successfully.' });
        } catch (error: any) {
            res.status(500).json({ success: false, error: 'Failed to reload server configuration.', details: error.message });
        }
    });

    app.get('/admin/environment', isAuthenticated, async (req, res) => {
        try {
            const config = await loadConfig();
            res.json({
                toolsFolder: process.env.TOOLS_FOLDER || "",
                serverToolnameSeparator: config.serverToolnameSeparator
            });
        } catch (error: any) {
            res.status(500).json({ error: "Failed to fetch environment information." });
        }
    });


    app.post('/admin/server/install/:serverKey', isAuthenticated, async (req, res) => {
        const serverKey = req.params.serverKey;
        const adminSessionId = req.session.id;
        const clientId = req.ip || `admin-${Date.now()}`;

        res.json({ success: true, message: `Installation process for '${serverKey}' started. Check for live updates.` });

        (async () => {
            const adminRes = adminSseConnections.get(adminSessionId);

            const sendAdminSseEvent = (event: string, data: any) => {
                if (adminRes && !adminRes.writableEnded) {
                    try {
                        adminRes.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
                    } catch (e) {
                        logger.error(`[${clientId}] Failed to send admin SSE event ${event} for session ${adminSessionId}:`, e);
                    }
                }
            };

            try {
                const config = await loadConfig();
                const serverConfig = config.mcpServers[serverKey];

                if (!serverConfig) {
                    sendAdminSseEvent('install_error', { serverKey, error: `Server configuration not found for key: ${serverKey}` });
                    return;
                }
                if (!isStdioConfig(serverConfig)) {
                    sendAdminSseEvent('install_error', { serverKey, error: `Installation commands only supported for stdio servers.` });
                    return;
                }

                const { installDirectory, installCommands } = serverConfig;
                let absoluteInstallDir: string;

                if (installDirectory) {
                    absoluteInstallDir = path.resolve(installDirectory);
                } else if (process.env.TOOLS_FOLDER && process.env.TOOLS_FOLDER.trim() !== '') {
                    absoluteInstallDir = path.resolve(process.env.TOOLS_FOLDER.trim(), serverKey);
                } else {
                    absoluteInstallDir = path.resolve(process.cwd(), 'tools', serverKey);
                }
                
                const executionCwd = path.dirname(absoluteInstallDir); 

                try {
                    await mkdir(executionCwd, { recursive: true });
                } catch (mkdirError: any) {
                    sendAdminSseEvent('install_error', { serverKey, error: `Failed to create execution directory '${executionCwd}': ${mkdirError.message}` });
                    throw mkdirError;
                }

                try {
                    await access(absoluteInstallDir);
                    sendAdminSseEvent('install_complete', { serverKey, code: 0, message: "Already installed." });
                    return;
                } catch (error: any) {
                    if (error.code !== 'ENOENT') {
                         sendAdminSseEvent('install_error', { serverKey, error: `Error checking target server directory '${absoluteInstallDir}': ${error.message}` });
                         throw error;
                    }
                }

                const commandsToRun = installCommands && Array.isArray(installCommands) ? installCommands : [];
                if (commandsToRun.length > 0) {
                    for (const command of commandsToRun) {
                        sendAdminSseEvent('install_info', { serverKey, message: `Executing: ${command}` });

                        const commandParts = command.split(' ');
                        const cmd = commandParts[0];
                        const args = commandParts.slice(1);

                        const child = spawn(cmd, args, {
                            shell: true, 
                            cwd: executionCwd,
                            stdio: ['ignore', 'pipe', 'pipe'] 
                        });

                        child.stdout.on('data', (data) => {
                            sendAdminSseEvent('install_stdout', { serverKey, output: data.toString() });
                        });

                        child.stderr.on('data', (data) => {
                            sendAdminSseEvent('install_stderr', { serverKey, output: data.toString() });
                        });

                        const exitCode = await new Promise<number | null>((resolve, reject) => {
                            child.on('close', resolve); 
                            child.on('error', reject);
                        });

                        if (exitCode !== 0) {
                            const errorMsg = `Command "${command}" failed with exit code ${exitCode}.`;
                            sendAdminSseEvent('install_error', { serverKey, error: errorMsg, command, exitCode });
                            throw new Error(errorMsg); 
                        }
                    }
                }

                try {
                    await access(absoluteInstallDir);
                } catch (error: any) {
                     if (error.code === 'ENOENT') {
                        await mkdir(absoluteInstallDir, { recursive: true });
                     } else {
                        sendAdminSseEvent('install_error', { serverKey, error: `Error after commands, verifying/creating directory '${absoluteInstallDir}': ${error.message}` });
                        throw error;
                     }
                }

                sendAdminSseEvent('install_complete', { serverKey, code: 0, message: "Installation process completed successfully." });

            } catch (error: any) {
                if (!error.message?.includes('failed with exit code') && 
                    !error.message?.includes('Failed to create execution directory') &&
                    !error.message?.includes('Error checking target server directory') &&
                    !error.message?.includes('Error after commands, verifying/creating directory')) {
                     sendAdminSseEvent('install_error', { serverKey, error: `Installation failed: ${error.message}` });
                }
            }
        })();
    });

    app.get('/admin/sse/updates', isAuthenticated, (req, res) => {
        const sessionId = req.session.id;
        if (!sessionId) {
            res.status(400).send("Session not found");
            return;
        }

        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
        });

        res.write(`event: connected\ndata: ${JSON.stringify({ message: "Admin SSE connected" })}\n\n`);

        adminSseConnections.set(sessionId, res);

        req.on('close', () => {
            adminSseConnections.delete(sessionId);
        });
    });

    app.use('/admin/terminal', isAuthenticated, terminalRouter);


    app.use('/admin', express.static(publicPath));

    app.get('/admin', (req, res) => {
        res.redirect('/admin/index.html');
    });
    app.get('/admin/', (req, res) => {
        res.redirect('/admin/index.html');
    });

} else {
     console.log("Admin UI is DISABLED. Set ENABLE_ADMIN_UI=true to enable.");
}


app.get("/sse", async (req, res) => {
  const clientId = req.ip || `client-${Date.now()}`;

  if (authEnabled) {
    let authenticated = false;

    const authHeader = req.headers['authorization'] as string | undefined;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.substring('Bearer '.length).trim();
      if (allowedTokens.has(token)) {
        authenticated = true;
      }
    }

    if (!authenticated && allowedKeys.size > 0) {
      const headerKey = req.headers['x-api-key'] as string | undefined;
      const queryKey = req.query.key as string | undefined;
      const providedKey = headerKey || queryKey;

      if (providedKey && allowedKeys.has(providedKey)) {
        authenticated = true;
      }
    }

    if (!authenticated) {
      res.status(401).send('Unauthorized');
      return;
    }
  }


  let clientTransport: SSEServerTransport | null = null;
  const sessionIdFromClientQuery = req.query.session_id as string | undefined;
  let actualTransportSessionId: string | undefined;

  try {
    if (sessionIdFromClientQuery && sseTransports.has(sessionIdFromClientQuery)) {
      const existingTransport = sseTransports.get(sessionIdFromClientQuery)!;
      sseTransports.delete(sessionIdFromClientQuery);
      if (typeof existingTransport.close === 'function') {
        existingTransport.close().catch(err =>
          logger.warn(`[${clientId}] Non-critical error closing existing transport for session ${sessionIdFromClientQuery}:`, err)
        );
      }
    }

    clientTransport = new SSEServerTransport("/message", res);
    actualTransportSessionId = clientTransport.sessionId;

    if (!actualTransportSessionId) {
      throw new Error("Failed to obtain session ID from new SSE transport instance.");
    }
    
    sseTransports.set(actualTransportSessionId, clientTransport);
    
    const currentTransport = clientTransport;
    const currentSessionId = actualTransportSessionId;

    touchTransportActivity(currentSessionId);

    currentTransport.onerror = (err: any) => {
      logger.error(`[${clientId}] SSE transport error for session ${currentSessionId}: ${err?.stack || err?.message || err}`);
      if (sseTransports.has(currentSessionId)) {
        sseTransports.delete(currentSessionId);
      }
      forgetTransportActivity(currentSessionId);
    };

    currentTransport.onclose = () => {
      if (sseTransports.has(currentSessionId)) {
        sseTransports.delete(currentSessionId);
      }
      forgetTransportActivity(currentSessionId);
    };

    await server.connect(currentTransport);

  } catch (error: any) {
    const logSessionIdOnError = actualTransportSessionId || sessionIdFromClientQuery || "unknown_during_error_handling";
    logger.error(`[${clientId}] Failed during SSE setup or connection for session attempt related to ${logSessionIdOnError}:`, error);
    
    if (actualTransportSessionId && sseTransports.has(actualTransportSessionId)) {
       sseTransports.delete(actualTransportSessionId);
    }
    if (clientTransport && typeof clientTransport.close === 'function') {
      clientTransport.close().catch((e: any) => logger.error(`[${clientId}] Error closing transport for session ${logSessionIdOnError} after connection failure:`, e));
    }
    if (!res.headersSent) {
      res.status(500).send('Failed to establish SSE connection');
    }
  }
});

app.all("/mcp", async (req, res) => {
  const clientId = req.ip || `client-http-${Date.now()}`;

  if (authEnabled) {
    let authenticated = false;
    const authHeader = req.headers['authorization'] as string | undefined;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.substring('Bearer '.length).trim();
      if (allowedTokens.has(token)) {
        authenticated = true;
      }
    }
    if (!authenticated && allowedKeys.size > 0) {
      const headerKey = req.headers['x-api-key'] as string | undefined;
      const queryKey = req.query.key as string | undefined;
      const providedKey = headerKey || queryKey;
      if (providedKey && allowedKeys.has(providedKey)) {
        authenticated = true;
      }
    }
    if (!authenticated) {
      res.status(401).send('Unauthorized');
      return;
    }
  }

  let httpTransport: StreamableHTTPServerTransport | undefined;
  const clientProvidedSessionId = req.headers['mcp-session-id'] as string | undefined;
  let transportSessionIdToUse: string | undefined = clientProvidedSessionId;

  if (clientProvidedSessionId) {
    httpTransport = streamableHttpTransports.get(clientProvidedSessionId);
    if (!httpTransport) {
      if (!res.headersSent) {
        res.status(404).json({
            jsonrpc: "2.0",
            error: { code: -32000, message: `Session not found for Mcp-Session-Id: ${clientProvidedSessionId}` },
            id: (req.body as any)?.id ?? null
        });
      }
      return;
    }
    touchTransportActivity(clientProvidedSessionId);
  } else {
    const tempGeneratedIdForEarlyMap = `pending-${crypto.randomBytes(8).toString('hex')}`;
    let capturedHttpTransportInstance: StreamableHTTPServerTransport | null = null;

    const newTransportOptions: StreamableHTTPServerTransportOptions = {
        sessionIdGenerator: () => crypto.randomUUID(),
        enableJsonResponse: false,
        onsessioninitialized: (sdkGeneratedSessionId: string) => {
            if (capturedHttpTransportInstance) {
                const finalSessionId = sdkGeneratedSessionId;

                if (streamableHttpTransports.has(tempGeneratedIdForEarlyMap)) {
                    const transportInstanceFromMap = streamableHttpTransports.get(tempGeneratedIdForEarlyMap);
                    if (transportInstanceFromMap === capturedHttpTransportInstance) {
                        streamableHttpTransports.delete(tempGeneratedIdForEarlyMap);
                        streamableHttpTransports.set(finalSessionId, capturedHttpTransportInstance);
                        if (transportSessionIdToUse === tempGeneratedIdForEarlyMap) {
                            transportSessionIdToUse = finalSessionId;
                        }
                    } else {
                        if (!streamableHttpTransports.has(finalSessionId) || streamableHttpTransports.get(finalSessionId) !== capturedHttpTransportInstance) {
                           streamableHttpTransports.set(finalSessionId, capturedHttpTransportInstance);
                        }
                    }
                } else {
                    if (!streamableHttpTransports.has(finalSessionId) || streamableHttpTransports.get(finalSessionId) !== capturedHttpTransportInstance) {
                        streamableHttpTransports.set(finalSessionId, capturedHttpTransportInstance);
                        if (transportSessionIdToUse === tempGeneratedIdForEarlyMap) {
                           transportSessionIdToUse = finalSessionId;
                        }
                    }
                }
            }
        },
    };

    httpTransport = new StreamableHTTPServerTransport(newTransportOptions);
    capturedHttpTransportInstance = httpTransport;
    
    transportSessionIdToUse = tempGeneratedIdForEarlyMap;
    streamableHttpTransports.set(tempGeneratedIdForEarlyMap, httpTransport);

    const currentTransportForHandlers = httpTransport;

    currentTransportForHandlers.onerror = (error: Error) => {
      const idToClean = currentTransportForHandlers.sessionId || transportSessionIdToUse;
      logger.error(`[${clientId}] /mcp: StreamableHTTPServerTransport error for session related to ${idToClean}:`, error);
      
      if (streamableHttpTransports.get(tempGeneratedIdForEarlyMap) === currentTransportForHandlers) {
        streamableHttpTransports.delete(tempGeneratedIdForEarlyMap);
      }
      if (currentTransportForHandlers.sessionId && streamableHttpTransports.get(currentTransportForHandlers.sessionId) === currentTransportForHandlers) {
        streamableHttpTransports.delete(currentTransportForHandlers.sessionId);
      }
      forgetTransportActivity(tempGeneratedIdForEarlyMap);
      forgetTransportActivity(currentTransportForHandlers.sessionId);
    };

    currentTransportForHandlers.onclose = () => {
      if (streamableHttpTransports.get(tempGeneratedIdForEarlyMap) === currentTransportForHandlers) {
        streamableHttpTransports.delete(tempGeneratedIdForEarlyMap);
      }
      if (currentTransportForHandlers.sessionId && streamableHttpTransports.get(currentTransportForHandlers.sessionId) === currentTransportForHandlers) {
        streamableHttpTransports.delete(currentTransportForHandlers.sessionId);
      }
      forgetTransportActivity(tempGeneratedIdForEarlyMap);
      forgetTransportActivity(currentTransportForHandlers.sessionId);
    };

    try {
      await server.connect(currentTransportForHandlers);
    } catch (connectError: any) {
      streamableHttpTransports.delete(tempGeneratedIdForEarlyMap);
      if (!res.headersSent) {
        res.status(500).json({
            jsonrpc: "2.0",
            error: { code: -32001, message: `Failed to connect new MCP transport: ${connectError.message}` },
            id: (req.body as any)?.id ?? null
        });
      }
      return;
    }
  }

  if (!httpTransport) {
    if (!res.headersSent) {
        res.status(500).json({
            jsonrpc: "2.0",
            error: { code: -32002, message: "MCP transport not available for session." },
            id: (req.body as any)?.id ?? null
        });
    }
    return;
  }

  touchTransportActivity(transportSessionIdToUse || httpTransport.sessionId);
  try {
    await httpTransport.handleRequest(req, res, req.body);
  } catch (error: any) {
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32603, message: `Internal server error during MCP request handling: ${error.message || error}` },
        id: (req.body as any)?.id ?? null
      }) + '\n');
    } else if (!res.writableEnded) {
      res.end();
    }
  }
});
app.post("/message", async (req, res) => {
  const sessionId = req.query.sessionId as string;

  if (!sessionId) {
    return res.status(400).send({ error: "Missing sessionId query parameter" });
  }

  const transport = sseTransports.get(sessionId);

  if (!transport) {
    return res.status(404).send({ error: `No active session found for ID ${sessionId}` });
  }

  touchTransportActivity(sessionId);
  try {
    await transport.handlePostMessage(req, res, req.body);
  } catch (error: any) {
    if (!res.headersSent) {
      res.status(500).send({ error: "Failed to process message via transport" });
    }
  }
});


const PORT = process.env.PORT || 3663;

expressServer.listen(PORT, () => {
  const baseUrl = `http://localhost:${PORT}`;
  logger.log(`MCP Proxy Server is running.`);
  logger.log(`SSE endpoint: ${baseUrl}/sse`);
  logger.log(`Streamable HTTP (MCP) endpoint: ${baseUrl}/mcp`);

  if (enableAdminUI) {
      logger.log(`Admin UI available at ${baseUrl}/admin`);
  }
});

const shutdown = async (signal: string) => {
  try {
    await server.close();

    await cleanup();

    activeTerminals.forEach((term: ActiveTerminal, id: string) => {
        term.ptyProcess.kill();
    });
    activeTerminals.clear();
    TERMINAL_OUTPUT_SSE_CONNECTIONS.clear();

    expressServer.close((err) => {
      if (err) {
        process.exit(1);
      } else {
        process.exit(0);
      }
    });

    setTimeout(() => {
      process.exit(1);
    }, 10000);

  } catch (error) {
    process.exit(1);
  }
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

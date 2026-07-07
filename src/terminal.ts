import os from 'os';
import pty, { IPty } from 'node-pty';
import { Request, Response, Router } from 'express';
import { ServerResponse } from 'node:http';
import crypto from 'crypto';

export interface ActiveTerminal {
    ptyProcess: IPty;
    id: string;
    lastActivity: number;
    initialOutputBuffer?: string[];
}

export const activeTerminals = new Map<string, ActiveTerminal>();
export const TERMINAL_OUTPUT_SSE_CONNECTIONS = new Map<string, ServerResponse>();

const shell = os.platform() === 'win32' ? 'powershell.exe' : 'bash';
const PTY_PROCESS_TIMEOUT_MS = 1000 * 60 * 60;
const MAX_BUFFER_LENGTH = 200;

function startPtyProcess(): ActiveTerminal {
    const termId = crypto.randomUUID();
    const ptyProcess = pty.spawn(shell, [], {
        name: 'xterm-color',
        cols: 80,
        rows: 30,
        cwd: process.env.HOME || process.cwd(), 
        env: process.env as { [key: string]: string } 
    });

    const terminal: ActiveTerminal = {
        ptyProcess,
        id: termId,
        lastActivity: Date.now(),
        initialOutputBuffer: []
    };

    activeTerminals.set(termId, terminal);
    console.log(`[Terminal] PTY process created with ID: ${termId}, PID: ${ptyProcess.pid}`);

    ptyProcess.onData((data: string) => {
        terminal.lastActivity = Date.now(); 
        const sseRes = TERMINAL_OUTPUT_SSE_CONNECTIONS.get(termId);

        if (sseRes && !sseRes.writableEnded) {
            if (terminal.initialOutputBuffer && terminal.initialOutputBuffer.length > 0) {
                terminal.initialOutputBuffer.forEach(bufferedData => {
                    try {
                        sseRes.write(`event: output\ndata: ${JSON.stringify(bufferedData)}\n\n`);
                    } catch (e) {
                        console.error(`[Terminal ${termId}] Error writing buffered data to SSE stream:`, e);
                    }
                });
                terminal.initialOutputBuffer = [];
            }
            try {
                sseRes.write(`event: output\ndata: ${JSON.stringify(data)}\n\n`);
            } catch (e) {
                console.error(`[Terminal ${termId}] Error writing live data to SSE stream:`, e);
            }
        } else if (terminal.initialOutputBuffer) { 
            terminal.initialOutputBuffer.push(data);
            if (terminal.initialOutputBuffer.length > MAX_BUFFER_LENGTH) {
                terminal.initialOutputBuffer.shift();
            }
        }
    });

    ptyProcess.onExit(({ exitCode, signal }: { exitCode: number, signal?: number }) => {
        console.log(`[Terminal ${termId}] PTY process exited with code ${exitCode}, signal ${signal}`);
        const sseRes = TERMINAL_OUTPUT_SSE_CONNECTIONS.get(termId);
        if (sseRes && !sseRes.writableEnded) {
            try {
                sseRes.write(`event: exit\ndata: ${JSON.stringify({ exitCode, signal })}\n\n`);
                sseRes.end(); 
            } catch (e) {
                 console.error(`[Terminal ${termId}] Error writing exit event to SSE stream:`, e);
            }
        }
        TERMINAL_OUTPUT_SSE_CONNECTIONS.delete(termId); 
        activeTerminals.delete(termId); 
    });

    return terminal;
}

function writeToPty(termId: string, data: string): boolean {
    const terminal = activeTerminals.get(termId);
    if (terminal) {
        terminal.ptyProcess.write(data);
        terminal.lastActivity = Date.now();
        return true;
    }
    return false;
}

function resizePty(termId: string, cols: number, rows: number): boolean {
    const terminal = activeTerminals.get(termId);
    if (terminal) {
        try {
             const safeCols = Math.max(1, Math.floor(cols));
             const safeRows = Math.max(1, Math.floor(rows));
             terminal.ptyProcess.resize(safeCols, safeRows);
             terminal.lastActivity = Date.now();
             return true;
        } catch (e) {
             console.error(`[Terminal ${termId}] Error resizing PTY:`, e);
             return false;
        }
    }
    return false;
}

function killPty(termId: string): boolean {
    const terminal = activeTerminals.get(termId);
    if (terminal) {
        terminal.ptyProcess.kill(); 
        return true;
    }
    return false;
}

setInterval(() => {
    const now = Date.now();
    activeTerminals.forEach((terminal, termId) => {
        if (now - terminal.lastActivity > PTY_PROCESS_TIMEOUT_MS) {
            killPty(termId);
        }
    });
}, 1000 * 60 * 5); 

export const terminalRouter = Router();

terminalRouter.post('/start', (req, res) => {
    try {
        const terminal = startPtyProcess();
        res.status(200).json({ termId: terminal.id });
    } catch (e) {
        console.error("[Terminal] Error starting PTY process:", e);
        res.status(500).json({ error: 'Failed to start terminal session.' });
    }
});

terminalRouter.post('/:termId/input', (req, res) => {
    const termId = req.params.termId;
    const input = req.body?.input; 

    if (typeof input !== 'string') {
        return res.status(400).json({ error: 'Invalid input data. Expecting { "input": "string" }.' });
    }

    if (writeToPty(termId, input)) {
        res.status(200).send(); 
    } else {
        res.status(404).json({ error: `Terminal session not found: ${termId}` });
    }
});

terminalRouter.post('/:termId/resize', (req, res) => {
    const termId = req.params.termId;
    const { cols, rows } = req.body;

    if (typeof cols !== 'number' || typeof rows !== 'number' || cols <= 0 || rows <= 0) {
        return res.status(400).json({ error: 'Invalid size data. Expecting { "cols": number, "rows": number }.' });
    }

    if (resizePty(termId, Math.floor(cols), Math.floor(rows))) {
        res.status(200).send(); 
    } else {
        res.status(404).json({ error: `Terminal session not found: ${termId}` });
    }
});

terminalRouter.delete('/:termId', (req, res) => {
    const termId = req.params.termId;
    if (killPty(termId)) {
        res.status(200).json({ message: `Terminal session ${termId} killed.` });
    } else {
        res.status(404).json({ error: `Terminal session not found: ${termId}` });
    }
});

terminalRouter.get('/:termId/output', (req, res) => {
    const termId = req.params.termId;
    const terminal = activeTerminals.get(termId);

    if (!terminal) {
        return res.status(404).json({ error: `Terminal session not found: ${termId}` });
    }

    if (TERMINAL_OUTPUT_SSE_CONNECTIONS.has(termId)) {
         const oldRes = TERMINAL_OUTPUT_SSE_CONNECTIONS.get(termId);
         try { oldRes?.end(); } catch(e){} 
         TERMINAL_OUTPUT_SSE_CONNECTIONS.delete(termId);
    }

    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
    });

    res.write(`event: connected\ndata: ${JSON.stringify({ message: `Connected to terminal ${termId} output` })}\n\n`);
    
    TERMINAL_OUTPUT_SSE_CONNECTIONS.set(termId, res);

    if (terminal.initialOutputBuffer && terminal.initialOutputBuffer.length > 0) {
        terminal.initialOutputBuffer.forEach(bufferedData => {
            try {
                if (!res.writableEnded) {
                    res.write(`event: output\ndata: ${JSON.stringify(bufferedData)}\n\n`);
                }
            } catch (e) {
                console.error(`[Terminal ${termId}] Error writing initial buffered data to SSE stream:`, e);
            }
        });
        terminal.initialOutputBuffer = [];
    }


    req.on('close', () => {
        TERMINAL_OUTPUT_SSE_CONNECTIONS.delete(termId);
    });
});

terminalRouter.get('/list', (req, res) => {
    const terms = Array.from(activeTerminals.keys()).map(id => {
        const term = activeTerminals.get(id);
        return {
            id,
            pid: term?.ptyProcess.pid,
            lastActivity: term?.lastActivity,
            bufferSize: term?.initialOutputBuffer?.length || 0
        };
    });
    res.json({ terminals: terms });
});

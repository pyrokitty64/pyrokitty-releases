/**
 * Backend child process — holds the bot connection and handles tool calls.
 * Communicates with wrapper.ts via Node IPC (process.send / process.on('message')).
 */

import { BotManager } from './bot-manager.js';
import { allTools, type ToolDef } from './tools/index.js';
import type { WrapperMessage, BackendMessage } from './ipc-types.js';
import { log, logError } from './debug-log.js';

const botManager = new BotManager();

// Build tool lookup map
const toolMap = new Map<string, ToolDef>();
for (const tool of allTools) {
  toolMap.set(tool.name, tool);
}

function send(msg: BackendMessage): void {
  process.send!(msg);
}

process.on('message', async (msg: WrapperMessage) => {
  if (msg.type === 'list-tools') {
    send({
      type: 'tools',
      tools: allTools.map(t => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    });
  } else if (msg.type === 'call') {
    const tool = toolMap.get(msg.tool);
    if (!tool) {
      send({
        type: 'result',
        reqId: msg.reqId,
        content: [{ type: 'text', text: `Unknown tool: ${msg.tool}` }],
        isError: true,
      });
      return;
    }

    try {
      const result = await tool.handler(msg.args, botManager);
      send({
        type: 'result',
        reqId: msg.reqId,
        content: result.content,
        isError: result.isError,
      });
    } catch (err: any) {
      logError('backend', `Tool ${msg.tool} threw`, err);
      send({
        type: 'result',
        reqId: msg.reqId,
        content: [{ type: 'text', text: `Error: ${err.message}` }],
        isError: true,
      });
    }
  }
});

// Signal ready
send({ type: 'ready' });
log('backend', `Ready with ${allTools.length} tools`);
console.error('[backend] Ready');

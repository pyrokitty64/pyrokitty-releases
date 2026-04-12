/**
 * Avatar export tool: export a complete SL avatar as a single GLB file.
 */

import type { ToolDef } from './session.js';
import { exportAvatar } from '../avatar-exporter.js';

export const avatarExportTools: ToolDef[] = [
  {
    name: 'sl_get_avatar_animations',
    description: 'Get the list of animation UUIDs currently playing on an avatar. Also checks the local animation cache for decoded animation data.',
    inputSchema: {
      type: 'object',
      properties: {
        avatarId: { type: 'string', description: 'UUID of the avatar. Omit for self.' },
      },
    },
    handler: async (args, bot) => {
      const avatarId = (args.avatarId as string) || bot.getBot()?.agentID().toString() || '';
      const anims = bot.getPlayingAnimations(avatarId);
      if (!anims || anims.length === 0) {
        return { content: [{ type: 'text', text: `No animations cached for ${avatarId}. The avatar may not have sent an AvatarAnimation message yet.` }] };
      }
      // Check which are in the local animation cache
      const { existsSync } = await import('node:fs');
      const { join, dirname } = await import('node:path');
      const { fileURLToPath } = await import('node:url');
      const cacheDir = join(process.env.APPDATA || '', 'pyrokitty-ui', 'asset-cache', 'animations');
      const lines: string[] = [`${anims.length} animations playing on ${avatarId}:`];
      for (const uuid of anims) {
        const cached = existsSync(join(cacheDir, `${uuid}.json`));
        lines.push(`  ${uuid}${cached ? ' [CACHED]' : ''}`);
      }
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  },
  {
    name: 'sl_export_avatar',
    description: 'Export a complete avatar (skeleton + all worn mesh attachments + textures) as a single GLB file. Omit avatarId to export the bot\'s own avatar.',
    inputSchema: {
      type: 'object',
      properties: {
        avatarId: { type: 'string', description: 'UUID of the avatar to export. Omit for self (bot avatar).' },
        outputPath: { type: 'string', description: 'File path for the output .glb file. Default: avatar_{name}.glb in current directory.' },
        includeTextures: { type: 'boolean', description: 'Embed textures in GLB (default: true). Set false for geometry-only export.' },
      },
    },
    handler: async (args, bot) => {
      try {
        const result = await exportAvatar(bot, {
          avatarId: args.avatarId as string | undefined,
          outputPath: args.outputPath as string | undefined,
          includeTextures: args.includeTextures as boolean | undefined,
        });
        return { content: [{ type: 'text', text: result }] };
      } catch (err: any) {
        return {
          content: [{ type: 'text', text: `Export failed: ${err.message}\n${err.stack}` }],
          isError: true,
        };
      }
    },
  },
];

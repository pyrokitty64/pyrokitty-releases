/**
 * Navigation tools: teleport, walk to, get nearby avatars, get region info, remote parcel info
 */

import type { ToolDef } from './session.js';
import type { BotManager } from '../bot-manager.js';

export const navigationTools: ToolDef[] = [
  {
    name: 'sl_teleport',
    description: 'Teleport the bot to a named region with optional coordinates.',
    inputSchema: {
      type: 'object',
      properties: {
        regionName: { type: 'string', description: 'Region name to teleport to' },
        x: { type: 'number', description: 'X coordinate (default: 128)' },
        y: { type: 'number', description: 'Y coordinate (default: 128)' },
        z: { type: 'number', description: 'Z coordinate (default: 30)' },
      },
      required: ['regionName'],
    },
    handler: async (args, bot) => {
      try {
        const result = await bot.teleport(
          args.regionName as string,
          args.x as number | undefined,
          args.y as number | undefined,
          args.z as number | undefined,
        );
        return { content: [{ type: 'text', text: result }] };
      } catch (err: any) {
        return { content: [{ type: 'text', text: `Teleport failed: ${err.message}` }], isError: true };
      }
    },
  },
  {
    name: 'sl_walk_to',
    description: 'Walk the bot to a target position (not teleport). The bot will physically walk across the ground. Can also walk to a nearby avatar by name.',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'Target X coordinate' },
        y: { type: 'number', description: 'Target Y coordinate' },
        z: { type: 'number', description: 'Target Z coordinate (optional, only affects stop height)' },
        avatarName: { type: 'string', description: 'Walk to a nearby avatar by display name or legacy name (instead of specifying x/y/z)' },
        stopDistance: { type: 'number', description: 'How close to get before stopping (default: 2.0m)' },
      },
    },
    handler: async (args, bot) => {
      try {
        let targetX = args.x as number | undefined;
        let targetY = args.y as number | undefined;
        let targetZ = args.z as number | undefined ?? 0;

        // If avatarName provided, find their position
        if (args.avatarName) {
          const avatars = await bot.getNearbyAvatars();
          const name = (args.avatarName as string).toLowerCase();
          const match = avatars.find(a =>
            a.name.toLowerCase().includes(name) ||
            (a.displayName && a.displayName.toLowerCase().includes(name))
          );
          if (!match) {
            return { content: [{ type: 'text', text: `No nearby avatar matching "${args.avatarName}"` }], isError: true };
          }
          targetX = match.position.x;
          targetY = match.position.y;
          targetZ = match.position.z;
        }

        if (targetX === undefined || targetY === undefined) {
          return { content: [{ type: 'text', text: 'Provide x/y coordinates or avatarName' }], isError: true };
        }

        const result = await bot.walkTo(
          targetX, targetY, targetZ,
          (args.stopDistance as number) || 2.0,
        );
        return { content: [{ type: 'text', text: result }] };
      } catch (err: any) {
        return { content: [{ type: 'text', text: `Walk failed: ${err.message}` }], isError: true };
      }
    },
  },
  {
    name: 'sl_fly',
    description: 'Toggle flight mode on or off for the bot.',
    inputSchema: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean', description: 'true to start flying, false to stop flying and land' },
      },
      required: ['enabled'],
    },
    handler: async (args, bot) => {
      await bot.setFlying(args.enabled as boolean);
      return { content: [{ type: 'text', text: args.enabled ? 'Now flying' : 'Stopped flying' }] };
    },
  },
  {
    name: 'sl_sit',
    description: 'Sit the bot on an in-world object by its local ID.',
    inputSchema: {
      type: 'object',
      properties: {
        localId: { type: 'number', description: 'Object local ID to sit on' },
      },
      required: ['localId'],
    },
    handler: async (args, bot) => {
      try {
        await bot.sitOnObject(args.localId as number);
        return { content: [{ type: 'text', text: `Sat on object ${args.localId}` }] };
      } catch (err: any) {
        return { content: [{ type: 'text', text: `Failed to sit: ${err.message}` }], isError: true };
      }
    },
  },
  {
    name: 'sl_stand',
    description: 'Stand up from sitting.',
    inputSchema: { type: 'object', properties: {} },
    handler: async (_args, bot) => {
      try {
        await bot.standUp();
        return { content: [{ type: 'text', text: 'Stood up' }] };
      } catch (err: any) {
        return { content: [{ type: 'text', text: `Failed to stand: ${err.message}` }], isError: true };
      }
    },
  },
  {
    name: 'sl_sit_on_ground',
    description: 'Sit on the ground.',
    inputSchema: { type: 'object', properties: {} },
    handler: async (_args, bot) => {
      try {
        await bot.sitOnGround();
        return { content: [{ type: 'text', text: 'Sat on ground' }] };
      } catch (err: any) {
        return { content: [{ type: 'text', text: `Failed to sit on ground: ${err.message}` }], isError: true };
      }
    },
  },
  {
    name: 'sl_get_nearby_avatars',
    description: 'List avatars currently in the same region, with their positions.',
    inputSchema: { type: 'object', properties: {} },
    handler: async (_args, bot) => {
      const avatars = await bot.getNearbyAvatars();
      if (avatars.length === 0) {
        return { content: [{ type: 'text', text: 'No nearby avatars.' }] };
      }
      const lines = avatars.map(a => {
        const nameDisplay = a.displayName
          ? `${a.displayName} (${a.name})`
          : a.name;
        return `${nameDisplay} (${a.id}) at (${a.position.x.toFixed(1)}, ${a.position.y.toFixed(1)}, ${a.position.z.toFixed(1)})`;
      });
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  },
  {
    name: 'sl_get_region_info',
    description: 'Get current region name, grid coordinates, and agent position.',
    inputSchema: { type: 'object', properties: {} },
    handler: async (_args, bot) => {
      const info = bot.getRegionInfo();
      if (!info) {
        return { content: [{ type: 'text', text: 'Not connected to a region.' }], isError: true };
      }
      return { content: [{ type: 'text', text: JSON.stringify(info, null, 2) }] };
    },
  },
  {
    name: 'sl_remote_parcel_info',
    description: 'Get parcel info (name, snapshot, owner) at a specific location in any region. Provide either region_id or grid_x+grid_y.',
    inputSchema: {
      type: 'object',
      properties: {
        region_id: { type: 'string', description: 'Region UUID (alternative to grid_x+grid_y)' },
        grid_x: { type: 'number', description: 'Region grid X coordinate (alternative to region_id)' },
        grid_y: { type: 'number', description: 'Region grid Y coordinate (alternative to region_id)' },
        x: { type: 'number', description: 'Local X coordinate (0-256)' },
        y: { type: 'number', description: 'Local Y coordinate (0-256)' },
        z: { type: 'number', description: 'Local Z coordinate (default: 0)' },
      },
      required: ['x', 'y'],
    },
    handler: async (args, bot) => {
      const rawBot = bot.getBot();
      if (!rawBot) {
        return { content: [{ type: 'text', text: 'Not logged in.' }], isError: true };
      }

      const info = await rawBot.clientCommands.parcel.getRemoteParcelInfo({
        regionId: args.region_id as string | undefined,
        gridX: args.grid_x as number | undefined,
        gridY: args.grid_y as number | undefined,
        x: args.x as number,
        y: args.y as number,
        z: (args.z as number) ?? 0,
      });

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            name: info.ParcelName,
            description: info.ParcelDescription,
            snapshotId: info.SnapshotID?.toString(),
            owner: info.OwnerID?.toString(),
            area: info.Area,
            regionName: info.RegionName,
            globalPos: { x: info.GlobalCoordinates?.x, y: info.GlobalCoordinates?.y, z: info.GlobalCoordinates?.z },
            dwell: info.Traffic,
            salePrice: info.SalePrice,
          }, null, 2),
        }],
      };
    },
  },
];

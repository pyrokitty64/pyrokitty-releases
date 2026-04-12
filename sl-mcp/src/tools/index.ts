/**
 * Tool registry — collects and exports all tool definitions.
 */

import { sessionTools, type ToolDef } from './session.js';
import { chatTools } from './chat.js';
import { navigationTools } from './navigation.js';
import { socialTools } from './social.js';
import { objectTools } from './objects.js';
import { minesweeperTools } from './minesweeper.js';
import { avatarExportTools } from './avatar-export.js';

export type { ToolDef };

export const allTools: ToolDef[] = [
  ...sessionTools,
  ...chatTools,
  ...navigationTools,
  ...socialTools,
  ...objectTools,
  ...minesweeperTools,
  ...avatarExportTools,
];

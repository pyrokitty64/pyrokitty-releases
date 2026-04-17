/**
 * Test child agent cascading behavior.
 *
 * Usage: cd electron-ui && npx tsx scripts/test-child-agents.ts [options] [start-location]
 *   direction: north, south, east, west (default: east)
 *   --draw N: set draw distance (default: 1024)
 *   --no-sweep: disable camera stepping, just wait and observe
 *   --spiral: sweep camera in expanding spiral (8 directions)
 *   --wait N: initial wait seconds (default: 15, use higher for no-sweep)
 */

import { Bot, BotOptionFlags, LoginParameters, Vector3 } from '../node-metaverse/lib';
import * as fs from 'fs';
import * as path from 'path';

const accountsPath = path.join(__dirname, '..', 'data', 'accounts.json');
const accounts = JSON.parse(fs.readFileSync(accountsPath, 'utf-8'));
const acct = accounts[0];

const args = process.argv.slice(2);
const dirArg = args.find(a => ['north','south','east','west'].includes(a)) || 'east';
const drawIdx = args.indexOf('--draw');
const drawDist = drawIdx >= 0 ? parseInt(args[drawIdx + 1], 10) : 1024;
const noSweep = args.includes('--no-sweep');
const spiral = args.includes('--spiral');
const waitIdx = args.indexOf('--wait');
const waitSec = waitIdx >= 0 ? parseInt(args[waitIdx + 1], 10) : (noSweep ? 60 : 15);
const startLoc = args.find(a => !['north','south','east','west'].includes(a) && !a.startsWith('--') && isNaN(Number(a))) || 'uri:Makkeolli&43&67&63';

const dirMap: Record<string, { dx: number; dy: number }> = {
  east:  { dx: 1, dy: 0 },
  west:  { dx: -1, dy: 0 },
  north: { dx: 0, dy: 1 },
  south: { dx: 0, dy: -1 },
};
const dir = dirMap[dirArg];

async function main() {
  const loginParams = new LoginParameters();
  loginParams.firstName = acct.firstName;
  loginParams.lastName = acct.lastName;
  loginParams.password = acct.password;
  loginParams.start = startLoc;

  const bot = new Bot(loginParams, BotOptionFlags.None);

  console.log(`Logging in as ${acct.firstName} ${acct.lastName}...`);
  await bot.login();

  bot.agent.cameraFar = drawDist;

  // Track regions
  const connectedRegions = new Map<string, number>(); // "x,y" -> timestamp
  bot.clientEvents.onEnableSimulator.subscribe((evt) => {
    const gridX = evt.regionHandle.high / 256;
    const gridY = evt.regionHandle.low / 256;
    const key = `${gridX},${gridY}`;
    if (!connectedRegions.has(key)) {
      connectedRegions.set(key, Date.now());
    }
  });
  bot.clientEvents.onEstablishAgentCommunication.subscribe(() => {});

  console.log('Connecting to sim...');
  await bot.connectToSim();

  const region = bot.currentRegion;
  const mainX = region.xCoordinate;
  const mainY = region.yCoordinate;
  console.log(`Connected to ${region.regionName} (${mainX}, ${mainY})`);
  console.log(`Direction: ${dirArg} (dx=${dir.dx}, dy=${dir.dy})`);
  console.log(`cameraFar = ${bot.agent.cameraFar}m\n`);

  const cam = bot.childAgentManager;
  if (!cam) {
    console.log('ERROR: childAgentManager is undefined!');
    return;
  }

  // Wait for initial cascade
  console.log(`Waiting ${waitSec}s for initial cascade...`);
  await new Promise(r => setTimeout(r, waitSec * 1000));

  function maxDistInDirection(): number {
    let maxDist = 0;
    for (const key of connectedRegions.keys()) {
      const [x, y] = key.split(',').map(Number);
      // Distance along our chosen direction only
      const dist = (x - mainX) * dir.dx + (y - mainY) * dir.dy;
      if (dist > maxDist) maxDist = dist;
    }
    return maxDist;
  }

  const baseX = bot.agent.cameraCenter.x;
  const baseY = bot.agent.cameraCenter.y;
  const baseZ = bot.agent.cameraCenter.z;

  console.log(`Initial: ${connectedRegions.size} regions, max ${dirArg} distance = ${maxDistInDirection()} regions\n`);

  let lastMaxDist = maxDistInDirection();

  if (noSweep) {
    console.log(`No sweep mode — just observing.\n`);
  } else {
    console.log(`Stepping camera ${dirArg}, 256m per step...\n`);

    const maxSteps = 30; // Up to 30 regions out
    let staleCount = 0;

    for (let step = 1; step <= maxSteps; step++) {
      const cx = baseX + dir.dx * 256 * step;
      const cy = baseY + dir.dy * 256 * step;
      bot.agent.cameraCenter = new Vector3([cx, cy, baseZ]);

      // Wait for server to respond
      await new Promise(r => setTimeout(r, 3000));

      const dist = maxDistInDirection();
      const total = connectedRegions.size;
      const activeChildren = cam.childCount;

      console.log(`  Step ${step}: camera at +${step * 256}m ${dirArg} → max dist = ${dist} regions (${dist * 256}m), total seen = ${total}, active = ${activeChildren}`);

      if (dist > lastMaxDist) {
        lastMaxDist = dist;
        staleCount = 0;
      } else {
        staleCount++;
        if (staleCount >= 5) {
          console.log(`\n  No progress for 5 steps — stopping.`);
          break;
        }
      }
    }

    // Reset camera
    bot.agent.cameraCenter = new Vector3([baseX, baseY, baseZ]);
  }

  console.log(`\n=== FINAL RESULTS ===`);
  console.log(`Direction: ${dirArg}`);
  console.log(`Max distance reached: ${lastMaxDist} regions (${lastMaxDist * 256}m)`);
  console.log(`Total unique regions seen: ${connectedRegions.size}`);
  console.log(`Active child connections: ${cam.childCount}`);

  console.log('\nLogging out...');
  await bot.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});

/**
 * Handles input from Godot (movement, object interaction).
 */

import type { Bot } from '../../../node-metaverse/dist/lib';
import { ControlFlags, PacketFlags } from '../../../node-metaverse/dist/lib';
import { ObjectSelectMessage } from '../../../node-metaverse/dist/lib/classes/messages/ObjectSelect';
import { ObjectDeselectMessage } from '../../../node-metaverse/dist/lib/classes/messages/ObjectDeselect';
import { SetAlwaysRunMessage } from '../../../node-metaverse/dist/lib/classes/messages/SetAlwaysRun';
import { RequestPayPriceMessage } from '../../../node-metaverse/dist/lib/classes/messages/RequestPayPrice';
import type { PayPriceReplyMessage } from '../../../node-metaverse/dist/lib/classes/messages/PayPriceReply';
import { Message } from '../../../node-metaverse/dist/lib/enums/Message';
import { ChatType } from '../../../node-metaverse/dist/lib/enums/ChatType';
import { FilterResponse } from '../../../node-metaverse/dist/lib/enums/FilterResponse';
import type { ScriptDialogEvent } from '../../../node-metaverse/dist/lib/events/ScriptDialogEvent';
import type { LureEvent } from '../../../node-metaverse/dist/lib/events/LureEvent';
import type { SendFn } from './godot-bridge-types';
import { pkDebug } from '../pk-debug';

const CLICK_ACTION_SIT = 1;

export class GodotInputHandler {
  private _dbgMoving = false;
  private _dbgAgentNullAt = 0;
  private _lastRunning = false;
  private _sittingOnLocalId = 0;
  private _sitPosition: number[] | null = null;
  private _sitRotation: number[] | null = null;
  private _pendingDialogs = new Map<string, ScriptDialogEvent>();
  private _pendingLures = new Map<string, LureEvent>();

  constructor(private bot: Bot, private send: SendFn) {}

  handleInputMove(msg: any): void {
    const agent = this.bot.agent;
    if (!agent) {
      const now = Date.now();
      if (this._dbgAgentNullAt === 0) this._dbgAgentNullAt = now;
      if (now - this._dbgAgentNullAt < 1100) {
        console.warn(`[GodotBridge] input_move dropped — bot.agent is null (no circuit?)`);
      }
      return;
    }
    if (this._dbgAgentNullAt !== 0) {
      pkDebug('input', `[GodotBridge] bot.agent restored after ${((Date.now() - this._dbgAgentNullAt) / 1000).toFixed(1)}s`);
      this._dbgAgentNullAt = 0;
    }

    const isMoving = msg.forward || msg.backward || msg.strafe_left || msg.strafe_right
      || msg.jump || msg.crouch;
    if (isMoving && !this._dbgMoving) {
      pkDebug('input', `[GodotBridge] Movement started fwd=${msg.forward} back=${msg.backward} sl=${msg.strafe_left} sr=${msg.strafe_right}`);
      this._dbgMoving = true;
    } else if (!isMoving && this._dbgMoving) {
      pkDebug('input', `[GodotBridge] Movement stopped`);
      this._dbgMoving = false;
    }

    // Forward/backward — always pair with FAST_AT (matching Firestorm llagent.cpp:774)
    if (msg.forward) {
      agent.setControlFlag(ControlFlags.AGENT_CONTROL_AT_POS | ControlFlags.AGENT_CONTROL_FAST_AT);
    } else {
      agent.clearControlFlag(ControlFlags.AGENT_CONTROL_AT_POS);
    }
    if (msg.backward) {
      agent.setControlFlag(ControlFlags.AGENT_CONTROL_AT_NEG | ControlFlags.AGENT_CONTROL_FAST_AT);
    } else {
      agent.clearControlFlag(ControlFlags.AGENT_CONTROL_AT_NEG);
    }
    if (msg.jump) {
      agent.setControlFlag(ControlFlags.AGENT_CONTROL_UP_POS);
    } else {
      agent.clearControlFlag(ControlFlags.AGENT_CONTROL_UP_POS);
    }
    if (msg.crouch) {
      agent.setControlFlag(ControlFlags.AGENT_CONTROL_UP_NEG);
    } else {
      agent.clearControlFlag(ControlFlags.AGENT_CONTROL_UP_NEG);
    }

    // Strafe
    if (msg.strafe_left) {
      agent.setControlFlag(ControlFlags.AGENT_CONTROL_LEFT_POS);
    } else {
      agent.clearControlFlag(ControlFlags.AGENT_CONTROL_LEFT_POS);
    }
    if (msg.strafe_right) {
      agent.setControlFlag(ControlFlags.AGENT_CONTROL_LEFT_NEG);
    } else {
      agent.clearControlFlag(ControlFlags.AGENT_CONTROL_LEFT_NEG);
    }

    // Run — send SetAlwaysRun on change
    const running = !!msg.running;
    if (!msg.forward && !msg.backward) {
      agent.clearControlFlag(ControlFlags.AGENT_CONTROL_FAST_AT);
    }
    if (running !== this._lastRunning) {
      pkDebug('input', `[GodotBridge] Running changed: ${running} — sending SetAlwaysRun`);
      this._lastRunning = running;
      const runMsg = new SetAlwaysRunMessage();
      runMsg.AgentData = {
        AgentID: this.bot.agent.agentID,
        SessionID: this.bot.currentRegion!.circuit.sessionID,
        AlwaysRun: running,
      };
      this.bot.currentRegion!.circuit.sendMessage(runMsg, PacketFlags.Reliable);
    }

    // Fly toggle
    if (typeof msg.fly === 'boolean') {
      if (msg.fly) {
        agent.setControlFlag(ControlFlags.AGENT_CONTROL_FLY);
      } else {
        agent.clearControlFlag(ControlFlags.AGENT_CONTROL_FLY);
      }
    }

    // Set body rotation from camera yaw
    if (typeof msg.yaw === 'number') {
      const slHeading = msg.yaw + Math.PI / 2;
      const halfAngle = slHeading / 2;
      let qz = Math.sin(halfAngle);
      let qw = Math.cos(halfAngle);
      if (qw < 0) { qz = -qz; qw = -qw; }
      (agent as any).bodyRotation.x = 0;
      (agent as any).bodyRotation.y = 0;
      (agent as any).bodyRotation.z = qz;
      (agent as any).bodyRotation.w = qw;
    }

    // Update camera from Godot (already in SL coordinates)
    this.applyCameraData(agent, msg);

    agent.sendAgentUpdate();
  }

  /** Handle standalone camera update (orbit/zoom without movement) */
  handleCameraUpdate(msg: any): void {
    const agent = this.bot.agent;
    if (!agent) return;
    this.applyCameraData(agent, msg);
    agent.sendAgentUpdate();
  }

  /** Apply camera position + axes from Godot message to Agent */
  private applyCameraData(agent: any, msg: any): void {
    if (msg.cameraCenter) {
      const c = msg.cameraCenter;
      agent.cameraCenter.x = c[0];
      agent.cameraCenter.y = c[1];
      agent.cameraCenter.z = c[2];
      agent.cameraSetByViewer = true;
    }
    if (msg.cameraAtAxis) {
      const a = msg.cameraAtAxis;
      agent.cameraLookAt.x = a[0];
      agent.cameraLookAt.y = a[1];
      agent.cameraLookAt.z = a[2];
    }
    if (msg.cameraLeftAxis) {
      const l = msg.cameraLeftAxis;
      agent.cameraLeftAxis.x = l[0];
      agent.cameraLeftAxis.y = l[1];
      agent.cameraLeftAxis.z = l[2];
    }
    if (msg.cameraUpAxis) {
      const u = msg.cameraUpAxis;
      agent.cameraUpAxis.x = u[0];
      agent.cameraUpAxis.y = u[1];
      agent.cameraUpAxis.z = u[2];
    }
  }

  async handleRequestObjectProperties(uuid: string): Promise<void> {
    try {
      const region = this.bot.currentRegion;
      if (!region) return;
      const { UUID } = await import('../../../node-metaverse/dist/lib/classes/UUID');
      const obj = region.objects?.getObjectByUUID(new UUID(uuid));
      if (!obj) {
        this.send({ type: 'object_properties', uuid, name: '', description: '' });
        return;
      }

      if (obj.resolvedAt) {
        this.send({ type: 'object_properties', uuid, name: obj.name || '', description: obj.description || '' });
        return;
      }

      // Send ObjectSelect to request properties from server (uses localId for sim protocol)
      const localId = obj.ID;
      const selectMsg = new ObjectSelectMessage();
      selectMsg.AgentData = {
        AgentID: region.agent.agentID,
        SessionID: region.circuit.sessionID,
      };
      selectMsg.ObjectData = [{ ObjectLocalID: localId }];
      region.circuit.sendMessage(selectMsg, PacketFlags.Reliable);

      // Poll for properties
      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 100));
        if (obj.resolvedAt || obj.name !== undefined) break;
      }

      // Deselect
      const deselectMsg = new ObjectDeselectMessage();
      deselectMsg.AgentData = {
        AgentID: region.agent.agentID,
        SessionID: region.circuit.sessionID,
      };
      deselectMsg.ObjectData = [{ ObjectLocalID: localId }];
      region.circuit.sendMessage(deselectMsg, PacketFlags.Reliable);

      this.send({ type: 'object_properties', uuid, name: obj.name || '', description: obj.description || '' });
    } catch (e) {
      console.error(`[GodotBridge] request_object_properties failed for ${uuid}:`, e);
      this.send({ type: 'object_properties', uuid, name: '', description: '' });
    }
  }

  async handleSetObjectName(uuid: string, name: string): Promise<void> {
    try {
      const { UUID } = await import('../../../node-metaverse/dist/lib/classes/UUID');
      const obj = this.bot.currentRegion?.objects?.getObjectByUUID(new UUID(uuid));
      if (!obj) {
        console.warn(`[GodotBridge] set_object_name: object ${uuid} not found`);
        return;
      }
      await obj.setName(name);
      console.log(`[GodotBridge] Renamed object ${uuid.slice(0, 8)} to "${name}"`);
    } catch (e) {
      console.error(`[GodotBridge] set_object_name failed for ${uuid}:`, e);
    }
  }

  async handleSetObjectDescription(uuid: string, description: string): Promise<void> {
    try {
      const { UUID } = await import('../../../node-metaverse/dist/lib/classes/UUID');
      const obj = this.bot.currentRegion?.objects?.getObjectByUUID(new UUID(uuid));
      if (!obj) {
        console.warn(`[GodotBridge] set_object_description: object ${uuid} not found`);
        return;
      }
      await obj.setDescription(description);
      console.log(`[GodotBridge] Set description on object ${uuid.slice(0, 8)}`);
    } catch (e) {
      console.error(`[GodotBridge] set_object_description failed for ${uuid}:`, e);
    }
  }

  handleStandUp(): void {
    this.bot.clientCommands.movement.stand();
    this._sittingOnLocalId = 0;
    this._sitPosition = null;
    this._sitRotation = null;
    this._groundSitting = false;
    this.send({ type: 'sitting_state', sitting: false });
    console.log('[GodotBridge] Stood up');
  }

  private _groundSitting = false;

  handleSitOrStand(): void {
    if (this.isSitting || this._groundSitting) {
      this.handleStandUp();
    } else {
      this.bot.clientCommands.movement.sitOnGround();
      this._groundSitting = true;
      this.send({ type: 'sitting_state', sitting: true });
      console.log('[GodotBridge] Sat on ground');
    }
  }

  get isSitting(): boolean { return this._sittingOnLocalId !== 0; }

  /** Called by GodotBridge when server confirms a ParentID change on the self avatar. */
  setSittingState(sitting: boolean, seatLocalId: number, position?: number[], rotation?: number[]): void {
    this._sittingOnLocalId = sitting ? seatLocalId : 0;
    if (sitting && position && rotation) {
      this._sitPosition = position;
      this._sitRotation = rotation;
    } else if (!sitting) {
      this._sitPosition = null;
      this._sitRotation = null;
    }
  }

  getSitState(): { seatLocalId: number; position: number[] | null; rotation: number[] | null } {
    return {
      seatLocalId: this._sittingOnLocalId,
      position: this._sitPosition,
      rotation: this._sitRotation,
    };
  }

  async handleObjectPay(msg: any): Promise<void> {
    try {
      const region = this.bot.currentRegion;
      if (!region) return;
      const objectUuid: string = msg.uuid;
      const { UUID } = await import('../../../node-metaverse/dist/lib/classes/UUID');
      const obj = region.objects?.getObjectByUUID(new UUID(objectUuid));
      if (!obj) {
        console.warn(`[GodotBridge] object_pay: object ${objectUuid} not found`);
        return;
      }
      // Request pay price options from the server
      const reqMsg = new RequestPayPriceMessage();
      reqMsg.ObjectData = { ObjectID: new UUID(objectUuid) };
      region.circuit.sendMessage(reqMsg, PacketFlags.Reliable);
      const reply = await region.circuit.waitForMessage<PayPriceReplyMessage>(
        Message.PayPriceReply, 10000,
        (m: PayPriceReplyMessage): FilterResponse => {
          if (m.ObjectData.ObjectID.toString() === objectUuid) return FilterResponse.Finish;
          return FilterResponse.NoMatch;
        },
      );
      const defaultPrice = reply.ObjectData.DefaultPayPrice;
      const buttons = reply.ButtonData.map(b => b.PayButton);
      console.log(`[GodotBridge] PayPrice for ${objectUuid.slice(0, 8)}: default=${defaultPrice} buttons=[${buttons.join(',')}]`);
      // Send pay options to Godot for UI display
      this.send({
        type: 'pay_options',
        uuid: objectUuid,
        defaultPrice,
        buttons,
      });
    } catch (e) {
      console.error(`[GodotBridge] object_pay failed for ${msg.uuid}:`, e);
    }
  }

  async handlePayConfirm(msg: any): Promise<void> {
    try {
      const region = this.bot.currentRegion;
      if (!region) return;
      const objectUuid: string = msg.uuid;
      const amount: number = msg.amount;
      if (!amount || amount <= 0) {
        console.warn(`[GodotBridge] pay_confirm: invalid amount ${amount}`);
        return;
      }
      const { UUID } = await import('../../../node-metaverse/dist/lib/classes/UUID');
      const obj = region.objects?.getObjectByUUID(new UUID(objectUuid));
      if (!obj) {
        console.warn(`[GodotBridge] pay_confirm: object ${objectUuid} not found`);
        return;
      }
      await this.bot.clientCommands.grid.payObject(obj, amount);
      console.log(`[GodotBridge] Paid L$${amount} to object ${objectUuid.slice(0, 8)}`);
      this.send({ type: 'pay_result', uuid: objectUuid, success: true, amount });
    } catch (e) {
      console.error(`[GodotBridge] pay_confirm failed for ${msg.uuid}:`, e);
      this.send({ type: 'pay_result', uuid: msg.uuid, success: false, amount: msg.amount });
    }
  }

  async handleObjectSit(msg: any): Promise<void> {
    try {
      const region = this.bot.currentRegion;
      if (!region) return;
      const objectUuid: string = msg.uuid;
      const { UUID } = await import('../../../node-metaverse/dist/lib/classes/UUID');
      const { Vector3 } = await import('../../../node-metaverse/dist/lib/classes/Vector3');
      const obj = region.objects?.getObjectByUUID(new UUID(objectUuid));
      if (!obj) {
        console.warn(`[GodotBridge] object_sit: object ${objectUuid} not found`);
        return;
      }
      const localId = obj.ID;
      if (this._sittingOnLocalId === localId) {
        pkDebug('input', `[GodotBridge] Already sitting on ${objectUuid.slice(0, 8)}, ignoring`);
        return;
      }
      const targetUuid = new UUID(obj.FullID.toString());
      await this.bot.clientCommands.movement.sitOnObject(targetUuid, Vector3.getZero());
      this._sittingOnLocalId = localId;
      console.log(`[GodotBridge] Sat on object ${objectUuid.slice(0, 8)} (action bar)`);
    } catch (e) {
      console.error(`[GodotBridge] object_sit failed for ${msg.uuid}:`, e);
    }
  }

  async handleObjectTouch(msg: any): Promise<void> {
    try {
      const region = this.bot.currentRegion;
      if (!region) return;
      const objectUuid: string = msg.uuid;
      const { UUID } = await import('../../../node-metaverse/dist/lib/classes/UUID');
      const obj = region.objects?.getObjectByUUID(new UUID(objectUuid));
      if (!obj) {
        console.warn(`[GodotBridge] object_touch: object ${objectUuid} not found`);
        return;
      }

      const localId = obj.ID;

      // If the object's default action is SIT and we're not already sitting on it, sit.
      if (obj.ClickAction === CLICK_ACTION_SIT && this._sittingOnLocalId !== localId) {
        const { Vector3 } = await import('../../../node-metaverse/dist/lib/classes/Vector3');
        const targetUuid = new UUID(obj.FullID.toString());
        await this.bot.clientCommands.movement.sitOnObject(targetUuid, Vector3.getZero());
        this._sittingOnLocalId = localId;
        console.log(`[GodotBridge] Sat on object ${objectUuid.slice(0, 8)} (ClickAction=Sit)`);
        return;
      }

      const faceIndex = msg.faceIndex || 0;
      const { stCoord, uvCoord } = this._parseSTCoord(msg);
      await this.bot.clientCommands.region.touchObject(localId, faceIndex, stCoord, uvCoord);
      pkDebug('input', `[GodotBridge] Touched object ${objectUuid.slice(0, 8)} face=${faceIndex} st=(${msg.st?.x?.toFixed(2)},${msg.st?.y?.toFixed(2)})`);
    } catch (e) {
      console.error(`[GodotBridge] object_touch failed for ${msg.uuid}:`, e);
    }
  }

  async handleObjectTouchStart(msg: any): Promise<void> {
    try {
      const region = this.bot.currentRegion;
      if (!region) return;
      const objectUuid: string = msg.uuid;
      const { UUID } = await import('../../../node-metaverse/dist/lib/classes/UUID');
      const obj = region.objects?.getObjectByUUID(new UUID(objectUuid));
      if (!obj) return;

      // SIT override
      if (obj.ClickAction === CLICK_ACTION_SIT && this._sittingOnLocalId !== obj.ID) {
        const { Vector3 } = await import('../../../node-metaverse/dist/lib/classes/Vector3');
        await this.bot.clientCommands.movement.sitOnObject(new UUID(obj.FullID.toString()), Vector3.getZero());
        this._sittingOnLocalId = obj.ID;
        pkDebug('input', `[GodotBridge] Sat on object ${objectUuid.slice(0, 8)} (ClickAction=Sit)`);
        return;
      }

      const faceIndex = msg.faceIndex || 0;
      const { stCoord, uvCoord } = this._parseSTCoord(msg);
      await this.bot.clientCommands.region.grabObject(obj.ID, faceIndex, stCoord, uvCoord);
      pkDebug('input', `[GodotBridge] touch_start ${objectUuid.slice(0, 8)} face=${faceIndex} st=(${msg.st?.x?.toFixed(2)},${msg.st?.y?.toFixed(2)})`);
    } catch (e) {
      console.error(`[GodotBridge] object_touch_start failed for ${msg.uuid}:`, e);
    }
  }

  async handleObjectTouchMove(msg: any): Promise<void> {
    try {
      const region = this.bot.currentRegion;
      if (!region) return;
      const { UUID } = await import('../../../node-metaverse/dist/lib/classes/UUID');
      const obj = region.objects?.getObjectByUUID(new UUID(msg.uuid));
      if (!obj) return;

      const faceIndex = msg.faceIndex || 0;
      const { stCoord, uvCoord } = this._parseSTCoord(msg);
      await this.bot.clientCommands.region.dragGrabbedObject(
        new UUID(obj.FullID.toString()), faceIndex, stCoord, uvCoord
      );
    } catch (e) {
      console.error(`[GodotBridge] object_touch_move failed for ${msg.uuid}:`, e);
    }
  }

  async handleObjectTouchEnd(msg: any): Promise<void> {
    try {
      const region = this.bot.currentRegion;
      if (!region) return;
      const { UUID } = await import('../../../node-metaverse/dist/lib/classes/UUID');
      const obj = region.objects?.getObjectByUUID(new UUID(msg.uuid));
      if (!obj) return;

      const faceIndex = msg.faceIndex || 0;
      const { stCoord, uvCoord } = this._parseSTCoord(msg);
      await this.bot.clientCommands.region.deGrabObject(obj.ID, faceIndex, stCoord, uvCoord);
      pkDebug('input', `[GodotBridge] touch_end ${msg.uuid.slice(0, 8)} face=${faceIndex}`);
    } catch (e) {
      console.error(`[GodotBridge] object_touch_end failed for ${msg.uuid}:`, e);
    }
  }

  private _parseSTCoord(msg: any) {
    const Vector3 = require('../../../node-metaverse/lib/classes/Vector3').Vector3;
    const st = msg.st || {};
    return {
      stCoord: new Vector3(st.x || 0, st.y || 0, 0),
      uvCoord: new Vector3(st.x || 0, st.y || 0, 0),
    };
  }

  // ─── Script Dialog ───────────────────────────────────────

  storeScriptDialog(dialogId: string, event: ScriptDialogEvent): void {
    this._pendingDialogs.set(dialogId, event);
  }

  async handleScriptDialogReply(msg: any): Promise<void> {
    const dialogId: string = msg.dialogId;
    const event = this._pendingDialogs.get(dialogId);
    if (!event) {
      console.warn(`[GodotBridge] script_dialog_reply: unknown dialogId ${dialogId}`);
      return;
    }
    this._pendingDialogs.delete(dialogId);
    try {
      const buttonIndex: number = msg.buttonIndex;
      await this.bot.clientCommands.comms.respondToScriptDialog(event, buttonIndex);
      console.log(`[GodotBridge] ScriptDialog reply: button[${buttonIndex}]="${event.Buttons[buttonIndex]}"`);
    } catch (e) {
      console.error(`[GodotBridge] script_dialog_reply failed:`, e);
    }
  }

  async handleScriptTextboxReply(msg: any): Promise<void> {
    const dialogId: string = msg.dialogId;
    const event = this._pendingDialogs.get(dialogId);
    if (!event) {
      console.warn(`[GodotBridge] script_textbox_reply: unknown dialogId ${dialogId}`);
      return;
    }
    this._pendingDialogs.delete(dialogId);
    try {
      const text: string = msg.text || '';
      await this.bot.clientCommands.comms.nearbyChat(text, ChatType.Normal, event.ChatChannel);
      console.log(`[GodotBridge] ScriptTextbox reply on ch=${event.ChatChannel}: "${text.slice(0, 50)}"`);
    } catch (e) {
      console.error(`[GodotBridge] script_textbox_reply failed:`, e);
    }
  }

  // ─── Teleport Offers ─────────────────────────────────────

  storeTeleportOffer(offerId: string, event: LureEvent): void {
    this._pendingLures.set(offerId, event);
  }

  async handleNotificationAction(msg: any): Promise<void> {
    const notifId: string = msg.notificationId;
    const action: string = msg.action;

    // Check if it's a teleport offer
    const lure = this._pendingLures.get(notifId);
    if (lure) {
      this._pendingLures.delete(notifId);
      if (action === 'accept') {
        try {
          await this.bot.clientCommands.teleport.acceptTeleport(lure);
          console.log(`[GodotBridge] Accepted teleport from "${lure.fromName}"`);
        } catch (e) {
          console.error(`[GodotBridge] acceptTeleport failed:`, e);
        }
      } else {
        console.log(`[GodotBridge] Declined teleport from "${lure.fromName}"`);
      }
      return;
    }

    console.warn(`[GodotBridge] notification_action: unknown notificationId ${notifId}`);
  }
}

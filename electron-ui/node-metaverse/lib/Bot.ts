import { LoginHandler } from './LoginHandler';
import type { LoginResponse } from './classes/LoginResponse';
import type { LoginParameters } from './classes/LoginParameters';
import type { Agent } from './classes/Agent';
import { PacketFlags } from './enums/PacketFlags';
import { UseCircuitCodeMessage } from './classes/messages/UseCircuitCode';
import { CompleteAgentMovementMessage } from './classes/messages/CompleteAgentMovement';
import { Message } from './enums/Message';
import type { Packet } from './classes/Packet';
import type { Region } from './classes/Region';
import { LogoutRequestMessage } from './classes/messages/LogoutRequest';
import { Utils } from './classes/Utils';
import { RegionHandshakeReplyMessage } from './classes/messages/RegionHandshakeReply';
import { RegionProtocolFlags } from './enums/RegionProtocolFlags';
import { AgentDataUpdateRequestMessage } from './classes/messages/AgentDataUpdateRequest';
import type { TeleportProgressMessage } from './classes/messages/TeleportProgress';
import { TeleportEvent } from './events/TeleportEvent';
import { ClientEvents } from './classes/ClientEvents';
import { TeleportEventType } from './enums/TeleportEventType';
import { ClientCommands } from './classes/ClientCommands';
import { DisconnectEvent } from './events/DisconnectEvent';
import type { KickUserMessage } from './classes/messages/KickUser';
import { StartPingCheckMessage } from './classes/messages/StartPingCheck';
import type { CompletePingCheckMessage } from './classes/messages/CompletePingCheck';
import type { BotOptionFlags } from './enums/BotOptionFlags';
import { FilterResponse } from './enums/FilterResponse';
import type { LogoutReplyMessage } from './classes/messages/LogoutReply';
import type { EventQueueStateChangeEvent } from './events/EventQueueStateChangeEvent';
import { UUID } from './classes/UUID';
import { Vector3 } from './classes/Vector3';
import type { RegionHandshakeMessage } from './classes/messages/RegionHandshake';
import type { AgentMovementCompleteMessage } from './classes/messages/AgentMovementComplete';
import type { Subscription } from 'rxjs';
import { ChildAgentManager } from './classes/ChildAgentManager';
import type { EnableSimulatorEvent } from './events/EnableSimulatorEvent';

export class Bot {
    public clientEvents: ClientEvents;

    /**
     * When true, teleport events will fire but the bot will NOT automatically
     * connect to the destination region. This allows external code to intercept
     * the teleport data and hand it off to another client (e.g., a viewer).
     */
    public teleportHandoffMode = false;

    private stayRegion = '';
    private stayPosition = new Vector3();

    private readonly loginParams: LoginParameters;
    private ping: NodeJS.Timeout | null = null;
    private pingNumber = 0;
    private lastSuccessfulPing = 0;
    private circuitSubscription: Subscription | null = null;
    private enableSimSubscription: Subscription | null = null;
    private _childAgentManager?: ChildAgentManager;
    private readonly options: BotOptionFlags;
    private eventQueueRunning = false;
    private readonly eventQueueWaits = new Map<string, {
        timer?: NodeJS.Timeout,
        resolve: (value: (void | PromiseLike<void>)) => void
    }>();
    private stay = false;

    /**
     * Persistent circuit message subscriptions — automatically re-wired to the
     * new circuit after every changeRegion(). Each entry holds the message IDs,
     * the callback, and the current underlying rxjs Subscription.
     */
    private readonly _persistentSubs: {
        ids: number[];
        callback: (packet: Packet) => Promise<void> | void;
        sub: Subscription | null;
        id: number;
    }[] = [];
    private _persistentSubNextId = 1;

    private _agent?: Agent;
    private _agentClearedBy?: string;
    private _currentRegion?: Region;
    private _clientCommands?: ClientCommands;

    public get currentRegion(): Region {
        if (this._currentRegion === undefined) {
            throw new Error('Internal error - currentRegion is undefined');
        }
        return this._currentRegion;
    }

    public get agent(): Agent {
        if (this._agent === undefined) {
            throw new Error('Internal error - agent is undefined (cleared by: ' + (this._agentClearedBy || 'unknown') + ')');
        }
        return this._agent;
    }

    public get clientCommands(): ClientCommands {
        if (this._clientCommands === undefined) {
            throw new Error('Internal error - clientCommands is undefined');
        }
        return this._clientCommands;
    }

    public get loginParameters(): LoginParameters {
        return this.loginParams;
    }

    public get childAgentManager(): ChildAgentManager | undefined {
        return this._childAgentManager;
    }

    public constructor(login: LoginParameters, options: BotOptionFlags) {
        this.clientEvents = new ClientEvents();
        this.loginParams = login;
        this.options = options;

        this.clientEvents.onEventQueueStateChange.subscribe((evt: EventQueueStateChangeEvent) => {
            this.eventQueueRunning = evt.active;
            for (const waitID of this.eventQueueWaits.keys()) {
                try {
                    const wait = this.eventQueueWaits.get(waitID);
                    if (wait !== undefined) {
                        clearTimeout(wait.timer);
                        wait.resolve();
                        this.eventQueueWaits.delete(waitID);
                    }
                }
                catch (_ignore: unknown) {
                    //Nothing
                }
            }
        });
    }

    public stayPut(stay: boolean, regionName?: string, position?: Vector3): void {
        this.stay = stay;
        if (regionName !== undefined) {
            this.stayRegion = regionName;
            if (position !== undefined) {
                this.stayPosition = position;
            }
        }
    }

    public getCurrentRegion(): Region {
        return this.currentRegion;
    }

    public async login(): Promise<LoginResponse> {
        const loginHandler = new LoginHandler(this.clientEvents, this.options);
        const response: LoginResponse = await loginHandler.Login(this.loginParams);
        this._currentRegion = response.region;
        this._agent = response.agent;
        this._clientCommands = new ClientCommands(response.region, response.agent, this);
        this.currentRegion.clientCommands = this._clientCommands;
        return response;
    }

    public async changeRegion(region: Region, requested: boolean): Promise<void> {
        this.closeCircuit();
        this._currentRegion = region;
        this._clientCommands = new ClientCommands(this.currentRegion, this.agent, this);
        this._currentRegion.clientCommands = this._clientCommands;
        if (this.ping !== null) {
            clearInterval(this.ping);
            this.ping = null;
        }

        await this.connectToSim(requested);
    }

    public async waitForEventQueue(timeout = 1000): Promise<void> {
        return new Promise((resolve, reject) => {
            if (this.eventQueueRunning) {
                resolve();
            }
            else {
                const waitID = UUID.random().toString();
                const newWait: {
                    resolve: (value: (void | PromiseLike<void>)) => void,
                    timer?: NodeJS.Timeout
                } = {
                    'resolve': resolve
                };

                newWait.timer = setTimeout(() => {
                    this.eventQueueWaits.delete(waitID);
                    reject(new Error('Timeout'));
                }, timeout);

                this.eventQueueWaits.set(waitID, newWait);
            }
        });
    }

    public async setInterestList(mode: '360' | 'default'): Promise<boolean> {
        const interestList = {
            mode
        };

        try {
            const result = await this.currentRegion.caps.capsPostXML('InterestList', interestList);
            if (typeof result !== 'object' || result === null) {
                throw new Error('Invalid response received');
            }
            const res = result as Record<string, unknown>;
            return res.mode === mode;
        }
        catch (e) {
            console.error('Error when setting interest list:');
            console.error(e);
            return false;
        }
    }

    public async close(): Promise<void> {
        const circuit = this.currentRegion.circuit;
        const msg: LogoutRequestMessage = new LogoutRequestMessage();
        msg.AgentData = {
            AgentID: this.agent.agentID,
            SessionID: circuit.sessionID
        };
        circuit.sendMessage(msg, PacketFlags.Reliable);
        await circuit.waitForMessage<LogoutReplyMessage>(Message.LogoutReply, 5000);
        this.stayRegion = '';
        this.stayPosition = new Vector3();
        this.closeCircuit();
        this.agent.shutdown();
        this._agentClearedBy = 'close()';
        delete this._agent;
        this.disconnected(true, 'Logout completed');
    }

    /**
     * Shutdown only the UDP circuit for viewer handoff.
     * This closes the UDP socket so the viewer can connect with the same circuit credentials,
     * but does NOT:
     * - Send logout (which would invalidate session)
     * - Close caps (which would invalidate seed capability)
     *
     * Use this when handing off the session to a viewer for local teleports (same region).
     */
    public shutdownForHandoff(): void {
        // Stop ping timer first to prevent it from using closed circuit
        if (this.ping !== null) {
            clearInterval(this.ping);
            this.ping = null;
        }

        // Shut down child agents
        if (this.enableSimSubscription !== null) {
            this.enableSimSubscription.unsubscribe();
            this.enableSimSubscription = null;
        }
        if (this._childAgentManager) {
            this._childAgentManager.shutdown();
            this._childAgentManager = undefined;
        }

        // Unsubscribe from circuit events
        if (this.circuitSubscription !== null) {
            this.circuitSubscription.unsubscribe();
            this.circuitSubscription = null;
        }

        // Stop agent update timer
        this.agent.shutdown();

        // Just close the UDP socket - don't send CloseCircuit as that invalidates the circuit code
        // The sim will eventually notice the connection is gone
        this.currentRegion.circuit.shutdown();
    }

    /**
     * Subscribe to circuit messages that persist across region changes.
     * The callback receives packets from whatever circuit is currently active.
     * When changeRegion() connects a new circuit, the subscription is
     * automatically re-wired — no manual re-subscribe needed.
     *
     * Returns an unsubscribe function.
     */
    public subscribeToCircuitMessages(ids: number[], callback: (packet: Packet) => Promise<void> | void): { unsubscribe: () => void } {
        const entry = {
            ids,
            callback,
            sub: null as Subscription | null,
            id: this._persistentSubNextId++,
        };

        // Wire to current circuit if available
        try {
            entry.sub = this.currentRegion.circuit.subscribeToMessages(ids, callback);
        }
        catch {
            // No circuit yet — will be wired in connectToSim
        }

        this._persistentSubs.push(entry);

        return {
            unsubscribe: (): void => {
                entry.sub?.unsubscribe();
                const idx = this._persistentSubs.findIndex(e => e.id === entry.id);
                if (idx >= 0) this._persistentSubs.splice(idx, 1);
            }
        };
    }

    public agentID(): UUID {
        return this.agent.agentID;
    }

    public async connectToSim(requested = false): Promise<void> {
        if (!requested) {
            if (this.stay && this.stayRegion === '') {
                requested = true;
            }
        }

        this.agent.setCurrentRegion(this.currentRegion);
        const circuit = this.currentRegion.circuit;
        circuit.init();
        const msg: UseCircuitCodeMessage = new UseCircuitCodeMessage();
        msg.CircuitCode = {
            SessionID: circuit.sessionID,
            ID: this.agent.agentID,
            Code: circuit.circuitCode
        };

        await circuit.waitForAck(circuit.sendMessage(msg, PacketFlags.Reliable), 60000);

        // Re-wire persistent subscriptions to the new circuit
        this._rewirePersistentSubs();

        const agentMovement: CompleteAgentMovementMessage = new CompleteAgentMovementMessage();
        agentMovement.AgentData = {
            AgentID: this.agent.agentID,
            SessionID: circuit.sessionID,
            CircuitCode: circuit.circuitCode
        };
        circuit.sendMessage(agentMovement, PacketFlags.Reliable);

        let agentPosition: Vector3 | null = null;
        let regionName: string | null = null;

        const movementCompletePromise = circuit.waitForMessage<AgentMovementCompleteMessage>(Message.AgentMovementComplete, 60000).then((agentMovementMsg: AgentMovementCompleteMessage) => {
            agentPosition = agentMovementMsg.Data.Position;
            // Point camera at the actual landing position so the sim streams
            // objects near where we arrived (not the previous region's coords)
            this.agent.cameraCenter = agentPosition;
            if (regionName !== null) {
                if (this.stayRegion === '' || requested) {
                    this.stayPut(this.stay, regionName, agentPosition);
                }
            }
        }).catch(() => {
            console.error('Timed out waiting for AgentMovementComplete')
        });

        const handshakeMessage = await circuit.waitForMessage<RegionHandshakeMessage>(Message.RegionHandshake, 10000);

        const handshakeReply: RegionHandshakeReplyMessage = new RegionHandshakeReplyMessage();
        handshakeReply.AgentData = {
            AgentID: this.agent.agentID,
            SessionID: circuit.sessionID
        };
        handshakeReply.RegionInfo = {
            Flags: RegionProtocolFlags.SelfAppearanceSupport | RegionProtocolFlags.AgentAppearanceService
        };
        await circuit.waitForAck(circuit.sendMessage(handshakeReply, PacketFlags.Reliable), 10000);

        this.currentRegion.handshake(handshakeMessage).then(() => {
            regionName = this.currentRegion.regionName;
            console.log('Arrived in region: ' + regionName);
            if (agentPosition !== null) {
                if (this.stayRegion === '' || requested) {
                    this.stayPut(this.stay, regionName, agentPosition);
                }
            }
        }).catch((error: unknown) => {
            console.error('Timed out getting handshake');
            console.error(error);
        });

        if (this._clientCommands) {
            await this._clientCommands.network.setBandwidth(10000000);
        }

        const agentRequest = new AgentDataUpdateRequestMessage();
        agentRequest.AgentData = {
            AgentID: this.agent.agentID,
            SessionID: circuit.sessionID
        };
        circuit.sendMessage(agentRequest, PacketFlags.Reliable);
        try {
            await this.waitForEventQueue(10000);
        }
        catch (_ignore: unknown) {
            console.warn('Event queue not ready before appearance setup');
        }
        await this.agent.setInitialAppearance();

        // Ensure camera is set to the landing position before starting agent updates
        // so the first AgentUpdate tells the sim to stream objects near us.
        await movementCompletePromise;
        this.agent.circuitActive();

        // Re-request 360-degree interest list — this is per-region and defaults to
        // camera-facing-only mode, which misses objects behind the avatar.
        this.setInterestList('360').catch(() => { });

        this.lastSuccessfulPing = new Date().getTime();

        this.ping = setInterval(() => {
            (async (): Promise<void> => {
                const now = new Date().getTime();
                if (now - this.lastSuccessfulPing > 120 * 1000) {
                    if (this.ping !== null) {
                        clearInterval(this.ping);
                        this.ping = null;
                        this.disconnected(false, 'Disconnected from the simulator');
                    }
                    return;
                }

                this.pingNumber++;
                if (this.pingNumber % 12 === 0 && this.stay) {
                    if (this.currentRegion.regionName.toLowerCase() !== this.stayRegion.toLowerCase()) {
                        console.log('Stay Put: Attempting to teleport to ' + this.stayRegion);
                        if (this.stayPosition === undefined) {
                            this.stayPosition = new Vector3([128, 128, 20]);
                        }
                        this.clientCommands.teleport.teleportTo(this.stayRegion, this.stayPosition, this.stayPosition).then(() => {
                            console.log('I found my way home.');
                        }).catch(() => {
                            console.log('Cannot teleport home right now.');
                        });
                    }
                }
                if (this.pingNumber > 255) {
                    this.pingNumber = 0;
                }
                const ping = new StartPingCheckMessage();
                ping.PingID = {
                    PingID: this.pingNumber,
                    OldestUnacked: this.currentRegion.circuit.getOldestUnacked()
                };
                circuit.sendMessage(ping, PacketFlags.Reliable);

                await circuit.waitForMessage<CompletePingCheckMessage>(Message.CompletePingCheck, 10000, ((pingData: {
                    pingID: number,
                    timeSent: number
                }, cpc: CompletePingCheckMessage): FilterResponse => {
                    if (cpc.PingID.PingID === pingData.pingID) {
                        this.lastSuccessfulPing = new Date().getTime();
                        const pingTime = this.lastSuccessfulPing - pingData.timeSent;
                        if (this.clientEvents !== null) {
                            this.clientEvents.onCircuitLatency.next(pingTime);
                        }
                        return FilterResponse.Finish;
                    }
                    return FilterResponse.NoMatch;
                }).bind(this, {
                    pingID: this.pingNumber,
                    timeSent: new Date().getTime()
                }));

                if ((new Date().getTime() - this.lastSuccessfulPing) > 60000) {
                    // We're dead, jim
                    this.kicked('Circuit Timeout');
                }

            })().catch((_e: unknown) => { /*ignore*/ })
        }, 5000);

        this.circuitSubscription = circuit.subscribeToMessages(
            [
                Message.TeleportFailed,
                Message.TeleportFinish,
                Message.TeleportLocal,
                Message.TeleportStart,
                Message.TeleportProgress,
                Message.TeleportCancel,
                Message.KickUser
            ], (packet: Packet) => {
            switch (packet.message.id) {
                case Message.TeleportLocal:
                    {
                        const tpEvent = new TeleportEvent();
                        tpEvent.message = '';
                        tpEvent.eventType = TeleportEventType.TeleportCompleted;
                        tpEvent.simIP = 'local';
                        tpEvent.simPort = 0;
                        tpEvent.seedCapability = '';

                        if (this.clientEvents === null) {
                            this.kicked('ClientEvents is null');
                        }

                        this.clientEvents.onTeleportEvent.next(tpEvent);
                        break;
                    }
                case Message.TeleportStart:
                    {
                        const tpEvent = new TeleportEvent();
                        tpEvent.message = '';
                        tpEvent.eventType = TeleportEventType.TeleportStarted;
                        tpEvent.simIP = '';
                        tpEvent.simPort = 0;
                        tpEvent.seedCapability = '';

                        if (this.clientEvents === null) {
                            this.kicked('ClientEvents is null');
                        }

                        this.clientEvents.onTeleportEvent.next(tpEvent);
                        break;
                    }
                case Message.TeleportProgress:
                    {
                        const teleportProgress = packet.message as TeleportProgressMessage;
                        const message = Utils.BufferToStringSimple(teleportProgress.Info.Message);

                        const tpEvent = new TeleportEvent();
                        tpEvent.message = message;
                        tpEvent.eventType = TeleportEventType.TeleportProgress;
                        tpEvent.simIP = '';
                        tpEvent.simPort = 0;
                        tpEvent.seedCapability = '';

                        if (this.clientEvents === null) {
                            this.kicked('ClientEvents is null');
                        }

                        this.clientEvents.onTeleportEvent.next(tpEvent);
                        break;
                    }
                case Message.KickUser:
                    {
                        const kickUser = packet.message as KickUserMessage;
                        this.kicked(Utils.BufferToStringSimple(kickUser.UserInfo.Reason));

                        break;
                    }
                default:
                    break;
            }
        });

        // Set up child agent manager for neighboring region awareness
        this._childAgentManager = new ChildAgentManager({
            agentID: this.agent.agentID,
            sessionID: circuit.sessionID,
            secureSessionID: circuit.secureSessionID,
            circuitCode: circuit.circuitCode,
            clientEvents: this.clientEvents,
            agent: this.agent,
            bot: this,
            options: this.options,
        });
        this._childAgentManager.setMainRegion(circuit.ipAddress, circuit.port);

        this.enableSimSubscription = this.clientEvents.onEnableSimulator.subscribe(
            (evt: EnableSimulatorEvent) => {
                this._childAgentManager?.enableSimulator(evt.regionHandle, evt.ipAddress, evt.port)
                    .catch((e: unknown) => { console.warn('[ChildAgent] enableSimulator error:', e); });
            }
        );
    }

    /** Re-wire all persistent circuit subscriptions to the current circuit. */
    private _rewirePersistentSubs(): void {
        const circuit = this.currentRegion.circuit;
        for (const entry of this._persistentSubs) {
            entry.sub?.unsubscribe();
            entry.sub = circuit.subscribeToMessages(entry.ids, entry.callback);
        }
    }

    private closeCircuit(): void {
        // Shut down child agents first
        if (this.enableSimSubscription !== null) {
            this.enableSimSubscription.unsubscribe();
            this.enableSimSubscription = null;
        }
        if (this._childAgentManager) {
            this._childAgentManager.shutdown();
            this._childAgentManager = undefined;
        }

        this.currentRegion.shutdown();
        if (this.circuitSubscription !== null) {
            this.circuitSubscription.unsubscribe();
            this.circuitSubscription = null;
        }
        delete this._currentRegion;

        this.clientCommands.shutdown();
        delete this._clientCommands;
        if (this.ping !== null) {
            clearInterval(this.ping);
            this.ping = null;
        }

    }

    private kicked(message: string): void {
        console.warn('[Bot] kicked:', message, new Error().stack);
        this.closeCircuit();
        this.agent.shutdown();
        this._agentClearedBy = 'kicked(' + message + ')';
        delete this._agent;
        this.disconnected(false, message);
    }

    private disconnected(requested: boolean, message: string): void {
        const disconnectEvent = new DisconnectEvent();
        disconnectEvent.requested = requested;
        disconnectEvent.message = message;
        if (this.clientEvents) {
            this.clientEvents.onDisconnected.next(disconnectEvent);
        }
    }
}

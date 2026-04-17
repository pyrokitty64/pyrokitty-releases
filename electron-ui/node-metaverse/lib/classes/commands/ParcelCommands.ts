import { CommandsBase } from './CommandsBase';
import { ParcelInfoRequestMessage } from '../messages/ParcelInfoRequest';
import { UUID } from '../UUID';
import { Message } from '../../enums/Message';
import type { ParcelInfoReplyMessage } from '../messages/ParcelInfoReply';
import { FilterResponse } from '../../enums/FilterResponse';
import { Utils } from '../Utils';
import type { ParcelInfoReplyEvent } from '../../events/ParcelInfoReplyEvent';
import { PacketFlags } from '../../enums/PacketFlags';
import { Vector3 } from '../Vector3';
import { LandStatRequestMessage } from '../messages/LandStatRequest';
import type { LandStatReportType } from '../../enums/LandStatReportType';
import type { LandStatFlags } from '../../enums/LandStatFlags';
import type { LandStatsEvent } from '../../events/LandStatsEvent';
import LLSD from '@caspertech/llsd';

// This class was added to provide a new "Category" of commands, since we don't have any parcel specific functionality yet.

export class ParcelCommands extends CommandsBase
{
    public async getParcelInfo(parcelID: UUID | string): Promise<ParcelInfoReplyEvent>
    {
        if (typeof parcelID === 'string')
        {
            parcelID = new UUID(parcelID);
        }

        const msg: ParcelInfoRequestMessage = new ParcelInfoRequestMessage();
        msg.AgentData = {
            AgentID: this.agent.agentID,
            SessionID: this.circuit.sessionID
        };
        msg.Data = {
            ParcelID: parcelID
        };

        this.circuit.sendMessage(msg, PacketFlags.Reliable);

        const parcelInfoReply = (await this.circuit.waitForMessage<ParcelInfoReplyMessage>(Message.ParcelInfoReply, 10000, (replyMessage: ParcelInfoReplyMessage): FilterResponse =>
        {
            if (replyMessage.Data.ParcelID.equals(parcelID))
            {
                return FilterResponse.Finish;
            }
            return FilterResponse.NoMatch;
        }));

        return new class implements ParcelInfoReplyEvent
        {
            public OwnerID = parcelInfoReply.Data.OwnerID;
            public ParcelName = Utils.BufferToStringSimple(parcelInfoReply.Data.Name);
            public ParcelDescription = Utils.BufferToStringSimple(parcelInfoReply.Data.Desc);
            public Area = parcelInfoReply.Data.ActualArea;
            public BillableArea = parcelInfoReply.Data.BillableArea;
            public Flags = parcelInfoReply.Data.Flags;
            public GlobalCoordinates = new Vector3([parcelInfoReply.Data.GlobalX, parcelInfoReply.Data.GlobalY, parcelInfoReply.Data.GlobalZ]);
            public RegionName =  Utils.BufferToStringSimple(parcelInfoReply.Data.SimName);
            public SnapshotID = parcelInfoReply.Data.SnapshotID;
            public Traffic = parcelInfoReply.Data.Dwell;
            public SalePrice = parcelInfoReply.Data.SalePrice;
            public AuctionID = parcelInfoReply.Data.AuctionID;
        };
    }

    /**
     * Look up parcel info at a specific location in any region.
     * Uses RemoteParcelRequest cap to resolve the parcel UUID,
     * then ParcelInfoRequest to get full details.
     *
     * Accepts either a region UUID or grid coordinates (gridX, gridY).
     */
    public async getRemoteParcelInfo(opts: {
        regionId?: UUID | string;
        gridX?: number;
        gridY?: number;
        x: number;
        y: number;
        z?: number;
    }): Promise<ParcelInfoReplyEvent>
    {
        const body: Record<string, unknown> = {
            location: [opts.x, opts.y, opts.z ?? 0],
        };

        if (opts.regionId)
        {
            const id = typeof opts.regionId === 'string' ? opts.regionId : opts.regionId.toString();
            body['region_id'] = new LLSD.UUID(id);
        }
        else if (opts.gridX !== undefined && opts.gridY !== undefined)
        {
            // region_handle is a U64: (globalX << 32) | globalY, encoded as 8-byte binary
            const globalX = opts.gridX * 256;
            const globalY = opts.gridY * 256;
            const octets = [
                (globalX >>> 24) & 0xff, (globalX >>> 16) & 0xff,
                (globalX >>> 8) & 0xff, globalX & 0xff,
                (globalY >>> 24) & 0xff, (globalY >>> 16) & 0xff,
                (globalY >>> 8) & 0xff, globalY & 0xff,
            ];
            body['region_handle'] = new LLSD.Binary(octets);
        }
        else
        {
            throw new Error('getRemoteParcelInfo requires regionId or gridX+gridY');
        }

        const result = await this.currentRegion.caps.capsPostXML('RemoteParcelRequest', body);
        const parcelId = result?.parcel_id?.toString?.() ?? result?.parcel_id;
        if (!parcelId)
        {
            throw new Error('RemoteParcelRequest returned no parcel_id');
        }

        return this.getParcelInfo(parcelId);
    }

    public async getLandStats(parcelID: string | UUID | number, reportType: LandStatReportType, flags: LandStatFlags, filter?: string): Promise<LandStatsEvent>
    {
        if (parcelID instanceof UUID)
        {
            parcelID = parcelID.toString();
        }

        if (typeof parcelID === 'string')
        {
            const parcels = await this.bot.clientCommands.region.getParcels();
            for (const parcel of parcels)
            {
                if (parcel.ParcelID.toString() === parcelID)
                {
                    parcelID = parcel.LocalID;
                    break;
                }
            }
        }

        if (typeof parcelID !== 'number')
        {
            throw new Error('Unable to locate parcel');
        }

        if (filter === undefined)
        {
            filter = '';
        }

        const msg = new LandStatRequestMessage();
        msg.AgentData = {
            AgentID: this.agent.agentID,
            SessionID: this.circuit.sessionID
        };
        msg.RequestData = {
            ParcelLocalID: parcelID,
            ReportType: reportType,
            Filter: Utils.StringToBuffer(filter),
            RequestFlags: flags
        }

        this.circuit.sendMessage(msg, PacketFlags.Reliable);
        return Utils.waitOrTimeOut<LandStatsEvent>(this.currentRegion.clientEvents.onLandStatReplyEvent, 10000);
    }
}

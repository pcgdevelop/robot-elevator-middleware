import { Injectable } from '@nestjs/common';
import { LiftStatusRequestDTO } from '../dtos/status/LiftStatusRequestDTO';
import { LiftStatusResponseDTO } from '../dtos/status/LiftStatusResponseDTO';
import { CallElevatorRequestDTO } from '../dtos/call/CallElevatorRequestDTO';
import { BaseResponseDTO } from '../../baseDtos/BaseResponseDTO';
import { DelayDoorRequestDTO } from '../dtos/delay/DelayDoorRequestDTO';
import { ReserveAndCancelRequestDTO } from '../dtos/reserve/ReserveAndCancelRequestDTO';
import { ListElevatorsRequestDTO } from '../dtos/list/ListElevatorsRequestDTO';
import { ListElevatorsResponseDTO } from '../dtos/list/ListElevatorsResponseDTO';
import { CallElevatorResponseDTO } from '../dtos/call/CallElevatorResponseDTO';
import { LiftPositionDTO } from '../dtos/monitor/LiftPositionDTO';
import { LiftDoorDTO } from '../dtos/monitor/LiftDoorDTO';
import {
  fetchBuildingTopology,
  openWebSocketConnection,
  waitForResponse,
} from '../../common/koneapi';
import { getLiftNumber } from '../utils/lift-utils';
import { plainToInstance } from 'class-transformer';
import { AccessTokenService } from '../../auth/service/accessToken.service';
import { DeviceService } from '../../device/service/device.service';
import {
  BUILDING_ID_PREFIX,
  BuildingTopology,
  WebSocketResponse,
} from '../../common/types';
import { logIncoming, logOutgoing } from '../../../logger/gcp-logger.service';
import { v4 as uuidv4 } from 'uuid';
import WebSocket from 'ws';

/**
 * Update these two variables with your own credentials or set them up as environment variables.
 */

@Injectable()
export class ElevatorService {
  constructor(
    private readonly accessTokenService: AccessTokenService,
    private readonly deviceService?: DeviceService,
  ) {}

  private getRequestId() {
    return Math.floor(Math.random() * 1000000000);
  }

  private buildingTopologyCache: Map<string, BuildingTopology> = new Map();

  // Cache of terminals per building/group: key -> Map(terminal_id -> type)
  private terminalsCache: Map<string, Map<number, string>> = new Map();

  // Cache floor/area mappings per building/group
  private floorAreaCache: Map<
    string,
    {
      byFloor: Map<
        number,
        Array<{
          areaId: number;
          shortName: string;
          groupSide?: number;
          terminals: number[];
          groupFloorId?: number;
        }>
      >;
      byArea: Map<
        number,
        {
          floor: number;
          shortName: string;
          groupSide?: number;
          terminals: number[];
          groupFloorId?: number;
        }
      >;
      byGroupFloor: Map<
        number,
        Array<{
          floor: number;
          areaId: number;
          shortName: string;
          groupSide?: number;
          terminals: number[];
        }>
      >;
      groupTerminals: number[];
    }
  > = new Map();

  // In-memory rate limiting per deviceUuid for callElevator
  private callRateLimit: Map<string, { count: number; windowStart: number }> =
    new Map();

  // Idempotency cache for callElevator per device+journey key
  private callIdempotencyCache: Map<
    string,
    { expiresAt: number; response: CallElevatorResponseDTO }
  > = new Map();

  // Persist last successful call context per device+place+lift
  private lastDoorHoldContext: Map<
    string,
    {
      buildingId: string;
      groupId: string;
      liftNo: number;
      servedArea: number; // source area used when calling the lift
      liftDeck: number; // deck identifier matching the number used in allowed_lifts
      terminalId?: number;
      updatedAt: number;
    }
  > = new Map();

  // Background schedulers for door hold-open per client+place+lift
  private doorHoldTasks: Map<
    string,
    {
      connection: WebSocket;
      buildingId: string;
      groupId: string;
      servedArea: number;
      liftDeck: number;
      endAtMs: number; // when we plan to stop extending (client request horizon)
      timer?: NodeJS.Timeout;
      active: boolean;
      tick?: () => Promise<void>;
    }
  > = new Map();

  private lockFloorCache: Map<
    string,
    { fromFloor: number; toFloor: number; locked: boolean; updatedAt: number }
  > = new Map();

  private getDoorCtxKey(
    deviceUuid: string,
    buildingId: string,
    groupId: string,
    liftNo: number,
  ) {
    return `${deviceUuid}|${buildingId}|${groupId}|${liftNo}`;
  }

  private getTerminalMap(
    buildingId: string,
    groupId: string,
    topology?: any,
  ): Map<number, string> {
    const key = `${buildingId}|${groupId}`;
    let map = this.terminalsCache.get(key);
    if (!map) {
      map = new Map<number, string>();
      // Prefer terminals from config topology event
      const terminals = (topology as any)?.terminals || [];
      if (Array.isArray(terminals)) {
        for (const t of terminals) {
          const id = Number(t?.terminal_id);
          const type = String(t?.type || '').trim();
          if (!isNaN(id) && type) map.set(id, type);
        }
      }
      // Fallback: parse env JSON if provided
      if (map.size === 0) {
        const raw =
          process.env.KONE_TERMINALS || process.env.ELEVATOR_TERMINALS || '[]';
        try {
          const arr = JSON.parse(raw);
          if (Array.isArray(arr)) {
            for (const t of arr) {
              const id = Number(t?.terminal_id);
              const type = String(t?.type || '').trim();
              if (!isNaN(id) && type) map.set(id, type);
            }
          }
        } catch {
          // ignore
        }
      }
      this.terminalsCache.set(key, map);
    }
    return map;
  }

  private getLockCtxKey(deviceUuid: string, placeId: string, liftNo: number) {
    return `${deviceUuid}|${placeId}|${liftNo}`;
  }

  private pickTerminalId(
    buildingId: string,
    groupId: string,
    topology?: any,
    groupTerminals?: number[],
    preferredType?: string | string[],
    allowedTerminals?: number[],
  ): number {
    const map = this.getTerminalMap(buildingId, groupId, topology);

    const allowedList = Array.isArray(allowedTerminals)
      ? allowedTerminals
          .map((value) => Number(value))
          .filter((value) => !isNaN(value))
      : [];
    const allowedSet = allowedList.length ? new Set(allowedList) : undefined;

    // Normalize preferences. Default to 'virtual' if not provided.
    const prefs: string[] = (
      Array.isArray(preferredType)
        ? preferredType
        : preferredType
          ? [preferredType]
          : ['virtual']
    )
      .filter(Boolean)
      .map((s) => String(s).trim().toLowerCase());

    // Helper: canonicalize terminal type names and check match by substring
    const typeMatches = (termType: string, wanted: string) => {
      const t = String(termType || '').toLowerCase();
      const w = String(wanted || '').toLowerCase();
      if (w === '*' || w === 'any') return true;
      // common aliases/contains matching
      const canonicalWanted = w;
      const canonicalType = t.includes('virtual')
        ? 'virtual'
        : t.includes('dop')
          ? 'vcs'
          : t.includes('lcs')
            ? 'lcs'
            : t;
      return (
        canonicalType === canonicalWanted || t.includes(w) // fallback contains check
      );
    };

    const toNumericArray = (input: any): number[] =>
      Array.isArray(input)
        ? input
            .map((value: any) => Number(value))
            .filter((value) => !isNaN(value))
        : [];

    // Build candidates for each preferred type in order
    const allEntries = Array.from(map.entries()); // [id, type]
    const filteredEntries = allowedSet
      ? allEntries.filter(([id]) => allowedSet.has(id))
      : allEntries;
    const entries = filteredEntries.length ? filteredEntries : allEntries;
    const baseGroupTerminals = toNumericArray(groupTerminals).length
      ? toNumericArray(groupTerminals)
      : toNumericArray((topology as any)?.groups?.[0]?.terminals);
    const groupTermList = allowedSet
      ? baseGroupTerminals.filter((value) => allowedSet.has(value))
      : baseGroupTerminals;

    for (const pref of prefs) {
      const idsForType = entries
        .filter(([, t]) => typeMatches(t, pref))
        .map(([id]) => id);
      if (idsForType.length === 0) continue;

      // Prefer a terminal that's part of the group's terminals, if available
      if (Array.isArray(groupTermList) && groupTermList.length > 0) {
        const match = idsForType.find((id) => groupTermList.includes(id));
        if (typeof match === 'number') return match;
      }
      return idsForType[0];
    }

    // If no preferred type found, try any terminal within the group
    if (Array.isArray(groupTermList) && groupTermList.length > 0) {
      const anyInGroup = entries
        .map(([id]) => id)
        .find((id) => groupTermList.includes(id));
      if (typeof anyInGroup === 'number') return anyInGroup;
    }

    // Fallback to env default or a deterministic first entry
    if (entries.length === 0) {
      if (allowedList.length) {
        return allowedList[0];
      }
      return Number(process.env.KONE_DEFAULT_TERMINAL_ID || 1001);
    }
    const orderedIds = entries.map(([id]) => id);
    if (allowedList.length) {
      const allowedMatch = allowedList.find((id) => orderedIds.includes(id));
      if (typeof allowedMatch === 'number') return allowedMatch;
      return allowedList[0];
    }
    return orderedIds[0];
  }

  private formatBuildingId(id: string): string {
    return id.startsWith(BUILDING_ID_PREFIX)
      ? id
      : `${BUILDING_ID_PREFIX}${id}`;
  }

  private buildFloorAreaMappings(
    buildingId: string,
    groupId: string,
    topology: any,
  ) {
    const key = `${buildingId}|${groupId}`;
    let entry = this.floorAreaCache.get(key);
    if (entry) return entry;

    const byFloor = new Map<
      number,
      Array<{
        areaId: number;
        shortName: string;
        groupSide?: number;
        terminals: number[];
      }>
    >();
    const byArea = new Map<
      number,
      {
        floor: number;
        shortName: string;
        groupSide?: number;
        terminals: number[];
        groupFloorId?: number;
      }
    >();
    const byGroupFloor = new Map<
      number,
      Array<{
        floor: number;
        areaId: number;
        shortName: string;
        groupSide?: number;
        terminals: number[];
      }>
    >();

    const parseFloorNum = (name: any): number => {
      const m = String(name ?? '').match(/-?\d+/);
      return m ? parseInt(m[0], 10) : NaN;
    };

    const extractFloorFromAreaId = (areaId: number): number => {
      if (typeof areaId !== 'number' || !isFinite(areaId)) return NaN;
      return Math.trunc(areaId / 1000);
    };

    const group =
      (topology?.groups || []).find(
        (g: any) =>
          String(g?.groupId || g?.group_id || '')
            .split(':')
            .pop()
            ?.toString() === String(groupId),
      ) || topology?.groups?.[0];
    const groupTerminals: number[] = Array.isArray(group?.terminals)
      ? group.terminals.map((n: any) => Number(n)).filter((n: any) => !isNaN(n))
      : [];

    const pushEntry = (
      floor: number,
      areaId: number,
      shortName: string,
      groupSide?: number,
      terminals: number[] = [],
      groupFloorId?: number,
    ) => {
      if (isNaN(floor) || isNaN(areaId)) return;
      const arr = byFloor.get(floor) || [];
      const e = { areaId, shortName, groupSide, terminals, groupFloorId };
      arr.push(e);
      byFloor.set(floor, arr);
      byArea.set(areaId, { floor, shortName, groupSide, terminals, groupFloorId });
      if (typeof groupFloorId === 'number' && !isNaN(groupFloorId)) {
        const gfArr = byGroupFloor.get(groupFloorId) || [];
        gfArr.push({ floor, areaId, shortName, groupSide, terminals });
        byGroupFloor.set(groupFloorId, gfArr);
      }
    };

    if (Array.isArray(topology?.destinations) && topology.destinations.length) {
      for (const d of topology.destinations) {
        const areaRaw =
          typeof d?.area_id !== 'undefined' && d?.area_id !== null
            ? d.area_id
            : (d as any)?.areaId;
        const areaId =
          areaRaw === undefined || areaRaw === null || areaRaw === ''
            ? NaN
            : Number(
                String(areaRaw)
                  .split(':')
                  .pop(),
              );
        const groupFloorIdRaw =
          typeof d?.group_floor_id !== 'undefined'
            ? d.group_floor_id
            : (d as any)?.groupFloorId;
        const groupFloorId = Number(groupFloorIdRaw);
        let floor = extractFloorFromAreaId(areaId);
        if (isNaN(floor)) {
          floor = parseFloorNum((d as any)?.short_name ?? (d as any)?.shortName);
        }
        if (isNaN(floor) && !isNaN(groupFloorId)) {
          floor = groupFloorId;
        }
        const side =
          typeof d?.group_side === 'number' ? Number(d.group_side) : undefined;
        const terms: number[] = Array.isArray(d?.terminals)
          ? d.terminals.map((t: any) => Number(t)).filter((n: any) => !isNaN(n))
          : [];
        pushEntry(
          floor,
          areaId,
          String((d as any)?.short_name ?? (d as any)?.shortName ?? ''),
          side,
          terms,
          !isNaN(groupFloorId) ? groupFloorId : undefined,
        );
      }
    }

    if (!byFloor.size && Array.isArray(topology?.areas)) {
      for (const a of topology.areas) {
        const areaRaw =
          typeof a?.areaId !== 'undefined' && a?.areaId !== null
            ? a.areaId
            : (a as any)?.area_id;
        const areaId =
          areaRaw === undefined || areaRaw === null || areaRaw === ''
            ? NaN
            : Number(
                String(areaRaw)
                  .split(':')
                  .pop(),
              );
        let floor = extractFloorFromAreaId(areaId);
        if (isNaN(floor)) floor = parseFloorNum((a as any)?.shortName);
        pushEntry(
          floor,
          areaId,
          String((a as any)?.shortName ?? ''),
          undefined,
          undefined,
          undefined,
        );
      }
    }

    entry = { byFloor, byArea, byGroupFloor, groupTerminals };
    this.floorAreaCache.set(key, entry);
    return entry;
  }

  private mapFloorToAreaByRule(floor: number, groupId: string): number {
    const gid = Number(String(groupId).split(':').pop());
    if (!isFinite(floor) || isNaN(floor)) return 0;
    if (gid === 2) return floor * 1000 + 20; // group 2 -> XX020
    // default/group 1 -> XX000
    return floor * 1000;
  }

  private areaIdLooksLikeFloor(areaId: number, floor: number): boolean {
    if (typeof areaId !== 'number' || isNaN(areaId)) return false;
    const thousands = Math.floor(areaId / 1000);
    return thousands === floor;
  }

  private resolveAreaIdForFloor(
    buildingId: string,
    groupId: string,
    topology: any,
    floor: number,
    preferredTerminalId?: number,
  ): number {
    const mapping = this.buildFloorAreaMappings(buildingId, groupId, topology);
    const candidates = mapping.byFloor.get(floor);
    // Try topology candidates first, but validate that thousands part matches the floor
    if (Array.isArray(candidates) && candidates.length) {
      if (preferredTerminalId) {
        const match = candidates.find(
          (c) =>
            Array.isArray(c.terminals) &&
            c.terminals.includes(preferredTerminalId),
        );
        if (match && this.areaIdLooksLikeFloor(match.areaId, floor)) {
          return match.areaId;
        }
      }
      const first = candidates.find((c) =>
        this.areaIdLooksLikeFloor(c.areaId, floor),
      );
      if (first) return first.areaId;
      // If candidates exist but do not numerically match the requested floor, use rule-based mapping
      return this.mapFloorToAreaByRule(floor, groupId);
    }
    // No candidates — use rule-based mapping
    return this.mapFloorToAreaByRule(floor, groupId);
  }

  // Parses robot request placeId into KONE buildingId and groupId
  // Accepts formats like:
  // - "building:123456" (no group -> defaults to '1')
  // - "building:123456:2" (explicit group)
  // - "123456" (no prefix; no group)
  // - "123456:2" (no prefix; explicit group)
  private parsePlaceId(placeId: string): {
    buildingId: string;
    groupId: string;
  } {
    let buildingPart = placeId;
    let groupId = '1';
    const parts = String(placeId).split(':');
    if (parts.length >= 2) {
      const last = parts[parts.length - 1];
      if (/^\d+$/.test(last)) {
        groupId = last;
        buildingPart = parts.slice(0, parts.length - 1).join(':');
      }
    }
    const buildingId = this.formatBuildingId(buildingPart);
    return { buildingId, groupId };
  }

  // Ensure elevator heartbeat before proceeding with any WebSocket action
  private async ensureHeartbeat(
    webSocketConnection: WebSocket,
    buildingId: string,
    groupId: string,
  ): Promise<void> {
    const maxWaitMs = Number(process.env.KONE_HEARTBEAT_TIMEOUT_MS || 30000);
    const intervalMs = Number(process.env.KONE_HEARTBEAT_INTERVAL_MS || 1000);
    const pingEventTimeoutMs = Number(
      process.env.KONE_HEARTBEAT_PING_EVENT_TIMEOUT_MS || 5000,
    );
    const started = Date.now();

    while (true) {
      const elapsed = Date.now() - started;
      if (elapsed > maxWaitMs) {
        throw new Error('Heartbeat check timed out');
      }

      const requestId = this.getRequestId();
      const payload = {
        type: 'common-api',
        buildingId,
        callType: 'ping',
        payload: { request_id: requestId },
        groupId,
      } as const;

      try {
        // Prepare listener for the ping event before sending
        const pingEventPromise: Promise<void> = new Promise(
          (resolve, reject) => {
            const timer = setTimeout(() => {
              webSocketConnection.off('message', onMessage);
              reject(new Error('Ping event timeout'));
            }, pingEventTimeoutMs);

            const onMessage = (data: string) => {
              try {
                const msg = JSON.parse(data);
                if (
                  msg?.callType === 'ping' &&
                  String(msg?.data?.request_id) === String(requestId)
                ) {
                  clearTimeout(timer);
                  webSocketConnection.off('message', onMessage);
                  logIncoming('kone websocket ping', msg);
                  resolve();
                }
              } catch {
                // ignore non-JSON
              }
            };
            // Ensure we see the event even if other listeners are added later
            webSocketConnection.prependListener('message', onMessage);
          },
        );

        logOutgoing('kone websocket ping', payload);
        webSocketConnection.send(JSON.stringify(payload));

        const res = await waitForResponse(
          webSocketConnection,
          String(requestId),
          5,
          true,
        );
        logIncoming('kone websocket acknowledgement', res);
        // Wait for the ping event to arrive before proceeding
        await pingEventPromise;
        return;
      } catch (err: any) {
        const code = err?.statusCode ?? err?.code;
        // Keep pinging on end-to-end comms error (1005) or timeouts
        if (code === 1005 || /timeout/i.test(String(err?.message || ''))) {
          await new Promise((r) => setTimeout(r, intervalMs));
          continue;
        }
        // Other errors are considered fatal for heartbeat
        throw err instanceof Error ? err : new Error(String(err));
      }
    }
  }

  // Helper to send a single hold_open message with given timings
  private async sendHoldOpen(
    connection: WebSocket,
    params: {
      buildingId: string;
      groupId: string;
      servedArea: number;
      liftDeck: number;
      hardTimeSec: number; // 0..10
      softTimeSec?: number; // optional, recommended 5 or 0 when releasing
    },
  ): Promise<WebSocketResponse> {
    const requestId = this.getRequestId();
    const nowIso = new Date().toISOString();
    const softTime = Math.max(0, Math.floor(params.softTimeSec ?? 0));
    const hardTime = Math.max(0, Math.floor(params.hardTimeSec));
    const payload = {
      type: 'lift-call-api-v2',
      buildingId: params.buildingId,
      groupId: params.groupId,
      callType: 'hold_open',
      payload: {
        request_id: requestId,
        time: nowIso,
        served_area: params.servedArea,
        lift_deck: params.liftDeck,
        soft_time: softTime,
        hard_time: hardTime,
      },
    } as const;

    logOutgoing('kone websocket hold_open', payload);
    connection.send(JSON.stringify(payload));
    const res = await waitForResponse(connection, String(requestId), 10, true);
    logIncoming('kone websocket acknowledgement', res);
    return res;
  }

  private monitorElevatorApproachAndDelayDoors(params: {
    request: CallElevatorRequestDTO;
    buildingId: string;
    groupId: string;
    fromFloor: number;
    toFloor: number;
  }): void {
    const minHoldSeconds = 30;
    const holdSecondsEnv = Number(
      process.env.KONE_APPROACH_DOOR_DELAY_SECONDS,
    );
    const configuredHoldSeconds = Number.isFinite(holdSecondsEnv)
      ? Math.floor(holdSecondsEnv)
      : minHoldSeconds;
    const holdSeconds = Math.max(minHoldSeconds, configuredHoldSeconds);

    const monitorDurationEnv = Number(
      process.env.KONE_APPROACH_MONITOR_DURATION_SECONDS,
    );
    const configuredMonitorSeconds = Number.isFinite(monitorDurationEnv)
      ? Math.floor(monitorDurationEnv)
      : 120;
    const monitorDurationSec = Math.max(60, configuredMonitorSeconds);

    const timeoutEnv = Number(process.env.KONE_APPROACH_MONITOR_TIMEOUT_MS);
    const configuredTimeoutMs = Number.isFinite(timeoutEnv)
      ? timeoutEnv
      : monitorDurationSec * 1000;
    const timeoutMs = Math.max(holdSeconds * 2000, configuredTimeoutMs);

    const { request, buildingId, groupId, fromFloor, toFloor } = params;

    void (async () => {
      let connection: WebSocket | undefined;
      const ctxKey = this.getDoorCtxKey(
        request.deviceUuid,
        buildingId,
        groupId,
        request.liftNo,
      );
      let doorContext = this.lastDoorHoldContext.get(ctxKey);
      let destinationArea: number | undefined;

      try {
        const topology = await this.getBuildingTopology(buildingId, groupId);
        destinationArea = this.resolveAreaIdForFloor(
          buildingId,
          groupId,
          topology,
          toFloor,
          doorContext?.terminalId,
        );
      } catch (err) {
        console.error('Failed to pre-resolve destination area', err);
      }

      try {
        const accessToken = await this.accessTokenService.getAccessToken(
          buildingId,
          groupId,
        );
        connection = (await openWebSocketConnection(accessToken)) as unknown as WebSocket;
        await this.ensureHeartbeat(connection, buildingId, groupId);

        const subscriptionId = uuidv4();
        const monitorPayload = {
          type: 'site-monitoring',
          requestId: subscriptionId,
          buildingId,
          callType: 'monitor',
          groupId,
          payload: {
            sub: `approach-${Date.now()}`,
            duration: monitorDurationSec,
            subtopics: [`lift_${request.liftNo}/position`],
          },
        } as const;

        logOutgoing('kone websocket monitor (approach)', monitorPayload);
        connection.send(JSON.stringify(monitorPayload));
        const ack = await waitForResponse(connection, subscriptionId, 10, true);
        logIncoming('kone websocket acknowledgement (approach)', ack);

        await new Promise<void>((resolve) => {
          let settled = false;
          let timer: NodeJS.Timeout | undefined;
          let heldSource = false;
          let heldDestination = false;
          let leftSource = false;

          const cleanup = () => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            connection?.off('message', onMessage);
            resolve();
          };

          const scheduleCleanup = () => {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => {
              cleanup();
            }, timeoutMs);
          };

          const sendDoorHold = async (
            floorType: 'source' | 'destination',
            meta?: { currentFloor?: number; isStopped?: boolean },
          ) => {
            const latestCtx = this.lastDoorHoldContext.get(ctxKey);
            if (latestCtx) {
              doorContext = latestCtx;
            }
            const delayRequest = new DelayDoorRequestDTO();
            delayRequest.appname = request.appname;
            delayRequest.check = request.check;
            delayRequest.sign = request.sign;
            delayRequest.deviceUuid = request.deviceUuid;
            delayRequest.placeId = request.placeId;
            delayRequest.ts = Math.floor(Date.now() / 1000);
            delayRequest.liftNo = request.liftNo;
            delayRequest.seconds = holdSeconds;

            const hasDestinationArea =
              typeof destinationArea === 'number' &&
              !Number.isNaN(destinationArea);

            if (floorType === 'destination' && doorContext && hasDestinationArea) {
              const resolvedArea = Number(destinationArea);
              if (!Number.isNaN(resolvedArea)) {
                const updatedContext = {
                  ...doorContext,
                  servedArea: resolvedArea,
                  updatedAt: Date.now(),
                };
                doorContext = updatedContext;
                this.lastDoorHoldContext.set(ctxKey, updatedContext);
              }
            }

            const debugServedArea =
              floorType === 'destination' && hasDestinationArea
                ? Number(destinationArea)
                : doorContext?.servedArea;
            logOutgoing('kone monitor door_hold trigger', {
              floorType,
              servedArea: debugServedArea,
              fromFloor,
              toFloor,
              currentFloor: meta?.currentFloor ?? null,
              isStopped: Boolean(meta?.isStopped),
              leftSource,
            });

            try {
              await this.delayElevatorDoors(delayRequest);
            } catch (err) {
              console.error('Failed to auto-delay elevator doors', err);
            }
          };

          const onMessage = async (raw: string) => {
            try {
              const msg = JSON.parse(raw);
              const isPosition =
                msg?.subtopic === `lift_${request.liftNo}/position` ||
                msg?.callType === 'monitor-lift-position';
              if (!isPosition) {
                return;
              }
              logIncoming('kone websocket monitor (approach)', msg);
              const position = plainToInstance(LiftPositionDTO, msg.data);
              const currentFloor = Number(position?.cur);
              if (Number.isNaN(currentFloor)) return;

              scheduleCleanup();

              const movingState = String(position?.moving_state || '').toUpperCase();
              const isStopped = movingState === 'STOPPED' || movingState === 'STANDING';

              if (!heldSource && currentFloor === fromFloor) {
                heldSource = true;
                await sendDoorHold('source', { currentFloor, isStopped });
                return;
              }

              if (heldSource && !leftSource && currentFloor !== fromFloor) {
                leftSource = true;
              }

              if (!heldDestination && leftSource && currentFloor === toFloor && isStopped) {
                heldDestination = true;
                await sendDoorHold('destination', { currentFloor, isStopped });
              }

              if (heldSource && heldDestination) {
                cleanup();
              }
            } catch (err) {
              console.error('Failed to process approach monitor message', err);
            }
          };

          scheduleCleanup();
          connection?.on('message', onMessage);
        });
      } catch (err) {
        console.error('Failed monitoring elevator approach', err);
      } finally {
        try {
          connection?.close();
        } catch {}
      }
    })();
  }

  private async getBuildingTopology(
    buildingId: string,
    groupId: string,
  ): Promise<BuildingTopology> {
    const cacheKey = `${buildingId}|${groupId}`;
    let topology = this.buildingTopologyCache.get(cacheKey);
    if (!topology) {
      const token = await this.accessTokenService.getAccessToken(
        buildingId,
        groupId,
      );
      topology = await fetchBuildingTopology(token, buildingId, groupId);
      this.buildingTopologyCache.set(cacheKey, topology);
    }
    return topology;
  }

  // (no local config.json reading)

  async listElevators(
    request: ListElevatorsRequestDTO,
  ): Promise<ListElevatorsResponseDTO> {
    const response = new ListElevatorsResponseDTO();
    const { buildingId, groupId } = this.parsePlaceId(request.placeId);
    const topology = await this.getBuildingTopology(buildingId, groupId);

    response.result =
      (topology as any).groups?.flatMap((group: any) => {
        const lifts: any[] = Array.isArray(group?.lifts) ? group.lifts : [];
        const rawGroupId = group?.groupId ?? group?.group_id ?? groupId;
        const resolvedGroupId = String(rawGroupId)
          .split(':')
          .pop() || String(rawGroupId);
        const mapping = this.buildFloorAreaMappings(
          buildingId,
          resolvedGroupId,
          topology,
        );
        const hasTopologyFloors = mapping.byFloor.size > 0;
        return lifts.map((lift: any) => {
        const liftNo = getLiftNumber(lift);
          const floorsArr: any[] = Array.isArray(lift?.floors) ? lift.floors : [];
          const nums = new Set<number>();
          for (const f of floorsArr) {
            const groupFloorId = Number(
              typeof f?.group_floor_id !== 'undefined'
                ? f.group_floor_id
                : (f as any)?.groupFloorId,
            );
            let added = false;
            if (hasTopologyFloors && !isNaN(groupFloorId)) {
              const entries = mapping.byGroupFloor.get(groupFloorId);
              if (Array.isArray(entries) && entries.length) {
                for (const entry of entries) {
                  if (typeof entry?.floor === 'number' && !isNaN(entry.floor)) {
                    nums.add(entry.floor);
                  }
                }
                added = true;
              }
            }
            if (!added) {
              const candidate = Number(
                typeof f?.lift_floor_id !== 'undefined'
                  ? f.lift_floor_id
                  : typeof f?.liftFloorId !== 'undefined'
                    ? f.liftFloorId
                    : !isNaN(groupFloorId)
                      ? groupFloorId
                      : (f as any)?.floor,
              );
              if (isFinite(candidate)) {
                if (hasTopologyFloors) {
                  if (mapping.byFloor.has(candidate)) {
                    nums.add(candidate);
                  }
                } else {
                  nums.add(candidate);
                }
              }
            }
          }
          const sorted = Array.from(nums).sort((a, b) => a - b);
          return {
            liftNo,
            accessibleFloors: sorted.join(','),
            bindingStatus: '11',
          };
        });
      }) || [];

    response.errcode = 0;
    response.errmsg = 'SUCCESS';

    return response;
  }

  // Fetch lift status via WebSocket API
  // Optionally reuse an existing WebSocket connection (do not close it)
  async getLiftStatus(
    request: LiftStatusRequestDTO,
    existingConnection?: WebSocket,
  ): Promise<LiftStatusResponseDTO> {
    const { buildingId, groupId } = this.parsePlaceId(request.placeId);
    const accessToken = await this.accessTokenService.getAccessToken(
      buildingId,
      groupId,
    );
    const response = new LiftStatusResponseDTO();
    const lockCtxKey = this.getLockCtxKey(
      request.deviceUuid,
      request.placeId,
      request.liftNo,
    );

    try {
      const cacheKey = `${buildingId}|${groupId}`;
      let topology = this.buildingTopologyCache.get(cacheKey);
      if (!topology) {
        logOutgoing('kone fetchBuildingConfig', { buildingId, groupId });
        topology = await fetchBuildingTopology(
          accessToken,
          buildingId,
          groupId,
        );
        logIncoming('kone fetchBuildingConfig', topology);
        this.buildingTopologyCache.set(cacheKey, topology);
      }
      const targetGroupId = groupId;
      const webSocketConnection =
        existingConnection || (await openWebSocketConnection(accessToken));
      // Heartbeat gate: ensure connection is healthy before subscribing
      await this.ensureHeartbeat(
        webSocketConnection as unknown as WebSocket,
        buildingId,
        groupId,
      );
      const requestId = uuidv4();
      const monitorPayload = {
        type: 'site-monitoring',
        requestId,
        buildingId,
        callType: 'monitor',
        groupId: targetGroupId,
        payload: {
          sub: `status-${Date.now()}`,
          duration: 30,
          subtopics: [
            `lift_${request.liftNo}/position`,
            `lift_${request.liftNo}/doors`,
            // Subscribe to lift status updates to receive lift_mode
            `lift_${request.liftNo}/status`,
          ],
        },
      };
      logOutgoing('kone websocket monitor', monitorPayload);
      webSocketConnection.send(JSON.stringify(monitorPayload));
      const ack = await waitForResponse(
        webSocketConnection,
        requestId,
        10,
        true,
      );
      logIncoming('kone websocket acknowledgement', ack);
      const doorMap: Record<string, number> = {
        OPENING: 1,
        OPENED: 1,
        CLOSING: 2,
        CLOSED: 2,
      };
      const cache: { position?: LiftPositionDTO } = {};
      let modeStr = 'UNKNOWN';
      let doorState = 0;
      let doorReceived = false;

      await new Promise<void>((resolve) => {
        const shouldClose = !existingConnection;
        const timer = setTimeout(() => {
          if (shouldClose) webSocketConnection.close();
          webSocketConnection.off('message', onMessage);
          resolve();
        }, 2000);

        const checkComplete = () => {
          if (cache.position && doorReceived) {
            setTimeout(() => {
              clearTimeout(timer);
              if (shouldClose) webSocketConnection.close();
              webSocketConnection.off('message', onMessage);
              resolve();
            }, 200);
          }
        };
        const onMessage = (data: string) => {
          try {
            const msg = JSON.parse(data);
            if (msg?.callType === 'ping') {
              // Ignore ping events here to avoid mislabeling as monitor
              return;
            }
            logIncoming('kone websocket monitor', msg);
            if (msg.subtopic === `lift_${request.liftNo}/position`) {
              cache.position = plainToInstance(LiftPositionDTO, msg.data);
              // Some streams provide door state in position payload
              if (typeof msg.data?.door !== 'undefined') {
                doorState = msg.data.door ? 1 : 0;
                doorReceived = true;
              }
              checkComplete();
            } else if (msg.subtopic === `lift_${request.liftNo}/doors`) {
              const door = plainToInstance(LiftDoorDTO, msg.data);
              const mapped = doorMap[door.state] ?? 0;
              if (mapped === 1) {
                doorState = 1;
              } else if (doorState === 0) {
                doorState = mapped;
              }
              doorReceived = true;
              checkComplete();
            } else if (msg.subtopic === `lift_${request.liftNo}/status`) {
              // Lift mode is provided here for site-monitoring 'lift-status'
              if (
                msg.data?.lift_mode !== undefined &&
                msg.data?.lift_mode !== null
              ) {
                modeStr = String(msg.data.lift_mode);
              }
              checkComplete();
            } else if (msg.callType === 'monitor-lift-position') {
              cache.position = plainToInstance(LiftPositionDTO, msg.data);
              if (typeof msg.data?.door !== 'undefined') {
                doorState = msg.data.door ? 1 : 0;
                doorReceived = true;
              }
              checkComplete();
            } else if (msg.callType === 'monitor-lift-status') {
              if (msg.data?.lift_mode) {
                modeStr = String(msg.data.lift_mode);
              }
              checkComplete();
            }
          } catch {
            // ignore
          }
        };
        webSocketConnection.on('message', onMessage);
      });

      const directionMap: Record<string, number> = { UP: 1, DOWN: 2 };
      const movingMap: Record<string, number> = {
        MOVING: 1,
        STARTING: 1,
        DECELERATING: 1,
        STOPPED: 0,
        STANDING: 0,
      };
      const floor = cache.position?.cur ?? 0;
      const direction = directionMap[cache.position?.dir || ''] ?? 0;
      const moving = movingMap[cache.position?.moving_state || ''] ?? 0;

      response.result = {
        liftNo: request.liftNo,
        floor,
        state: moving,
        locked: Boolean(this.lockFloorCache.get(lockCtxKey)?.locked),
        prevDirection: direction,
        liftDoorStatus: doorState,
        mode: modeStr || cache.position?.drive_mode || 'UNKNOWN',
      };
      response.errcode = 0;
      response.errmsg = 'SUCCESS';
    } catch (err) {
      console.error('Failed to fetch lift status', err);
      response.result = {
        liftNo: request.liftNo,
        floor: 0,
        state: 0,
        locked: Boolean(this.lockFloorCache.get(lockCtxKey)?.locked),
        prevDirection: 0,
        liftDoorStatus: 0,
        mode: 'UNKNOWN',
      };
      response.errcode = 1;
      response.errmsg = 'FAILED';
    }

    return response;
  }

  async callElevator(
    request: CallElevatorRequestDTO,
  ): Promise<CallElevatorResponseDTO> {
    const requestId = this.getRequestId();
    const { buildingId: targetBuildingId, groupId } = this.parsePlaceId(
      request.placeId,
    );

    const lockCtx = this.lockFloorCache.get(
      this.getLockCtxKey(request.deviceUuid, request.placeId, request.liftNo),
    );
    const fromFloor =
      typeof lockCtx?.fromFloor === 'number' && !isNaN(lockCtx.fromFloor)
        ? lockCtx.fromFloor
        : undefined;
    const toFloor =
      typeof lockCtx?.toFloor === 'number' && !isNaN(lockCtx.toFloor)
        ? lockCtx.toFloor
        : typeof request.toFloor === 'number' && !isNaN(request.toFloor)
          ? request.toFloor
          : undefined;
    if (typeof fromFloor === 'undefined' || typeof toFloor === 'undefined') {
      const missingCtx = new CallElevatorResponseDTO();
      missingCtx.errcode = 1;
      missingCtx.errmsg = 'MISSING_LOCK_CONTEXT';
      return missingCtx;
    }

    // Idempotency check: if same device + journey within TTL, return cached response
    const idempTtlMs = Number(
      process.env.KONE_CALL_IDEMPOTENCY_TTL_MS || 10_000,
    );
    const journeyKey = `${request.deviceUuid}|${targetBuildingId}|${groupId}|${fromFloor}|${toFloor}`;
    const cached = this.callIdempotencyCache.get(journeyKey);
    if (cached && Date.now() < cached.expiresAt) {
      return plainToInstance(CallElevatorResponseDTO, cached.response);
    }

    // Rate limiting per deviceUuid
    const windowMs = Number(process.env.KONE_CALL_RATE_WINDOW_MS || 10_000);
    const maxReq = Number(process.env.KONE_CALL_RATE_MAX_REQUESTS || 5);
    const rl = this.callRateLimit.get(request.deviceUuid) || {
      count: 0,
      windowStart: Date.now(),
    };
    const now = Date.now();
    if (now - rl.windowStart > windowMs) {
      rl.windowStart = now;
      rl.count = 0;
    }
    if (rl.count >= maxReq) {
      const limited = new CallElevatorResponseDTO();
      limited.errcode = 1;
      limited.errmsg = 'RATE_LIMITED';
      return limited;
    }
    rl.count += 1;
    this.callRateLimit.set(request.deviceUuid, rl);
    const cacheKey = `${targetBuildingId}|${groupId}`;
    let topology = this.buildingTopologyCache.get(cacheKey);
    if (!topology) {
      const buildingToken = await this.accessTokenService.getAccessToken(
        targetBuildingId,
        groupId,
      );
      logOutgoing('kone fetchBuildingConfig', {
        buildingId: targetBuildingId,
        groupId,
      });
      topology = await fetchBuildingTopology(
        buildingToken,
        targetBuildingId,
        groupId,
      );
      logIncoming('kone fetchBuildingConfig', topology);
      this.buildingTopologyCache.set(cacheKey, topology);
    }
    const accessToken = await this.accessTokenService.getAccessToken(
      targetBuildingId,
      groupId,
    );
    const targetGroupId = groupId;

    // Open a WebSocket for this endpoint, ping using the same connection
    const webSocketConnection = await openWebSocketConnection(accessToken);
    try {
      await this.ensureHeartbeat(
        webSocketConnection as unknown as WebSocket,
        targetBuildingId,
        targetGroupId,
      );

      // Resolve target group and its topology
      const groups = topology.groups || [];
      const groupObj =
        groups.find(
          (g: any) =>
            String(g.groupId || '')
              .split(':')
              .pop()
              ?.toString() === String(targetGroupId),
        ) || groups[0];

      // Map lift numbers -> deck area ids (prefer deck index 0)
      const liftDeckAreas = new Map<number, number[]>();
      try {
        for (const l of ((groupObj as any)?.lifts || []) as any[]) {
          const liftNo = Number(
            String((l as any)?.liftId || (l as any)?.lift_id)
              .split(':')
              .pop(),
          );
          if (isNaN(liftNo)) continue;
          const decks = Array.isArray((l as any)?.decks)
            ? (l as any).decks
            : [];
          const areas: number[] = [];
          for (const d of decks as any[]) {
            // area id may be available either as numeric area_id or prefixed deckAreaId
            const raw =
              typeof (d as any)?.area_id !== 'undefined'
                ? (d as any).area_id
                : (d as any)?.deckAreaId;
            const areaNum = Number(
              String(raw ?? '')
                .split(':')
                .pop(),
            );
            // prefer deck 0; include other decks only if deck is undefined
            const deckIndex =
              typeof (d as any)?.deck === 'number'
                ? Number((d as any).deck)
                : typeof (d as any)?.deckIndex === 'number'
                  ? Number((d as any).deckIndex)
                  : undefined;
            if (!isNaN(areaNum)) {
              if (deckIndex === 0) areas.push(areaNum);
              else if (deckIndex === undefined) areas.push(areaNum);
            }
          }
          if (areas.length) liftDeckAreas.set(liftNo, areas);
        }
      } catch {
        // noop — fall back below
      }

      const floorMappingEntry = this.buildFloorAreaMappings(
        targetBuildingId,
        targetGroupId,
        topology,
      );

      const collectTerminals = (
        entries:
          | Array<{
              terminals: number[];
            }>
          | undefined,
      ): number[] => {
        if (!Array.isArray(entries)) return [];
        const seen = new Set<number>();
        const result: number[] = [];
        for (const entry of entries) {
          if (!Array.isArray((entry as any)?.terminals)) continue;
          for (const value of (entry as any).terminals) {
            const id = Number(value);
            if (!isNaN(id) && !seen.has(id)) {
              seen.add(id);
              result.push(id);
            }
          }
        }
        return result;
      };

      const dedupeNumericList = (values: number[]): number[] => {
        const seen = new Set<number>();
        const result: number[] = [];
        for (const value of values) {
          const id = Number(value);
          if (!isNaN(id) && !seen.has(id)) {
            seen.add(id);
            result.push(id);
          }
        }
        return result;
      };

      const fromFloorEntries = floorMappingEntry.byFloor.get(fromFloor);
      const toFloorEntries = floorMappingEntry.byFloor.get(toFloor);
      const fromFloorTerminals = collectTerminals(fromFloorEntries);
      const toFloorTerminals = collectTerminals(toFloorEntries);

      let candidateTerminals: number[] = [];
      if (fromFloorTerminals.length && toFloorTerminals.length) {
        candidateTerminals = fromFloorTerminals.filter((value) =>
          toFloorTerminals.includes(value),
        );
      }
      if (!candidateTerminals.length && fromFloorTerminals.length) {
        candidateTerminals = [...fromFloorTerminals];
      } else if (!candidateTerminals.length && toFloorTerminals.length) {
        candidateTerminals = [...toFloorTerminals];
      }
      if (
        !candidateTerminals.length &&
        Array.isArray(floorMappingEntry.groupTerminals) &&
        floorMappingEntry.groupTerminals.length
      ) {
        candidateTerminals = [...floorMappingEntry.groupTerminals];
      }
      candidateTerminals = dedupeNumericList(candidateTerminals);

      // Select terminal from config; hardcode preferred type order
      // Prefer Virtual, then LCS, then DOP
      const preferredTypes = [
        'virtual',
        // 'lcs'
        //, 'vcs'
      ];
      const selectedTerminalId = this.pickTerminalId(
        targetBuildingId,
        targetGroupId,
        topology,
        (groupObj as any)?.terminals,
        preferredTypes.length ? preferredTypes : undefined,
        candidateTerminals.length ? candidateTerminals : undefined,
      );

      // Resolve areas using robust per-group mapping
      const fromArea = this.resolveAreaIdForFloor(
        targetBuildingId,
        targetGroupId,
        topology,
        fromFloor,
        selectedTerminalId,
      );
      const toArea = this.resolveAreaIdForFloor(
        targetBuildingId,
        targetGroupId,
        topology,
        toFloor,
        selectedTerminalId,
      );

      const terminalSource = candidateTerminals.some((value) =>
        fromFloorTerminals.includes(value) || toFloorTerminals.includes(value),
      )
        ? 'floor-destination'
        : candidateTerminals.length
          ? 'group-default'
          : 'fallback-default';
      const mappingRuleLabel =
        terminalSource === 'fallback-default'
          ? 'validated-destinations-or-rule-fallback'
          : 'destinations-terminal-aware';

      // Build allowed_lifts strictly from the requested liftNo
      let allowedLiftAreaIds: number[] = [];
      {
        const areas = liftDeckAreas.get(request.liftNo);
        if (areas?.length) allowedLiftAreaIds.push(...areas);
      }
      // De-duplicate and keep numeric ids only
      allowedLiftAreaIds = Array.from(
        new Set(
          allowedLiftAreaIds.filter((n) => typeof n === 'number' && !isNaN(n)),
        ),
      );

      const usedFromArea = fromArea;
      const usedToArea = toArea;
      logOutgoing('kone floor->area mapping', {
        buildingId: targetBuildingId,
        groupId: targetGroupId,
        fromFloor,
        toFloor,
        fromArea: usedFromArea,
        toArea: usedToArea,
        terminal: selectedTerminalId,
        terminalCandidates: candidateTerminals,
        fromFloorTerminals,
        toFloorTerminals,
        terminalSource,
        allowed_lifts: allowedLiftAreaIds,
        mappingRule: mappingRuleLabel,
      });

      // Before placing a call, ensure lift_mode == 0 from `lift_${request.liftNo}/status`
      try {
        const statusRequestId = uuidv4();
        const monitorStatusPayload = {
          type: 'site-monitoring',
          requestId: statusRequestId,
          buildingId: targetBuildingId,
          callType: 'monitor',
          groupId: targetGroupId,
          payload: {
            sub: `status-check-${Date.now()}`,
            duration: 5,
            subtopics: [`lift_${request.liftNo}/status`],
          },
        } as const;
        logOutgoing('kone websocket monitor (pre-call lift_mode)', monitorStatusPayload);
        webSocketConnection.send(JSON.stringify(monitorStatusPayload));
        await waitForResponse(webSocketConnection, statusRequestId, 5, true);

        const modeOk: boolean = await new Promise((resolve) => {
          const timeoutMs = Number(process.env.KONE_LIFT_MODE_WAIT_TIMEOUT_MS || 2000);
          const timer = setTimeout(() => {
            webSocketConnection.off('message', onMessage);
            resolve(false); // could not confirm mode==0 in time
          }, timeoutMs);

          const onMessage = (data: string) => {
            try {
              const msg = JSON.parse(data);
              // Accept either subtopic or callType variants
              const isStatusEvent =
                msg?.subtopic === `lift_${request.liftNo}/status` ||
                msg?.callType === 'monitor-lift-status';
              if (!isStatusEvent) return;
              logIncoming('kone websocket monitor (pre-call lift_status)', msg);
              const raw = msg?.data?.lift_mode;
              // Only proceed if lift_mode is strictly 0
              const ok = raw === 0 || raw === '0';
              clearTimeout(timer);
              webSocketConnection.off('message', onMessage);
              resolve(Boolean(ok));
            } catch {
              // ignore non-JSON
            }
          };
          webSocketConnection.on('message', onMessage);
        });

        if (!modeOk) {
          const blocked = new CallElevatorResponseDTO();
          blocked.errcode = 1;
          blocked.errmsg = 'LIFT_UNAVAILABLE';
          return plainToInstance(CallElevatorResponseDTO, blocked);
        }
      } catch (e) {
        // If status check fails for any reason, do not place the call
        const blocked = new CallElevatorResponseDTO();
        blocked.errcode = 1;
        blocked.errmsg = 'LIFT_UNAVAILABLE';
        return plainToInstance(CallElevatorResponseDTO, blocked);
      }

      // Use the same WebSocket connection for the action
      logIncoming('kone websocket', { event: 'open' });

      type CallEvent = {
        callType: string;
        data?: { request_id: number; success: boolean; session_id: number };
      };

      // Promise for call event carrying session information
      const callEventPromise = new Promise<CallEvent>((resolve, reject) => {
        const onMessage = (data: string) => {
          try {
            const parsed = JSON.parse(data) as CallEvent;
            const callType = (parsed as any)?.callType;
            const msgType = (parsed as any)?.type;
            // Only log known callType events; ignore pure response (ok/error) here
            if (callType === 'ping') {
              logIncoming('kone websocket ping', parsed);
            } else if (callType === 'action') {
              logIncoming('kone websocket action', parsed);
            } else if (msgType === 'ok' || msgType === 'error') {
              // ack is logged elsewhere; skip duplicate logging here
            }
            if (
              parsed.callType === 'action' &&
              parsed.data?.request_id === requestId
            ) {
              webSocketConnection.off('message', onMessage);
              resolve(parsed);
            }
          } catch (err) {
            webSocketConnection.off('message', onMessage);
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        };
        webSocketConnection.on('message', onMessage);
      });

      // Build the call payload using the areas previously generated
      const destinationCallPayload = {
        type: 'lift-call-api-v2',
        buildingId: targetBuildingId,
        callType: 'action',
        groupId: targetGroupId,
        payload: {
          request_id: requestId,
          area: usedFromArea, // current floor
          time: new Date().toISOString(),
          terminal: selectedTerminalId,

          // terminal: 10011,
          call: {
            action: 2,
            // Use deck area_ids from building config as allowed_lifts
            ...(allowedLiftAreaIds.length
              ? { allowed_lifts: allowedLiftAreaIds }
              : {}),
            destination: usedToArea,
          },
        },
      };
      logOutgoing('kone websocket action', destinationCallPayload);

      // Send the request
      webSocketConnection.send(JSON.stringify(destinationCallPayload));

      // Wait for ack and call event concurrently.
      // Attach a catch to the ack promise immediately to avoid unhandled rejections
      // if the service returns an error response before we await it.
      let ackError: any | undefined;
      const ackPromise = waitForResponse(
        webSocketConnection,
        String(requestId),
        10,
        true,
      )
        .then((ack) => {
          logIncoming('kone websocket acknowledgement', ack);
          return ack;
        })
        .catch((err) => {
          // Swallow at creation time to prevent unhandled rejection, but keep the error for later
          ackError = err;
          logIncoming('kone websocket acknowledgement error', err);
          return undefined as unknown as WebSocketResponse;
        });

      const response = new CallElevatorResponseDTO();
      try {
        // Also protect waits with timeouts and allow early exit on ack failure
        const callEventTimeoutMs = Number(
          process.env.KONE_CALL_EVENT_TIMEOUT_MS || 15000,
        );

        // Race ack vs call-event first for early error handling
        const first = await Promise.race([
          callEventPromise.then((evt) => ({ kind: 'event' as const, evt })),
          ackPromise.then(() => ({ kind: 'ack' as const })),
          new Promise<{ kind: 'timeout' }>((resolve) =>
            setTimeout(() => resolve({ kind: 'timeout' }), callEventTimeoutMs),
          ),
        ]);

        if (first.kind === 'ack' && ackError) {
          response.errcode = 1;
          response.errmsg = 'FAILED';
          return plainToInstance(CallElevatorResponseDTO, response);
        }

        // Ensure both are completed (if event came first, await ack; if ack came first and ok, await event)
        let callEvent: any | undefined =
          first.kind === 'event' ? first.evt : undefined;
        if (!callEvent) {
          // Wait remaining time for event
          const remainingEvent = await Promise.race([
            callEventPromise,
            new Promise<never>((_, reject) =>
              setTimeout(
                () => reject(new Error('Call event timeout')),
                callEventTimeoutMs,
              ),
            ),
          ]);
          callEvent = remainingEvent;
        }

        const wsResponse = await ackPromise;

        if (ackError) {
          response.errcode = 1;
          response.errmsg = 'FAILED';
          return plainToInstance(CallElevatorResponseDTO, response);
        }

        if (callEvent.data?.success) {
          response.errcode = 0;
          response.errmsg = 'SUCCESS';
          response.sessionId = callEvent.data?.session_id;
          response.destination = toFloor;
          this.monitorElevatorApproachAndDelayDoors({
            request,
            buildingId: targetBuildingId,
            groupId: targetGroupId,
            fromFloor,
            toFloor,
          });
          // Save context for future hold_open calls from the same client
          const liftDeck = Array.isArray(allowedLiftAreaIds)
            ? Number(allowedLiftAreaIds[0])
            : NaN;
          this.lastDoorHoldContext.set(
            this.getDoorCtxKey(
              request.deviceUuid,
              targetBuildingId,
              targetGroupId,
              request.liftNo,
            ),
            {
              buildingId: targetBuildingId,
              groupId: targetGroupId,
              liftNo: request.liftNo,
              servedArea: usedFromArea,
              liftDeck: isNaN(liftDeck) ? 0 : liftDeck,
              terminalId: selectedTerminalId,
              updatedAt: Date.now(),
            },
          );
        } else {
          response.errcode = 1;
          response.errmsg = 'FAILURE';
        }
        response.connectionId = (wsResponse as any)?.connectionId;
        response.requestId = Number((wsResponse as any)?.requestId);
        response.statusCode = (wsResponse as any)?.statusCode;
        // Cache successful journey result for idempotency window
        if (response.errcode === 0) {
          this.callIdempotencyCache.set(journeyKey, {
            expiresAt: Date.now() + idempTtlMs,
            response: plainToInstance(CallElevatorResponseDTO, response),
          });
        }
        return plainToInstance(CallElevatorResponseDTO, response);
      } catch (err) {
        console.error('Failed to call elevator', err);
        response.errcode = 1;
        response.errmsg = 'FAILED';
        return plainToInstance(CallElevatorResponseDTO, response);
      }
    } finally {
      try {
        webSocketConnection.close();
      } catch {}
    }
  }

  // Delay opening of elevator doors
  async delayElevatorDoors(
    request: DelayDoorRequestDTO,
  ): Promise<BaseResponseDTO> {
    const response = new BaseResponseDTO();
    try {
      const { buildingId, groupId } = this.parsePlaceId(request.placeId);
      const accessToken = await this.accessTokenService.getAccessToken(
        buildingId,
        groupId,
      );

      const cacheKey = `${buildingId}|${groupId}`;
      let topology = this.buildingTopologyCache.get(cacheKey);
      if (!topology) {
        logOutgoing('kone fetchBuildingConfig', { buildingId, groupId });
        topology = await fetchBuildingTopology(
          accessToken,
          buildingId,
          groupId,
        );
        logIncoming('kone fetchBuildingConfig', topology);
        this.buildingTopologyCache.set(cacheKey, topology);
      }

      const targetGroupId = groupId;

      // Fetch previously saved context; fall back to deriving if missing
      const ctxKey = this.getDoorCtxKey(
        request.deviceUuid,
        buildingId,
        targetGroupId,
        request.liftNo,
      );
      let servedArea = 0;
      let liftDeck = 0;
      const saved = this.lastDoorHoldContext.get(ctxKey);
      if (saved) {
        servedArea = saved.servedArea || 0;
        liftDeck = saved.liftDeck || 0;
      }
      if (!servedArea || !liftDeck) {
        // Derive from topology if not found (best-effort)
        try {
          // Source floor is unknown at this point; try to resolve by current floor 0 mapping as last resort
          // Prefer mapping rule for a plausible area
          servedArea =
            servedArea || this.mapFloorToAreaByRule(0, targetGroupId);
          // For lift deck, pick first deck's area id number if available
          const lift = (topology as any)?.groups?.[0]?.lifts?.find(
          (l: any) => getLiftNumber(l) === request.liftNo,
          );
          const d0 = lift?.decks?.[0];
          const deckAreaNum = Number(
            String(d0?.deckAreaId ?? d0?.area_id ?? '')
              .split(':')
              .pop(),
          );
          if (!isNaN(deckAreaNum)) liftDeck = deckAreaNum;
        } catch {}
      }

      const rawSeconds = Math.max(0, Math.floor(Number(request.seconds) || 0));
      const requestTs = Number(request.ts);
      const nowMs = Date.now();
      const requestMs = !isNaN(requestTs)
        ? requestTs > 1e12
          ? requestTs
          : requestTs * 1000
        : NaN;
      const drift =
        !isNaN(requestMs) && requestMs > 0 ? (nowMs - requestMs) / 1000 : 0;
      const requestedSeconds = Math.max(
        0,
        drift > 0 ? rawSeconds - Math.floor(drift) : rawSeconds,
      );

      // If there is an existing task for this client+lift, update or cancel it
      const existing = this.doorHoldTasks.get(ctxKey);
      if (existing) {
        if (!servedArea && existing.servedArea) {
          servedArea = existing.servedArea;
        }
        if (!liftDeck && existing.liftDeck) {
          liftDeck = existing.liftDeck;
        }
      }
      if (!servedArea || !liftDeck) {
        response.errcode = 1;
        response.errmsg = 'MISSING_DOOR_CONTEXT';
        return response;
      }

      // Helper to open or ensure connection
      const ensureConnection = async (): Promise<WebSocket> => {
        if (existing?.connection && existing.active) return existing.connection;
        const conn = await openWebSocketConnection(accessToken);
        await this.ensureHeartbeat(conn as unknown as WebSocket, buildingId, targetGroupId);
        return conn as unknown as WebSocket;
      };

      // Constants for scheduling based on KONE guidance (extend ~5s at a time)
      const hardChunkEnv = Number(process.env.KONE_HOLD_OPEN_HARD_CHUNK_SECONDS);
      const HARD_CHUNK_SEC = Number.isFinite(hardChunkEnv)
        ? Math.max(1, Math.min(10, Math.floor(hardChunkEnv)))
        : 5;

      const maxHardEnv = Number(process.env.KONE_HOLD_OPEN_MAX_HARD_SECONDS);
      const MAX_HARD_SEC = Number.isFinite(maxHardEnv)
        ? Math.max(HARD_CHUNK_SEC, Math.min(30, Math.floor(maxHardEnv)))
        : Math.max(HARD_CHUNK_SEC, 5);

      const softBufferEnv = Number(
        process.env.KONE_HOLD_OPEN_SOFT_BUFFER_SECONDS || 10,
      );
      const SOFT_BUFFER_SEC = Number.isFinite(softBufferEnv)
        ? Math.max(0, Math.floor(softBufferEnv))
        : 10;

      const maxSoftEnv = Number(process.env.KONE_HOLD_OPEN_MAX_SOFT_SECONDS);
      const MAX_SOFT_SEC = Number.isFinite(maxSoftEnv)
        ? Math.max(HARD_CHUNK_SEC, Math.min(60, Math.floor(maxSoftEnv)))
        : Math.max(HARD_CHUNK_SEC, 15);

      const intervalEnv = Number(process.env.KONE_HOLD_OPEN_SEND_INTERVAL_MS);
      const defaultInterval = Math.max(500, HARD_CHUNK_SEC * 1000 - 1000);
      let INTERVAL_MS = Number.isFinite(intervalEnv)
        ? Math.max(500, Math.floor(intervalEnv))
        : defaultInterval;
      if (INTERVAL_MS >= HARD_CHUNK_SEC * 1000) {
        INTERVAL_MS = HARD_CHUNK_SEC * 1000 - 250;
      }
      INTERVAL_MS = Math.max(500, INTERVAL_MS);

      const computeSendTimings = (remainingMs: number) => {
        const remainingSec = Math.max(1, Math.ceil(remainingMs / 1000));
        const hardTimeSec = Math.max(
          1,
          Math.min(HARD_CHUNK_SEC, Math.min(MAX_HARD_SEC, remainingSec)),
        );
        const softTarget = hardTimeSec + SOFT_BUFFER_SEC;
        const softTimeSec = Math.max(
          hardTimeSec,
          Math.min(MAX_SOFT_SEC, softTarget),
        );
        return { hardTimeSec, softTimeSec };
      };
      const RELEASE_AT_END = String(
        process.env.KONE_HOLD_OPEN_SEND_RELEASE_AT_END || 'true',
      ).toLowerCase() !== 'false';

      // If requestedSeconds is 0, send a release (0/0) and cancel any existing task
      if (requestedSeconds === 0) {
        const conn = await ensureConnection();
        await this.sendHoldOpen(conn, {
          buildingId,
          groupId: targetGroupId,
          servedArea,
          liftDeck,
          hardTimeSec: 0,
          softTimeSec: 0,
        });
        try {
          conn.close();
        } catch {}
        if (existing?.timer) clearTimeout(existing.timer);
        if (existing) this.doorHoldTasks.delete(ctxKey);
        response.errcode = 0;
        response.errmsg = 'SUCCESS';
        return response;
      }

      // Start or update background scheduler
      const startOrUpdate = async () => {
        // If a task exists, just extend or shorten the end time
        if (existing && existing.active) {
          existing.endAtMs = Date.now() + requestedSeconds * 1000;
          if (!isNaN(servedArea)) existing.servedArea = servedArea;
          if (!isNaN(liftDeck)) existing.liftDeck = liftDeck;
          if (existing.timer) {
            clearTimeout(existing.timer);
            existing.timer = undefined;
          }
          try {
            if (typeof existing.tick === 'function') {
              await existing.tick();
            } else {
              const remainingMs = existing.endAtMs - Date.now();
              if (remainingMs > 500) {
                const { hardTimeSec, softTimeSec } = computeSendTimings(remainingMs);
                await this.sendHoldOpen(existing.connection, {
                  buildingId,
                  groupId: targetGroupId,
                  servedArea: existing.servedArea,
                  liftDeck: existing.liftDeck,
                  hardTimeSec,
                  softTimeSec,
                });
              }
            }
            response.errcode = 0;
            response.errmsg = 'SUCCESS';
          } catch (e) {
            console.error('Failed to refresh door hold schedule', e);
            response.errcode = 1;
            response.errmsg = 'FAILED';
          }
          return;
        }

        // Else create a new task with its own connection
        const connection = await ensureConnection();
        const task = {
          connection,
          buildingId,
          groupId: targetGroupId,
          servedArea,
          liftDeck,
          endAtMs: Date.now() + requestedSeconds * 1000,
          timer: undefined as unknown as NodeJS.Timeout | undefined,
          active: true,
          tick: undefined as (() => Promise<void>) | undefined,
        };
        this.doorHoldTasks.set(ctxKey, task);

        // Define the tick function that keeps extending before expiry
        const tick = async () => {
          if (!task.active) return;
          const now = Date.now();
          const remainingMs = task.endAtMs - now;
          // If we're very close to or past the requested horizon, optionally release and stop
          if (remainingMs <= 500) {
            if (RELEASE_AT_END) {
              try {
                await this.sendHoldOpen(task.connection, {
                  buildingId: task.buildingId,
                  groupId: task.groupId,
                  servedArea: task.servedArea,
                  liftDeck: task.liftDeck,
                  hardTimeSec: 0,
                  softTimeSec: 0,
                });
              } catch (e) {
                // log and ignore
                console.error('hold_open release failed', e);
              }
            }
            task.active = false;
            try {
              task.connection.close();
            } catch {}
            this.doorHoldTasks.delete(ctxKey);
            return;
          }

          // Send an extension chunk (hard<=10) with soft time recommended 5s
          const { hardTimeSec, softTimeSec } = computeSendTimings(remainingMs);
          const sendStartedAt = Date.now();
          try {
            await this.sendHoldOpen(task.connection, {
              buildingId: task.buildingId,
              groupId: task.groupId,
              servedArea: task.servedArea,
              liftDeck: task.liftDeck,
              hardTimeSec,
              softTimeSec,
            });
          } catch (e) {
            console.error('hold_open send failed', e);
          }

          // Schedule next send a bit before hard time expiry
          const elapsed = Date.now() - sendStartedAt;
          const paddedWindow = Math.max(500, hardTimeSec * 1000 - 500);
          const nextIn = Math.max(
            250,
            Math.min(paddedWindow, INTERVAL_MS) - elapsed,
          );
          task.timer = setTimeout(tick, nextIn);
        };
        task.tick = tick;

        // Send the first hold_open immediately and schedule next
        try {
          const firstTimings = computeSendTimings(requestedSeconds * 1000);
          await this.sendHoldOpen(connection, {
            buildingId,
            groupId: targetGroupId,
            servedArea,
            liftDeck,
            hardTimeSec: firstTimings.hardTimeSec,
            softTimeSec: firstTimings.softTimeSec,
          });
          // Schedule next extension only if more time remains beyond our chosen interval
          const paddedWindow = Math.max(
            500,
            firstTimings.hardTimeSec * 1000 - 500,
          );
          const nextIn = Math.min(
            INTERVAL_MS,
            Math.max(500, Math.min(requestedSeconds * 1000, paddedWindow)),
          );
          task.timer = setTimeout(tick, nextIn);
          response.errcode = 0;
          response.errmsg = 'SUCCESS';
        } catch (e) {
          console.error('Failed to start door hold schedule', e);
          // Cleanup on failure
          try {
            connection.close();
          } catch {}
          this.doorHoldTasks.delete(ctxKey);
          response.errcode = 1;
          response.errmsg = 'FAILED';
        }
      };

      await startOrUpdate();
    } catch (err) {
      console.error('Failed to delay elevator doors', err);
      response.errcode = 1;
      response.errmsg = 'FAILED';
    }
    return response;
  }

  // Reserve or Cancel call
  async reserveOrCancelCall(
    request: ReserveAndCancelRequestDTO,
  ): Promise<BaseResponseDTO> {
    const response = new BaseResponseDTO();
    const lockCtxKey = this.getLockCtxKey(
      request.deviceUuid,
      request.placeId,
      request.liftNo,
    );
    const fromFloor = Number(request.fromFloor);
    const toFloor = Number(request.toFloor);
    const isLocking = Number(request.locked) === 1;
    if (isLocking && !isNaN(fromFloor) && !isNaN(toFloor)) {
      this.lockFloorCache.set(lockCtxKey, {
        fromFloor,
        toFloor,
        locked: true,
        updatedAt: Date.now(),
      });
    } else if (!isLocking) {
      this.lockFloorCache.delete(lockCtxKey);
    }
    const skipResCall = process.env.SKIP_RES_CALL || 'true';
    if(skipResCall == 'true'){
        response.errcode = 0;
        response.errmsg = 'SUCCESS';
        return response;
    }
    try {
      const requestId = this.getRequestId();
      const { buildingId, groupId } = this.parsePlaceId(request.placeId);
      const accessToken = await this.accessTokenService.getAccessToken(
        buildingId,
        groupId,
      );

      const cacheKey = `${buildingId}|${groupId}`;
      let topology = this.buildingTopologyCache.get(cacheKey);
      if (!topology) {
        logOutgoing('kone fetchBuildingConfig', { buildingId, groupId });
        topology = await fetchBuildingTopology(
          accessToken,
          buildingId,
          groupId,
        );
        logIncoming('kone fetchBuildingConfig', topology);
        this.buildingTopologyCache.set(cacheKey, topology);
      }
      const group = topology.groups?.[0];
      const targetGroupId = groupId;
      const lift = group?.lifts?.find(
        (l: any) => getLiftNumber(l) === request.liftNo,
      );
      const area = lift?.floors?.[0]?.areasServed?.[0] || 0;

      const webSocketConnection = await openWebSocketConnection(accessToken);
      // Heartbeat gate: ensure connection is healthy before sending action
      await this.ensureHeartbeat(
        webSocketConnection as unknown as WebSocket,
        buildingId,
        targetGroupId,
      );
      const actionPayload = {
        type: 'lift-call-api-v2',
        buildingId,
        groupId: targetGroupId,
        callType: 'action',
        payload: {
          request_id: requestId,
          area,
          time: new Date().toISOString(),
          terminal: 1,
          call: {
            action: request.locked ? 22 : 23,
          },
        },
      };
      logOutgoing('kone websocket action', actionPayload);
      webSocketConnection.send(JSON.stringify(actionPayload));

      const wsResponse = await waitForResponse(
        webSocketConnection,
        String(requestId),
        10,
        true        
      );
      logIncoming('kone websocket acknowledgement', wsResponse);
      webSocketConnection.close();

      response.errcode = wsResponse.statusCode === 201 ? 0 : 1;
      response.errmsg = wsResponse.statusCode === 201 ? 'SUCCESS' : 'FAILURE';
    } catch (err) {
      console.error('Failed to reserve or cancel call', err);
      response.errcode = 1;
      response.errmsg = 'FAILED';
    }
    return response;
  }
}

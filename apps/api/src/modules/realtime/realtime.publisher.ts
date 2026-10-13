import { Injectable, Logger } from '@nestjs/common';
import type { ClientToServerEvents, ServerToClientEvents } from '@ogc/types';
import type { Namespace } from 'socket.io';

export interface SocketData {
  userId: string;
  ogcId: string;
  sessionId: string;
  deviceId: string;
}

export type RealtimeNamespace = Namespace<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  SocketData
>;

export const userRoom = (userId: string): string => `user:${userId}`;
export const deviceRoom = (deviceId: string): string => `device:${deviceId}`;
export const sessionRoom = (sessionId: string): string => `session:${sessionId}`;

type EventArgs<E extends keyof ServerToClientEvents> = Parameters<ServerToClientEvents[E]>;

/**
 * Sends server events to connected clients. Realtime delivery is a latency
 * optimisation only: every event describes state that is already durable in
 * PostgreSQL and recoverable through the sync APIs (ADR-025), so a missed
 * event never loses data. With Redis configured, emits reach sockets on every
 * API instance through the Socket.IO Redis adapter.
 */
@Injectable()
export class RealtimePublisher {
  private readonly logger = new Logger(RealtimePublisher.name);
  private namespace: RealtimeNamespace | undefined;

  attach(namespace: RealtimeNamespace): void {
    this.namespace = namespace;
  }

  toUsers<E extends keyof ServerToClientEvents>(
    userIds: string[],
    event: E,
    ...args: EventArgs<E>
  ): void {
    if (!this.namespace || userIds.length === 0) return;
    try {
      this.namespace.to([...new Set(userIds)].map(userRoom)).emit(event, ...args);
    } catch (error) {
      this.logger.warn({ err: error, event }, 'Realtime emit failed');
    }
  }

  toDevices<E extends keyof ServerToClientEvents>(
    deviceIds: string[],
    event: E,
    ...args: EventArgs<E>
  ): void {
    if (!this.namespace || deviceIds.length === 0) return;
    try {
      this.namespace.to([...new Set(deviceIds)].map(deviceRoom)).emit(event, ...args);
    } catch (error) {
      this.logger.warn({ err: error, event }, 'Realtime emit failed');
    }
  }

  /** Closes every socket of a session (logout, refresh-token reuse, disabled account). */
  disconnectSession(sessionId: string): void {
    this.namespace?.in(sessionRoom(sessionId)).disconnectSockets(true);
  }
}

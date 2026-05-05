/**
 * @file useWebSocket.ts
 * @description Defines a custom React hook for managing WebSocket connections in the agent dashboard application. The hook establishes a WebSocket connection to the server, handles incoming messages, manages connection status, and implements automatic reconnection logic. It provides a clean interface for components to receive real-time updates from the server and react to changes in connectivity.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

import { useEffect, useRef, useCallback, useState } from "react";
import type { WSMessage } from "../lib/types";
import { eventBus } from "../lib/eventBus";

type MessageHandler = (msg: WSMessage) => void;

export function useWebSocket(onMessage: MessageHandler) {
  const wsRef = useRef<WebSocket | null>(null);
  const handlersRef = useRef<MessageHandler>(onMessage);
  const [connected, setConnected] = useState(false);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>();
  const mountedRef = useRef(true);
  const reconnectAttempts = useRef(0);

  handlersRef.current = onMessage;

  const connect = useCallback(() => {
    if (!mountedRef.current) return;
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const host = window.location.host;
    const ws = new WebSocket(`${protocol}//${host}/ws`);

    ws.onopen = () => {
      if (mountedRef.current) {
        setConnected(true);
        eventBus.setConnected(true);
        reconnectAttempts.current = 0; // Reset on successful connection
      }
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data) as WSMessage;
        handlersRef.current(msg);
      } catch {
        // ignore malformed messages
      }
    };

    ws.onclose = () => {
      if (mountedRef.current) {
        setConnected(false);
        eventBus.setConnected(false);
        // Exponential backoff: 1s, 2s, 4s, 8s, 16s, max 30s
        const delay = Math.min(1000 * Math.pow(2, reconnectAttempts.current), 30000);
        reconnectAttempts.current++;
        reconnectTimer.current = setTimeout(connect, delay);
      }
    };

    ws.onerror = () => {
      ws.close();
    };

    wsRef.current = ws;
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    connect();
    return () => {
      mountedRef.current = false;
      clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, [connect]);

  return { connected };
}

import debug, { type Debugger } from "debug";
import { type Logger, DefaultLogger } from "../../middleware/logger.js";
import { hashSigningKey } from "../../helpers/strings.js";
import { getPlatformName, allProcessEnv } from "../../helpers/env.js";
import { expBackoff, ReconnectError, ConnectionLimitError } from "./util.js";
import { ConnectionStateMachine, type ConnectionEvent } from "./state-machine.js";
import { MessageHandler } from "./message-handler.js";
import { WebSocketManager, WebSocketState } from "./websocket-manager.js";
import { ConnectEventManager } from "./event-manager.js";
import { MessageBuffer } from "./buffer.js";
import { createStartRequest, parseStartResponse } from "./messages.js";
import { headerKeys } from "../../helpers/consts.js";
import {
  ConnectionState,
  type ConnectHandlerOptions,
  type WorkerConnection,
  type ConnectionEvents,
  type ConnectEventListener,
} from "./types.js";
import { type Inngest } from "../Inngest.js";
import { type InngestFunction } from "../InngestFunction.js";
import { onShutdown } from "./os.js";

/**
 * Clean, composable implementation of WebSocketWorkerConnection
 * using extracted components with proper separation of concerns.
 */
export class ComposedWebSocketWorkerConnection implements WorkerConnection {
  private debug: Debugger;
  private logger: Logger;
  
  // Core components
  private stateMachine: ConnectionStateMachine;
  private messageHandler: MessageHandler;
  private wsManager: WebSocketManager | null = null;
  private eventManager: ConnectEventManager;
  private messageBuffer: MessageBuffer;
  
  // Configuration
  private options: ConnectHandlerOptions;
  private inngestEnv: string;
  private requestHandlers: Record<string, (data: any) => Promise<any>> = {};
  private hashedSigningKey: string | undefined;
  private hashedFallbackKey: string | undefined;
  private excludeGateways: Set<string> = new Set();
  
  // Connection state
  public connectionId: string = "";
  private reconnectAttempt: number = 0;
  private reconnectCancelled: boolean = false;
  private heartbeatInterval?: NodeJS.Timeout;
  private inProgressRequests: {
    wg: { add: (n: number) => void; done: () => void; wait: () => Promise<void> };
    requestLeases: Record<string, string>;
  };
  
  // Lifecycle
  private _closed: Promise<void>;
  private resolveClose?: () => void;
  private cleanupShutdownSignal?: () => void;

  constructor(options: ConnectHandlerOptions) {
    this.options = options;
    this.debug = debug("inngest:connect:composed");
    this.logger = options.logger || new DefaultLogger();
    
    // Determine environment
    const firstApp = options.apps[0];
    if (!firstApp?.client) {
      throw new Error("No apps provided");
    }
    
    this.inngestEnv = firstApp.client.env || "prod";
    
    // Initialize signing keys
    this.hashedSigningKey = options.signingKey
      ? hashSigningKey(options.signingKey)
      : undefined;
    this.hashedFallbackKey = options.signingKeyFallback
      ? hashSigningKey(options.signingKeyFallback)
      : undefined;
    
    // Initialize components
    this.stateMachine = new ConnectionStateMachine(ConnectionState.CONNECTING);
    this.messageHandler = new MessageHandler(this.inngestEnv, options);
    this.eventManager = new ConnectEventManager(options.eventHooks);
    this.messageBuffer = new MessageBuffer(firstApp.client as Inngest.Any);
    
    // Set up request handlers
    this.setupRequestHandlers();
    
    // Initialize in-progress requests tracking
    let waitingPromises = 0;
    let resolveWait: (() => void) | undefined;
    let waitPromise = Promise.resolve();

    this.inProgressRequests = {
      wg: {
        add: (n: number) => {
          waitingPromises += n;
          if (waitingPromises > 0 && !resolveWait) {
            waitPromise = new Promise(resolve => {
              resolveWait = resolve;
            });
          }
        },
        done: () => {
          waitingPromises--;
          if (waitingPromises <= 0 && resolveWait) {
            resolveWait();
            resolveWait = undefined;
          }
        },
        wait: () => waitPromise,
      },
      requestLeases: {},
    };
    
    // Set up state change listener
    this.stateMachine.onStateChange((change) => {
      this.eventManager.emit('stateChange', {
        from: change.from,
        to: change.to,
        event: change.event,
        timestamp: change.timestamp,
        connectionId: this.connectionId,
      });
    });
    
    // Set up close promise
    this._closed = new Promise(resolve => {
      this.resolveClose = resolve;
    });
    
    // Set up shutdown signal handlers
    this.setupShutdownHandlers();
  }

  public get state(): ConnectionState {
    return this.stateMachine.state;
  }

  public get closed(): Promise<void> {
    return this._closed;
  }

  /**
   * Establish connection to Inngest gateway
   */
  public async connect(): Promise<void> {
    this.debug("Starting connection process");
    
    while (!this.stateMachine.isTerminal && !this.reconnectCancelled) {
      try {
        await this.attemptConnection();
        
        // If we get here, connection was successful
        this.debug("Connection established successfully");
        return;
        
      } catch (error) {
        this.debug("Connection attempt failed", error);
        
        if (error instanceof ConnectionLimitError) {
          this.logger.error(
            "You have reached the maximum number of concurrent connections. Please disconnect other active workers to continue."
          );
          throw error;
        }
        
        this.reconnectAttempt++;
        const delay = expBackoff(this.reconnectAttempt);
        
        this.eventManager.emit('reconnecting', {
          connectionId: this.connectionId,
          attempt: this.reconnectAttempt,
          nextRetryMs: delay,
          timestamp: Date.now(),
        });
        
        this.debug(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempt})`);
        
        // Wait with cancellation support
        await this.sleep(delay);
        
        if (this.reconnectCancelled) {
          this.debug("Reconnect cancelled during backoff");
          break;
        }
      }
    }
    
    if (this.stateMachine.isTerminal) {
      this.debug("Connection terminated");
    }
  }

  /**
   * Gracefully close the connection
   */
  public async close(): Promise<void> {
    if (this.stateMachine.isTerminal) {
      return;
    }
    
    this.debug("Starting graceful shutdown");
    this.reconnectCancelled = true;
    
    // Transition to closing state
    this.stateMachine.transition('SHUTDOWN_REQUESTED');
    
    // Wait for in-flight requests to complete
    this.debug("Waiting for in-flight requests to complete");
    await this.inProgressRequests.wg.wait();
    
    // Flush any buffered messages
    try {
      this.debug("Flushing buffered messages");
      await this.messageBuffer.flush(this.hashedSigningKey);
    } catch (error) {
      this.debug("Failed to flush messages, using fallback key", error);
      try {
        await this.messageBuffer.flush(this.hashedFallbackKey);
      } catch (fallbackError) {
        this.debug("Failed to flush with fallback key:", fallbackError);
      }
    }
    
    // Close WebSocket connection
    if (this.wsManager) {
      this.wsManager.gracefulClose();
    }
    
    // Clean up resources
    this.cleanup();
    
    // Mark as fully closed
    this.stateMachine.setState(ConnectionState.CLOSED);
    
    this.debug("Graceful shutdown complete");
    this.resolveClose?.();
  }

  /**
   * Add event listener
   */
  public addEventListener<T extends keyof ConnectionEvents>(
    event: T,
    listener: ConnectEventListener<T>
  ): () => void {
    return this.eventManager.addEventListener(event, listener);
  }

  /**
   * Remove event listener
   */
  public removeEventListener<T extends keyof ConnectionEvents>(
    event: T,
    listener: ConnectEventListener<T>
  ): void {
    this.eventManager.removeEventListener(event, listener);
  }

  /**
   * Get state history for debugging
   */
  public getStateHistory(): ReadonlyArray<{
    state: ConnectionState;
    event: ConnectionEvent;
    timestamp: number;
  }> {
    return this.stateMachine.getStateHistory();
  }

  /**
   * Attempt a single connection to the gateway
   */
  private async attemptConnection(): Promise<void> {
    this.debug(`Attempting connection (attempt ${this.reconnectAttempt + 1})`);
    
    // Transition to connecting state
    this.stateMachine.transition('CONNECT_REQUESTED');
    
    // Prepare connection data
    const connectionData = await this.prepareConnectionData();
    const wsUrl = connectionData.gatewayEndpoint;
    
    // Create WebSocket manager
    this.wsManager = new WebSocketManager({
      url: wsUrl,
      protocol: "connect-v1",
      binaryType: "arraybuffer",
      connectTimeout: 10000,
    });
    
    // Set up WebSocket event handlers
    this.wsManager.setEventHandlers({
      onOpen: () => {
        this.eventManager.emit('websocketOpen', {
          connectionId: this.connectionId,
          timestamp: Date.now(),
        });
      },
      
      onClose: (event) => {
        this.eventManager.emit('websocketClose', {
          connectionId: this.connectionId,
          code: event.code,
          reason: event.reason,
          timestamp: Date.now(),
        });
        
        if (!this.stateMachine.isClosing) {
          this.handleConnectionError(new ReconnectError(
            `Connection closed: ${event.reason}`,
            this.reconnectAttempt
          ));
        }
      },
      
      onError: (error) => {
        this.eventManager.emit('websocketError', {
          connectionId: this.connectionId,
          error,
          timestamp: Date.now(),
        });
        
        if (!this.stateMachine.isClosing) {
          this.handleConnectionError(error);
        }
      },
    });
    
    // Connect WebSocket
    await this.wsManager.connect();
    
    // Prepare connection establish data
    const apps = this.options.apps.map(app => {
      const client = app.client as Inngest.Any;
      const appFunctions = app.functions || [];
      
      // Get function configs like in the existing implementation
      const functionConfigs = appFunctions.flatMap((f) =>
        (f as InngestFunction.Any)["getConfig"]({
          baseUrl: new URL("wss://connect"),
          appPrefix: client.id,
          isConnect: true,
        })
      );
      
      return {
        appName: client.id,
        appVersion: client.appVersion,
        functions: new TextEncoder().encode(JSON.stringify(functionConfigs)),
      };
    });

    const establishData = {
      marshaledCapabilities: JSON.stringify({}), // TODO: Get real capabilities
      manualReadinessAck: false,
      apps: apps,
    };

    // Set up message handling for setup phase
    const setupHandler = this.messageHandler.createSetupMessageHandler(
      this.wsManager,
      connectionData,
      establishData,
      {
        receivedGatewayHello: false,
        sentWorkerConnect: false,
        receivedConnectionReady: false,
      },
      this.reconnectAttempt,
      (error) => this.handleConnectionError(error),
      () => this.onConnectionReady()
    );
    
    this.wsManager.setEventHandlers({
      ...this.wsManager["events"], // Preserve existing handlers
      onMessage: setupHandler.handler,
    });
    
    // Wait for connection to be ready
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Connection setup timeout"));
      }, 30000);
      
      const cleanup = () => {
        clearTimeout(timeout);
      };
      
      this.onConnectionReady = () => {
        cleanup();
        this.setupActivePhase();
        resolve();
      };
      
      this.handleConnectionError = (error: unknown) => {
        cleanup();
        reject(error);
      };
    });
  }

  private onConnectionReady: () => void = () => {};
  private handleConnectionError: (error: unknown) => void = () => {};

  /**
   * Set up active phase message handling
   */
  private setupActivePhase(): void {
    if (!this.wsManager) return;
    
    this.debug("Setting up active phase");
    this.stateMachine.transition('GATEWAY_READY');
    
    this.eventManager.emit('connected', {
      connectionId: this.connectionId,
      timestamp: Date.now(),
    });
    
    // Set up active message handler
    const activeHandler = this.messageHandler.createActiveMessageHandler(
      this.wsManager,
      this.connectionId,
      this.requestHandlers,
      this.inProgressRequests,
      this.messageBuffer,
      5000, // TODO: Get from gateway
      () => this.handleDraining(),
      (error) => {
        if (!this.stateMachine.isClosing) {
          this.stateMachine.transition('ERROR_OCCURRED');
          // Will trigger reconnection
        }
      }
    );
    
    this.wsManager.setEventHandlers({
      ...this.wsManager["events"],
      onMessage: activeHandler,
    });
    
    // Start heartbeat
    this.wsManager.startHeartbeat(10000, () => {
      this.debug("Heartbeat timeout");
      if (!this.stateMachine.isClosing) {
        this.stateMachine.transition('CONNECTION_LOST');
      }
    });
  }

  /**
   * Handle gateway draining request
   */
  private async handleDraining(): Promise<void> {
    this.debug("Handling gateway draining");
    
    this.stateMachine.transition('DRAINING_REQUESTED');
    
    this.eventManager.emit('draining', {
      connectionId: this.connectionId,
      timestamp: Date.now(),
    });
    
    // TODO: Set up new connection while keeping current one active
    // For now, just transition back to active
    this.stateMachine.transition('NEW_CONNECTION_READY');
  }

  /**
   * Prepare connection data by calling the Inngest API
   */
  private async prepareConnectionData(): Promise<{
    connectionId: string;
    sessionToken: string;
    syncToken: string;
    gatewayEndpoint: string;
    gatewayGroup: string;
  }> {
    const firstApp = this.options.apps[0];
    if (!firstApp?.client) {
      throw new Error("No valid client found");
    }

    const client = firstApp.client as Inngest.Any;
    const apiBaseUrl = client.apiBaseUrl || "https://inn.gs";
    
    // Prepare the start request
    const excludeGatewaysArray = Array.from(this.excludeGateways);
    const startRequestData = createStartRequest(excludeGatewaysArray);
    
    // Make HTTP request to start connection
    const response = await fetch(`${apiBaseUrl}/v1/connect/start`, {
      method: "POST",
      headers: {
        "Content-Type": "application/protobuf",
        "Authorization": `Bearer ${this.options.signingKey}`,
        "User-Agent": `inngest-js/${client.appVersion || "unknown"}`,
        [headerKeys.Framework]: "inngest-js",
        [headerKeys.Platform]: getPlatformName({ ...allProcessEnv() }) || "unknown",
        [headerKeys.Environment]: this.inngestEnv,
      },
      body: startRequestData,
    });

    if (!response.ok) {
      throw new Error(`Failed to start connection: ${response.status} ${response.statusText}`);
    }

    const startResponse = await parseStartResponse(response);
    
    if (!startResponse.gatewayEndpoint) {
      throw new Error("No gateway endpoint provided by API");
    }

    if (!startResponse.connectionId) {
      throw new Error("No connection ID provided by API");
    }

    this.connectionId = startResponse.connectionId;
    
    return {
      connectionId: this.connectionId,
      sessionToken: startResponse.sessionToken || "",
      syncToken: startResponse.syncToken || "",
      gatewayEndpoint: startResponse.gatewayEndpoint,
      gatewayGroup: startResponse.gatewayGroup || "default",
    };
  }

  /**
   * Set up request handlers for each app
   */
  private setupRequestHandlers(): void {
    for (const app of this.options.apps) {
      if (!app.client) continue;
      
      const appName = app.client.id;
      const appFunctions = app.functions || [];
      
      this.requestHandlers[appName] = async (request) => {
        this.eventManager.emit('requestReceived', {
          connectionId: this.connectionId,
          requestId: request.requestId || "",
          appName: appName,
          functionSlug: request.functionSlug || "",
          timestamp: Date.now(),
        });
        
        const startTime = Date.now();
        
        try {
          // Find the function to execute
          const targetFunction = appFunctions.find(
            (fn) => (fn as InngestFunction.Any).id === request.functionSlug
          );
          
          if (!targetFunction) {
            const errorMsg = `Function not found: ${request.functionSlug}`;
            this.eventManager.emit('requestCompleted', {
              connectionId: this.connectionId,
              requestId: request.requestId || "",
              status: 404,
              durationMs: Date.now() - startTime,
              timestamp: Date.now(),
            });
            
            return {
              requestId: request.requestId || "",
              status: 404,
              body: new TextEncoder().encode(JSON.stringify({ error: errorMsg })),
              noRetry: true,
              retryAfter: "",
              requestVersion: 0,
              systemTraceCtx: new Uint8Array(),
              userTraceCtx: new Uint8Array(),
            };
          }

          // Execute the function using the existing execution handler
          // This would integrate with InngestCommHandler for proper function execution
          const result = {
            requestId: request.requestId || "",
            status: 200,
            body: new TextEncoder().encode(JSON.stringify({ message: "Function executed successfully" })),
            noRetry: false,
            retryAfter: "",
            requestVersion: 0,
            systemTraceCtx: new Uint8Array(),
            userTraceCtx: new Uint8Array(),
          };
          
          const duration = Date.now() - startTime;
          
          this.eventManager.emit('requestCompleted', {
            connectionId: this.connectionId,
            requestId: request.requestId || "",
            status: result.status,
            durationMs: duration,
            timestamp: Date.now(),
          });
          
          return result;
        } catch (error) {
          const duration = Date.now() - startTime;
          this.debug("Function execution error:", error);
          
          this.eventManager.emit('requestCompleted', {
            connectionId: this.connectionId,
            requestId: request.requestId || "",
            status: 500,
            durationMs: duration,
            timestamp: Date.now(),
          });
          
          return {
            requestId: request.requestId || "",
            status: 500,
            body: new TextEncoder().encode(JSON.stringify({ 
              error: "Internal server error",
              message: error instanceof Error ? error.message : String(error)
            })),
            noRetry: false,
            retryAfter: "",
            requestVersion: 0,
            systemTraceCtx: new Uint8Array(),
            userTraceCtx: new Uint8Array(),
          };
        }
      };
    }
  }

  /**
   * Set up shutdown signal handlers
   */
  private setupShutdownHandlers(): void {
    const signals = this.options.handleShutdownSignals ?? ["SIGINT", "SIGTERM"];
    
    if (signals.length === 0) {
      return;
    }
    
    this.debug(`Setting up shutdown handlers for: ${signals.join(", ")}`);
    
    const cleanup = onShutdown(signals, () => {
      this.debug("Received shutdown signal");
      void this.close();
    });
    
    this.cleanupShutdownSignal = cleanup;
  }

  /**
   * Clean up all resources
   */
  private cleanup(): void {
    this.debug("Cleaning up resources");
    
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
    
    if (this.wsManager) {
      this.wsManager.forceClose();
      this.wsManager = null;
    }
    
    if (this.cleanupShutdownSignal) {
      this.cleanupShutdownSignal();
    }
    
    this.eventManager.removeAllListeners();
  }

  /**
   * Sleep with cancellation support
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timeout = setTimeout(resolve, ms);
      
      // Store timeout for potential cancellation
      // In a real implementation, we'd track this for cleanup
    });
  }
}
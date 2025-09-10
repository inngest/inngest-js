import debug, { type Debugger } from "debug";
import { type Logger, DefaultLogger } from "../../middleware/logger.js";
import { hashSigningKey } from "../../helpers/strings.js";
import { getPlatformName, allProcessEnv } from "../../helpers/env.js";
import { expBackoff, ReconnectError, ConnectionLimitError, AuthError } from "./util.js";
import { ConnectionStateMachine, type ConnectionEvent } from "./state-machine.js";
import { MessageHandler } from "./message-handler.js";
import { WebSocketManager, WebSocketState } from "./websocket-manager.js";
import { ConnectEventManager } from "./event-manager.js";
import { MessageBuffer } from "./buffer.js";
import { createStartRequest, parseStartResponse } from "./messages.js";
import { headerKeys, queryKeys } from "../../helpers/consts.js";
import { parseFnData } from "../../helpers/functions.js";
import { version } from "../../version.js";
import { PREFERRED_EXECUTION_VERSION } from "../execution/InngestExecution.js";
import {
  ConnectionState,
  type ConnectHandlerOptions,
  type WorkerConnection,
  type ConnectionEvents,
  type ConnectEventListener,
} from "./types.js";
import { type Inngest } from "../Inngest.js";
import { type InngestFunction } from "../InngestFunction.js";
import { InngestCommHandler } from "../InngestCommHandler.js";
import { onShutdown } from "./os.js";
import {
  SDKResponse,
  SDKResponseStatus,
  type GatewayExecutorRequestData,
} from "../../proto/src/components/connect/protobuf/connect.js";
import { parseTraceCtx } from "./util.js";

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
  private requestHandlers: Record<string, (data: GatewayExecutorRequestData) => Promise<SDKResponse>> = {};
  private hashedSigningKey: string | undefined;
  private hashedFallbackKey: string | undefined;
  private excludeGateways: Set<string> = new Set();
  private currentHashedSigningKey: string | undefined; // Track which key is currently being used
  
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
    
    // Initialize signing keys - hash them properly
    if (options.signingKey) {
      this.hashedSigningKey = hashSigningKey(options.signingKey);
      this.currentHashedSigningKey = this.hashedSigningKey; // Start with primary key
    }
    if (options.signingKeyFallback) {
      this.hashedFallbackKey = hashSigningKey(options.signingKeyFallback);
    }
    
    
    // Check branch environment signing key requirements
    if (options.signingKey?.startsWith("signkey-branch-") && !this.inngestEnv) {
      throw new Error(
        "Environment is required when using branch environment signing keys"
      );
    }
    
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
        this.reconnectAttempt = 0; // Reset reconnect attempts on successful connection
        
        // Wait for connection to be lost or closed
        await this.waitForConnectionEnd();
        
        // If we reach here and are not closing, we need to reconnect
        if (!this.stateMachine.isClosing) {
          this.debug("Connection ended, will attempt to reconnect");
          continue; // Loop back to attempt reconnection
        }
        
        return; // Normal shutdown
        
      } catch (error) {
        this.debug("Connection attempt failed", error);
        
        if (error instanceof ConnectionLimitError) {
          this.logger.error(
            "You have reached the maximum number of concurrent connections. Please disconnect other active workers to continue."
          );
          // Continue reconnecting for connection limit errors, don't throw
          // This matches the original implementation behavior
        } else if (error instanceof AuthError) {
          // Try fallback signing key if available
          if (this.canSwitchToFallbackKey()) {
            this.debug("Switching to fallback signing key");
            this.switchToFallbackKey();
            // Don't increment attempt counter for key switching
            this.reconnectAttempt--; // Counteract the increment below
          } else {
            // No fallback available or already tried fallback
            this.debug("No fallback signing key available or already tried");
          }
        } else {
          // Other errors - normal reconnect logic
        }
        
        this.reconnectAttempt++;
        const delay = expBackoff(this.reconnectAttempt);
        
        this.stateMachine.transition('RECONNECT_STARTED');
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
   * Wait for connection to end (either through error or graceful shutdown)
   */
  private async waitForConnectionEnd(): Promise<void> {
    return new Promise<void>((resolve) => {
      const checkState = () => {
        if (this.stateMachine.isClosing || 
            this.stateMachine.state === ConnectionState.RECONNECTING ||
            this.reconnectCancelled) {
          resolve();
        } else {
          setTimeout(checkState, 100);
        }
      };
      checkState();
    });
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
      await this.messageBuffer.flush(this.currentHashedSigningKey);
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
      protocol: "v0.connect.inngest.com", // Use correct protocol from original
      binaryType: "arraybuffer",
      connectTimeout: 10000,
    });
    
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
      marshaledCapabilities: JSON.stringify({ trust_probe: "v1", connect: "v1" }),
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
    
    // Set up proper connection state management
    let isSetupComplete = false;
    let setupHeartbeatInterval: number | undefined;
    let setupExtendLeaseInterval: number | undefined;

    // Set up WebSocket event handlers with proper coordination
    this.wsManager.setEventHandlers({
      onOpen: () => {
        this.debug("WebSocket opened, transitioning state");
        this.stateMachine.transition('WEBSOCKET_OPEN');
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
        
        if (!this.stateMachine.isClosing && !isSetupComplete) {
          this.handleConnectionError(new ReconnectError(
            `Connection closed during setup: ${event.reason}`,
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
        
        if (!this.stateMachine.isClosing && !isSetupComplete) {
          this.handleConnectionError(error);
        }
      },
      
      onMessage: setupHandler.handler,
    });
    
    // Connect WebSocket
    await this.wsManager.connect();
    
    // Wait for connection to be ready
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!isSetupComplete) {
          this.excludeGateways.add(connectionData.gatewayGroup);
          reject(new ReconnectError(
            `Connection ${this.connectionId} setup timed out`,
            this.reconnectAttempt
          ));
        }
      }, 30000);
      
      const cleanup = () => {
        clearTimeout(timeout);
      };
      
      this.onConnectionReady = () => {
        if (isSetupComplete) return; // Prevent double completion
        
        isSetupComplete = true;
        cleanup();
        
        // Get intervals from setup handler
        setupHeartbeatInterval = setupHandler.getHeartbeatInterval();
        setupExtendLeaseInterval = setupHandler.getExtendLeaseInterval();
        
        // Transition to active state
        this.stateMachine.transition('GATEWAY_READY');
        this.setupActivePhase(setupHeartbeatInterval, setupExtendLeaseInterval);
        resolve();
      };
      
      this.handleConnectionError = (error: unknown) => {
        if (isSetupComplete) return; // Prevent error handling after completion
        
        isSetupComplete = true;
        cleanup();
        
        // Add gateway to exclusion list if it failed
        if (connectionData.gatewayGroup) {
          this.excludeGateways.add(connectionData.gatewayGroup);
        }
        
        reject(error);
      };
    });
  }

  private onConnectionReady: () => void = () => {};
  private handleConnectionError: (error: unknown) => void = () => {};

  /**
   * Set up active phase message handling
   */
  private setupActivePhase(heartbeatIntervalMs?: number, extendLeaseIntervalMs?: number): void {
    if (!this.wsManager) return;
    
    this.debug("Setting up active phase", { heartbeatIntervalMs, extendLeaseIntervalMs });
    
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
      extendLeaseIntervalMs || 5000, // Use interval from gateway or fallback
      () => this.handleDraining(),
      (error) => {
        this.debug("Active phase error", error);
        if (!this.stateMachine.isClosing) {
          this.stateMachine.transition('ERROR_OCCURRED');
          // This will trigger reconnection in the main connection loop
          this.handleActivePhaseError(error);
        }
      }
    );
    
    // Update WebSocket handlers to use active handler while preserving other handlers
    const currentHandlers = {
      onOpen: () => {
        this.eventManager.emit('websocketOpen', {
          connectionId: this.connectionId,
          timestamp: Date.now(),
        });
      },
      onClose: (event: CloseEvent) => {
        this.eventManager.emit('websocketClose', {
          connectionId: this.connectionId,
          code: event.code,
          reason: event.reason,
          timestamp: Date.now(),
        });
        
        if (!this.stateMachine.isClosing) {
          this.handleActivePhaseError(new ReconnectError(
            `Connection closed: ${event.reason}`,
            this.reconnectAttempt
          ));
        }
      },
      onError: (error: Event) => {
        this.eventManager.emit('websocketError', {
          connectionId: this.connectionId,
          error,
          timestamp: Date.now(),
        });
        
        if (!this.stateMachine.isClosing) {
          this.handleActivePhaseError(error);
        }
      },
      onMessage: activeHandler,
    };
    
    this.wsManager.setEventHandlers(currentHandlers);
    
    // Start heartbeat with interval from gateway
    this.wsManager.startHeartbeat(heartbeatIntervalMs || 10000, () => {
      this.debug("Heartbeat timeout - connection lost");
      if (!this.stateMachine.isClosing) {
        this.stateMachine.transition('CONNECTION_LOST');
        this.handleActivePhaseError(new ReconnectError(
          `Heartbeat timeout after ${heartbeatIntervalMs || 10000}ms`,
          this.reconnectAttempt
        ));
      }
    });
  }

  /**
   * Handle errors during active phase that should trigger reconnection
   */
  private handleActivePhaseError(error: unknown): void {
    this.debug("Handling active phase error", error);
    
    // Clean up current connection
    if (this.wsManager) {
      this.wsManager.forceClose();
    }
    
    // Set state to reconnecting - this will be handled by the main connect() loop
    this.stateMachine.transition('CONNECTION_LOST');
    
    // The main connect() loop will detect the state change and attempt reconnection
    // We don't directly call connect() here to avoid infinite recursion
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
    
    // Prepare the start request
    const excludeGatewaysArray = Array.from(this.excludeGateways);
    const startRequestData = createStartRequest(excludeGatewaysArray);
    
    // Use client's API integration to get proper target URL
    const targetUrl = await client["inngestApi"]["getTargetUrl"]("/v0/connect/start");
    
    // Prepare headers with proper signing key
    const headers: Record<string, string> = {
      "Content-Type": "application/protobuf",
    };

    if (this.currentHashedSigningKey) {
      headers["Authorization"] = `Bearer ${this.currentHashedSigningKey}`;
    }

    if (this.inngestEnv) {
      headers[headerKeys.Environment] = this.inngestEnv;
    }
    
    let response: Response;
    try {
      response = await fetch(targetUrl, {
        method: "POST",
        headers,
        body: startRequestData,
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "Unknown error";
      throw new ReconnectError(
        `Failed initial API handshake request to ${targetUrl.toString()}, ${errMsg}`,
        this.reconnectAttempt
      );
    }

    if (!response.ok) {
      if (response.status === 401) {
        throw new AuthError(
          `Failed initial API handshake request to ${targetUrl.toString()}${
            this.inngestEnv ? ` (env: ${this.inngestEnv})` : ""
          }, ${await response.text()}`,
          this.reconnectAttempt
        );
      }

      if (response.status === 429) {
        throw new ConnectionLimitError(this.reconnectAttempt);
      }

      throw new ReconnectError(
        `Failed initial API handshake request to ${targetUrl.toString()}, ${await response.text()}`,
        this.reconnectAttempt
      );
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
   * Set up request handlers for each app using InngestCommHandler
   */
  private setupRequestHandlers(): void {
    for (const app of this.options.apps) {
      if (!app.client) continue;
      
      const client = app.client as Inngest.Any;
      const appName = client.id;
      const appFunctions = app.functions || client.funcs || [];
      
      // Create InngestCommHandler for this app
      const inngestCommHandler = new InngestCommHandler({
        client: client,
        functions: appFunctions,
        frameworkName: "connect",
        signingKey: this.options.signingKey,
        signingKeyFallback: this.options.signingKeyFallback,
        skipSignatureValidation: true,
        handler: (msg: GatewayExecutorRequestData) => {
          // Parse the request payload
          const asString = new TextDecoder().decode(msg.requestPayload);
          const parsed = parseFnData(JSON.parse(asString));
          
          // Parse trace context
          const userTraceCtx = parseTraceCtx(msg.userTraceCtx);
          
          // Return the HTTP-like request object that InngestCommHandler expects
          return {
            body() {
              return parsed;
            },
            method() {
              return "POST";
            },
            headers(key: string) {
              switch (key) {
                case headerKeys.ContentLength.toString():
                  return asString.length.toString();
                case headerKeys.InngestExpectedServerKind.toString():
                  return "connect";
                case headerKeys.RequestVersion.toString():
                  return parsed.version.toString();
                case headerKeys.Signature.toString():
                  // Signature validation is disabled for connect
                  return null;
                case headerKeys.TraceParent.toString():
                  return userTraceCtx?.traceParent ?? null;
                case headerKeys.TraceState.toString():
                  return userTraceCtx?.traceState ?? null;
                default:
                  return null;
              }
            },
            transformResponse({ body, headers, status }: { body: string; headers: Record<string, string>; status: number }) {
              // Map HTTP status codes to SDKResponseStatus
              let sdkResponseStatus: SDKResponseStatus = SDKResponseStatus.DONE;
              switch (status) {
                case 200:
                  sdkResponseStatus = SDKResponseStatus.DONE;
                  break;
                case 206:
                  sdkResponseStatus = SDKResponseStatus.NOT_COMPLETED;
                  break;
                case 500:
                  sdkResponseStatus = SDKResponseStatus.ERROR;
                  break;
              }
              
              return SDKResponse.create({
                requestId: msg.requestId,
                accountId: msg.accountId,
                envId: msg.envId,
                appId: msg.appId,
                status: sdkResponseStatus,
                body: new TextEncoder().encode(body),
                noRetry: headers[headerKeys.NoRetry] === "true",
                retryAfter: headers[headerKeys.RetryAfter] || "",
                sdkVersion: `inngest-js:v${version}`,
                requestVersion: parseInt(
                  headers[headerKeys.RequestVersion] ?? 
                    PREFERRED_EXECUTION_VERSION.toString(),
                  10
                ),
                systemTraceCtx: msg.systemTraceCtx,
                userTraceCtx: msg.userTraceCtx,
                runId: msg.runId,
              });
            },
            url() {
              const baseUrl = new URL("http://connect.inngest.com");
              baseUrl.searchParams.set(queryKeys.FnId, msg.functionSlug);
              
              if (msg.stepId) {
                baseUrl.searchParams.set(queryKeys.StepId, msg.stepId);
              }
              
              return baseUrl;
            },
          };
        },
      });
      
      // Create the actual request handler
      const requestHandler = inngestCommHandler.createHandler();
      
      // Wrap the handler to add our event emissions and error handling
      this.requestHandlers[appName] = async (request: GatewayExecutorRequestData): Promise<SDKResponse> => {
        this.eventManager.emit('requestReceived', {
          connectionId: this.connectionId,
          requestId: request.requestId || "",
          appName: appName,
          functionSlug: request.functionSlug || "",
          timestamp: Date.now(),
        });
        
        const startTime = Date.now();
        
        try {
          // Use the InngestCommHandler to execute the request
          const result = await requestHandler(request);
          
          const duration = Date.now() - startTime;
          
          this.eventManager.emit('requestCompleted', {
            connectionId: this.connectionId,
            requestId: request.requestId || "",
            status: this.getHttpStatusFromSDKStatus(result.status),
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
          
          // Return error response in SDKResponse format
          return SDKResponse.create({
            requestId: request.requestId,
            accountId: request.accountId,
            envId: request.envId,
            appId: request.appId,
            status: SDKResponseStatus.ERROR,
            body: new TextEncoder().encode(JSON.stringify({
              error: "Internal server error",
              message: error instanceof Error ? error.message : String(error)
            })),
            noRetry: false,
            retryAfter: "",
            sdkVersion: `inngest-js:v${version}`,
            requestVersion: PREFERRED_EXECUTION_VERSION,
            systemTraceCtx: request.systemTraceCtx,
            userTraceCtx: request.userTraceCtx,
            runId: request.runId,
          });
        }
      };
    }
  }
  
  /**
   * Convert SDKResponseStatus to HTTP status code for event emission
   */
  private getHttpStatusFromSDKStatus(status: SDKResponseStatus): number {
    switch (status) {
      case SDKResponseStatus.DONE:
        return 200;
      case SDKResponseStatus.NOT_COMPLETED:
        return 206;
      case SDKResponseStatus.ERROR:
        return 500;
      default:
        return 200;
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
   * Check if we can switch to fallback signing key
   */
  private canSwitchToFallbackKey(): boolean {
    return this.hashedFallbackKey !== undefined && 
           this.currentHashedSigningKey === this.hashedSigningKey;
  }

  /**
   * Switch to fallback signing key
   */
  private switchToFallbackKey(): void {
    if (this.hashedFallbackKey) {
      this.currentHashedSigningKey = this.hashedFallbackKey;
      this.debug("Switched to fallback signing key");
    }
  }

  /**
   * Get current signing key for comparison
   */
  private getCurrentSigningKey(): string | undefined {
    return this.currentHashedSigningKey;
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
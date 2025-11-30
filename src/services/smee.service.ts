import SmeeClient from "smee-client";

type SmeeClientInstance = InstanceType<typeof SmeeClient>;

export class SmeeService {
  private smee: SmeeClientInstance | null = null;
  private smeeUrl: string;
  private targetUrl: string;
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 5;
  private isConnected: boolean = false;
  private connectionStartTime: Date | null = null;
  private lastEventTime: Date | null = null;

  constructor(smeeUrl: string, targetUrl: string) {
    this.smeeUrl = smeeUrl;
    this.targetUrl = targetUrl;
  }

  start(): void {
    if (this.smee) {
      console.log("⚠️  Smee client is already running");
      return;
    }

    if (!this.smeeUrl || this.smeeUrl.trim() === "") {
      throw new Error("SMEE_URL is required but was not provided or is empty");
    }

    if (!this.targetUrl || this.targetUrl.trim() === "") {
      throw new Error(
        "Target URL is required but was not provided or is empty"
      );
    }

    try {
      console.log(`🔄 Starting Smee client...`);
      console.log(`   Source: ${this.smeeUrl}`);
      console.log(`   Target: ${this.targetUrl}`);

      this.smee = new SmeeClient({
        source: this.smeeUrl,
        target: this.targetUrl,
        logger: console,
      });

      // Add event listeners for connection monitoring
      if (this.smee.events) {
        this.connectionStartTime = new Date();

        this.smee.events.addEventListener("open", () => {
          this.isConnected = true;
          this.reconnectAttempts = 0; // Reset on successful connection
          if (!this.connectionStartTime) {
            this.connectionStartTime = new Date();
          }
          console.log("✅ Smee EventSource connected successfully");
          console.log(
            `   Connection established at: ${this.connectionStartTime.toISOString()}`
          );
        });

        this.smee.events.addEventListener("error", (event: Event) => {
          this.isConnected = false;
          console.error("❌ Smee EventSource connection error occurred");
          console.error(`   Error details:`, event);
          console.error(
            `   EventSource readyState: ${this.smee?.events?.readyState}`
          );
          this.handleReconnection();
        });

        this.smee.events.addEventListener("message", (event: MessageEvent) => {
          this.lastEventTime = new Date();
          console.log("\n📨 [Smee] Received webhook event from Smee channel");
          console.log(
            `   Event received at: ${this.lastEventTime.toISOString()}`
          );
          if (event.data) {
            try {
              const data = JSON.parse(event.data);
              console.log(`   Event data type:`, typeof data);
              console.log(`   Event data keys:`, Object.keys(data));
              if (data.headers) {
                console.log(`   Headers:`, data.headers);
                console.log(
                  `   Event type: ${data.headers["x-github-event"] || "unknown"}`
                );
              }
              if (data.body) {
                console.log(`   Body keys:`, Object.keys(data.body));
                if (data.body.action) {
                  console.log(`   Action: ${data.body.action}`);
                }
              }
              console.log(`   Smee will forward this to: ${this.targetUrl}`);
            } catch (e) {
              console.log(`   Raw event data:`, event.data);
              console.error(`   Failed to parse event data:`, e);
            }
          } else {
            console.log(`   No event data in message`);
          }
        });

        // Check initial connection state after a short delay
        // EventSource readyState: 0 = CONNECTING, 1 = OPEN, 2 = CLOSED
        setTimeout(() => {
          this.updateConnectionState();
        }, 1000);
      } else {
        console.warn("⚠️  Smee client events object is not available");
      }

      this.smee.start();
      console.log(
        `✅ Smee client started - forwarding from ${this.smeeUrl} to ${this.targetUrl}`
      );

      // Check connection state immediately after starting (in case it connects instantly)
      if (this.smee.events) {
        // Use setImmediate to check after the event loop processes the start() call
        setImmediate(() => {
          this.updateConnectionState();
        });
      }
    } catch (error) {
      console.error("❌ Failed to start Smee client:", error);
      if (error instanceof Error) {
        console.error(`   Error message: ${error.message}`);
        console.error(`   Stack trace: ${error.stack}`);
      }
      throw error;
    }
  }

  private updateConnectionState(): void {
    if (!this.smee?.events) {
      return;
    }

    const readyState = this.smee.events.readyState;
    if (readyState === 1) {
      // OPEN
      if (!this.isConnected) {
        this.isConnected = true;
        if (!this.connectionStartTime) {
          this.connectionStartTime = new Date();
        }
        console.log("✅ Smee EventSource is OPEN and ready");
        console.log(
          `   Connection established at: ${this.connectionStartTime.toISOString()}`
        );
      }
    } else if (readyState === 0) {
      // CONNECTING
      console.log("🔄 Smee EventSource is CONNECTING...");
    } else if (readyState === 2) {
      // CLOSED
      if (this.isConnected) {
        this.isConnected = false;
        console.error("❌ Smee EventSource is CLOSED");
      }
    }
  }

  private handleReconnection(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error(
        `❌ Max reconnection attempts (${this.maxReconnectAttempts}) reached. Smee client will not reconnect.`
      );
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000); // Exponential backoff, max 30s

    console.log(
      `🔄 Attempting to reconnect Smee client (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts}) in ${delay}ms...`
    );

    setTimeout(() => {
      if (this.smee) {
        try {
          this.smee.start();
        } catch (error) {
          console.error("❌ Reconnection attempt failed:", error);
          this.handleReconnection();
        }
      }
    }, delay);
  }

  stop(): void {
    if (this.smee && this.smee.events) {
      this.smee.events.close();
      this.smee = null;
      this.isConnected = false;
      this.reconnectAttempts = 0;
      this.connectionStartTime = null;
      this.lastEventTime = null;
      console.log("🛑 Smee client stopped");
    }
  }

  isRunning(): boolean {
    return this.smee !== null;
  }

  getConnectionState(): {
    readyState: number | null;
    readyStateText: string;
  } {
    if (!this.smee?.events) {
      return { readyState: null, readyStateText: "NO_EVENTS" };
    }

    const readyState = this.smee.events.readyState;
    let readyStateText = "UNKNOWN";
    // EventSource readyState: 0 = CONNECTING, 1 = OPEN, 2 = CLOSED
    if (readyState === 0) readyStateText = "CONNECTING";
    else if (readyState === 1) readyStateText = "OPEN";
    else if (readyState === 2) readyStateText = "CLOSED";

    return { readyState, readyStateText };
  }

  // Force update connection state (useful for debugging)
  refreshConnectionState(): void {
    this.updateConnectionState();
  }

  getStatus(): {
    running: boolean;
    connected: boolean;
    smeeUrl: string;
    targetUrl: string;
    reconnectAttempts: number;
    connectionState: { readyState: number | null; readyStateText: string };
    connectionStartTime: string | null;
    lastEventTime: string | null;
  } {
    // Always refresh state when getting status
    this.updateConnectionState();
    return {
      running: this.isRunning(),
      connected: this.isConnected,
      smeeUrl: this.smeeUrl,
      targetUrl: this.targetUrl,
      reconnectAttempts: this.reconnectAttempts,
      connectionState: this.getConnectionState(),
      connectionStartTime: this.connectionStartTime?.toISOString() || null,
      lastEventTime: this.lastEventTime?.toISOString() || null,
    };
  }
}

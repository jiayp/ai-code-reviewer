import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
// Removed unused import: import crypto from "crypto";
import { loadConfig, Config } from "../config";
import { CodeReviewService } from "../service/CodeReviewService";

/**
 * WebServer - 轻量级 Express Web Server，用于监听 GitLab Merge Request Hook
 */
export class WebServer {
  private app: express.Application;
  private codeReviewService: CodeReviewService | null = null;
  private secretToken?: string;

  constructor(private config: Config) {
    this.app = express();
    this.secretToken = config.webhook.secretToken;

    // Middleware setup
    this.setupMiddleware();
    this.setupRoutes();
  }

  /**
   * Setup Express middleware
   */
  private setupMiddleware(): void {
    // Parse JSON bodies (required for webhook payloads)
    this.app.use(express.json());

    // Enable CORS for all routes (can be restricted in production)
    this.app.use(cors());

    // Request logging middleware
    this.app.use((req: Request, _res: Response, next: NextFunction) => {
      console.log(`[Web] ${req.method} ${req.path}`);
      if (req.method === "POST" && req.headers["x-gitlab-token"]) {
        console.log("[Web] Webhook received from GitLab");
      }
      next();
    });

    // Error handling middleware
    this.app.use(
      (err: Error, _req: Request, res: Response, _next: NextFunction) => {
        console.error("[Web] Unhandled error:", err);
        res.status(500).json({ error: "Internal Server Error" });
      },
    );
  }

  /**
   * Setup Express routes
   */
  private setupRoutes(): void {
    // Health check endpoint
    this.app.get("/health", (_req: Request, res: Response) => {
      res.json({ status: "ok", timestamp: new Date().toISOString() });
    });

    // GitLab Merge Request Webhook endpoint
    this.app.post(
      "/webhooks/merge-request",
      this.handleGitlabWebhook.bind(this),
    );
  }

  /**
   * Handle incoming GitLab webhook requests
   */
  private async handleGitlabWebhook(
    req: Request,
    res: Response,
  ): Promise<void> {
    try {
      // Verify secret token if configured
      const receivedToken = req.headers["x-gitlab-token"] as string | undefined;

      if (this.secretToken && receivedToken !== this.secretToken) {
        console.warn("[Web] Invalid webhook token");
        res.status(401).json({ error: "Unauthorized" });
        return;
      }

      const body = req.body;

      // Validate event type
      if (body.object_kind !== "merge_request") {
        console.log(
          `[Web] Ignoring non-merge-request event: ${body.object_kind}`,
        );
        res.json({ received: true, message: "Not a merge request event" });
        return;
      }

      // Initialize CodeReviewService on first request (lazy init)
      if (!this.codeReviewService) {
        this.codeReviewService = new CodeReviewService(this.config);
      }

      const mrData = body.object_attributes;
      const projectId = body.project.id;
      const mergeRequestId = String(mrData.iid); // object_attributes.iid is the MR IID

      console.log("[Web] Processing MR event:", {
        action: this.detectAction(body),
        projectId,
        mergeRequestId,
        state: mrData.state,
        assignees: mrData.assignee_ids?.length ?? 0,
      });

      // Only process when assignee is set for the first time
      const action = this.detectAction(body);

      if (action !== "assign") {
        console.log(`[Web] Ignoring non-assign event: ${action}`);
        res.json({
          received: true,
          message: `Not an assign event (${action})`,
        });
        return;
      }

      // Check MR is open
      if (mrData.state !== "opened") {
        console.log(`[Web] MR not open: ${mrData.state}`);
        res.json({
          received: true,
          message: `MR state is ${mrData.state}, skipping`,
        });
        return;
      }

      // Check has assignee
      const assignees = mrData.assigns || mrData.assignee_ids;
      if (!assignees || assignees.length === 0) {
        console.log("[Web] No assignee in MR");
        res.json({ received: true, message: "No assignee in MR" });
        return;
      }

      // Perform code review
      console.log(
        `[Web] Triggering review for project ${projectId}, MR #${mergeRequestId}`,
      );

      const summary = await this.codeReviewService.reviewMergeRequest(
        projectId,
        mergeRequestId,
      );

      res.json({
        received: true,
        message: `Review completed: ${summary.totalCommentsPosted} comments posted, ${summary.durationMs}ms`,
        reviewSummary: {
          totalCommentsPosted: summary.totalCommentsPosted,
          totalErrors: summary.totalErrors,
          durationMs: summary.durationMs,
          filesReviewed: summary.filesReviewed.length,
        },
      });
    } catch (error) {
      console.error("[Web] Webhook processing error:", error);

      // Return 200 to prevent GitLab from retrying/failing the webhook
      res.json({
        received: true,
        message: "Error during review",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Detect MR event action type (assign, update, reopen, etc.)
   */
  private detectAction(event: any): string {
    const changes = event.changes || {};

    // Check if assignees field changed
    if (changes.assignees !== undefined) {
      return "assign";
    }

    // Fallback for GitLab's webhook format variations
    const assignsCurrent = event.object_attributes?.assigns;
    if (Array.isArray(assignsCurrent) && assignsCurrent.length > 0) {
      // Check if it was previously empty or null
      const previousAssignees =
        changes.assignees?.previous || changes.assignees_before;

      if (!previousAssignees || JSON.stringify(previousAssignees) === "[]") {
        return "assign";
      }
    }

    // Fallback for state change events (e.g., when MR is opened)
    if (
      event.object_attributes?.state === "opened" &&
      event.event_type === "merge_request"
    ) {
      return "open";
    }

    return "unknown";
  }

  /**
   * Start the Web Server and listen on the configured port
   */
  public start(): void {
    const port = this.config.webhook.port;
    this.app.listen(port, () => {
      console.log(`[Web] Server listening on http://localhost:${port}`);
      console.log(`[Web] Health check: http://localhost:${port}/health`);
      console.log(
        `[Web] Webhook endpoint: POST http://localhost:${port}/webhooks/merge-request`,
      );
    });
  }

  /**
   * Get Express app instance (for testing or mounting)
   */
  public getApp(): express.Application {
    return this.app;
  }

  /**
   * Stop the Web Server gracefully
   */
  public stop(server?: any): void {
    if (server) {
      server.close(() => {
        console.log("[Web] Server stopped");
      });
    } else {
      // Note: express itself doesn't have a stop method, you'd need the HTTP server instance
      console.log("[Web] No server instance to close");
    }
  }
}

/**
 * Start the Web Server with the given configuration or load from config file
 */
export function startServer(config: Config | undefined): void {
  if (!config) {
    // Fallback to loading from file if no config provided
    config = loadConfig(undefined);
  }

  const server = new WebServer(config);
  server.start();

  // Handle graceful shutdown
  process.on("SIGINT", () => {
    console.log("\n[Web] Shutting down...");
    server.stop();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    console.log("\n[Web] Shutting down (SIGTERM)...");
    server.stop();
    process.exit(0);
  });
}

// CLI entry point when running directly with `node lib/web/index.js` or `pnpm web`
if (require.main === module) {
  const configPath = process.argv[2]; // Optional: path to config file as first argument
  startServer(configPath ? loadConfig(configPath) : undefined);
}

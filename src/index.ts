import { Command } from "commander";
import { loadConfig, Config } from "./config";
import { CodeReviewService } from "./service/CodeReviewService";
import { startServer } from "./web";

const program = new Command();

// Global options for all commands
program.option("-c, --config <string>", "Path to config file").version("0.1.2");

// 'review' subcommand: Run CLI-based review (original behavior)
program
  .command("review")
  .description("Run a one-off code review for a specific MR")
  .option("-p, --project-id <number>", "GitLab Project ID")
  .requiredOption("-r, --merge-request-id <string>", "Merge Request IID")
  .option("-g, --gitlab-api-url <string>", "GitLab API URL")
  .option("-t, --gitlab-access-token <string>", "GitLab Access Token")
  .option("-o, --openai-api-url <string>", "OpenAI API URL")
  .option("-a, --openai-access-token <string>", "OpenAI Access Token")
  .option("-m, --model <string>", "LLM Model Name")
  .option("-org, --organization-id <string>", "OpenAI Organization ID")
  .option("--temperature <number>", "Temperature Setting")
  .action(async (options) => {
    console.log("ai code review is underway...");

    const config: Config = loadConfig(options.config);

    // Override with CLI options
    const finalConfig: Config = {
      gitlab: {
        apiUrl: options.gitlabApiUrl || config.gitlab.apiUrl,
        accessToken: options.gitlabAccessToken || config.gitlab.accessToken,
        projectId: options.projectId || config.gitlab.projectId,
        mergeRequestId: options.mergeRequestId || config.gitlab.mergeRequestId,
      },
      openai: {
        apiUrl: options.openaiApiUrl || config.openai.apiUrl,
        accessToken: options.openaiAccessToken || config.openai.accessToken,
        model: options.model || config.openai.model,
        organizationId: options.organizationId || config.openai.organizationId,
        temperature:
          options.temperature !== undefined
            ? parseFloat(options.temperature)
            : config.openai.temperature,
        stream: config.openai.stream,
      },
      webhook: {
        port: config.webhook?.port || 8080,
        secretToken: config.webhook?.secretToken || "",
      },
      prompts: { ...config.prompts },
    };

    const service = new CodeReviewService(finalConfig);
    const summary = await service.reviewMergeRequest(
      finalConfig.gitlab.projectId,
      finalConfig.gitlab.mergeRequestId,
    );

    console.log("Review completed!");
    console.log(`Comments posted: ${summary.totalCommentsPosted}`);
    console.log(`Errors: ${summary.totalErrors}`);
    console.log(`Duration: ${summary.durationMs}ms`);
  });

// 'web' subcommand: Start the Webhook listener server
program
  .command("web")
  .description("Start webhook listener for GitLab MR events")
  .option("-g, --gitlab-api-url <string>", "GitLab API URL")
  .option("-t, --gitlab-access-token <string>", "GitLab Access Token")
  .option("-o, --openai-api-url <string>", "OpenAI API URL")
  .option("-a, --openai-access-token <string>", "OpenAI Access Token")
  .option("-m, --model <string>", "LLM Model Name")
  .option("-org, --organization-id <string>", "OpenAI Organization ID")
  .option("--temperature <number>", "Temperature Setting")
  .option("-w, --port <number>", "Web server port (default: 8080)")
  .action(async (options) => {
    const config: Config = loadConfig(options.config);

    // Merge CLI overrides into config.webhook section
    // Merge CLI overrides into config sections
    config.gitlab.apiUrl = options.gitlabApiUrl || config.gitlab.apiUrl;
    config.gitlab.accessToken =
      options.gitlabAccessToken || config.gitlab.accessToken;
    config.openai.apiUrl = options.openaiApiUrl || config.openai.apiUrl;
    config.openai.accessToken =
      options.openaiAccessToken || config.openai.accessToken;
    config.openai.model = options.model || config.openai.model;
    config.openai.organizationId =
      options.organizationId || config.openai.organizationId;
    if (options.temperature !== undefined) {
      config.openai.temperature = parseFloat(options.temperature);
    }
    if (options.port !== undefined) {
      config.webhook.port = parseInt(options.port, 10);
    }

    // Start server with the merged configuration
    startServer(config);
  });

program.parse(process.argv);

module.exports = { CodeReviewService };

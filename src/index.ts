import { Command } from 'commander';
import { GitLab } from './gitlab';
import { OpenAI } from './openai';
import { delay, getDiffBlocks, getLineObj } from "./utils";
import { loadConfig, Config } from './config';

const program = new Command();

program
  .option('-c, --config <string>', 'Path to config file')
  .option('-g, --gitlab-api-url <string>', 'GitLab API URL')
  .option('-t, --gitlab-access-token <string>', 'GitLab Access Token')
  .option('-o, --openai-api-url <string>', 'OpenAI API URL')
  .option('-a, --openai-access-token <string>', 'OpenAI Access Token')
  .option('-p, --project-id <number>', 'GitLab Project ID')
  .option('-r, --merge-request-id <string>', 'GitLab Merge Request ID')
  .option('-m, --model <string>', 'OpenAI model name')
  .option('-org, --organization-id <string>', 'OpenAI organization ID')
  .option('--temperature <number>', 'OpenAI temperature setting')
  .parse(process.argv);

async function run() {
  const options = program.opts();

  // Load config from file
  const config: Config = loadConfig(options.config);

  // Override config with command line options
  const finalConfig = {
    gitlab: {
      apiUrl: options.gitlabApiUrl || config.gitlab.apiUrl,
      accessToken: options.gitlabAccessToken || config.gitlab.accessToken,
      projectId: options.projectId || config.gitlab.projectId,
      mergeRequestId: options.mergeRequestId || config.gitlab.mergeRequestId
    },
    openai: {
      apiUrl: options.openaiApiUrl || config.openai.apiUrl,
      accessToken: options.openaiAccessToken || config.openai.accessToken,
      model: options.model || config.openai.model,
      organizationId: options.organizationId || config.openai.organizationId,
      temperature: options.temperature !== undefined ? parseFloat(options.temperature) : config.openai.temperature,
      stream: config.openai.stream
    },
    prompts: config.prompts
  };

  console.log('ai code review is underway...')
  const gitlab = new GitLab({
    gitlabApiUrl: finalConfig.gitlab.apiUrl,
    gitlabAccessToken: finalConfig.gitlab.accessToken,
    projectId: finalConfig.gitlab.projectId,
    mergeRequestId: finalConfig.gitlab.mergeRequestId
  });
  const openai = new OpenAI(
    finalConfig.openai.apiUrl,
    finalConfig.openai.accessToken,
    finalConfig.openai.organizationId,
    finalConfig.openai.model,
    finalConfig.openai.temperature
  );
  await gitlab.init().catch(() => {
    console.log('gitlab init error')
  });
  const changes = await gitlab.getMergeRequestChanges().catch(() => {
    console.log('get merge request changes error')
  });
  for (const change of changes) {
    if (change.renamed_file || change.deleted_file || !change?.diff?.startsWith('@@')) {
      continue;
    }
    console.log(`Reviewing changes for file: ${change?.new_path || change?.old_path}`);
    const diffBlocks = getDiffBlocks(change?.diff);
    while (!!diffBlocks.length) {
      const item = diffBlocks.shift()!;
      const lineRegex = /@@\s-(\d+)(?:,(\d+))?\s\+(\d+)(?:,(\d+))?\s@@/;
      const matches = lineRegex.exec(item);
      if (matches) {
        const lineObj = getLineObj(matches, item);
        if ((lineObj?.new_line && lineObj?.new_line > 0) || (lineObj.old_line && lineObj.old_line > 0)) {
          try {
            const suggestion = await openai.reviewCodeChange(item);
            if (!suggestion.includes('666')) {
              await gitlab.addReviewComment(lineObj, change, suggestion);
            }
          } catch (e: any) {
            if (e?.response?.status === 429) {
              console.log('Too Many Requests, try again');
              await delay(60 * 1000);
              diffBlocks.push(item);
            }
          }
        }
      }
    }
  }
  console.log('done');
}

module.exports = run;


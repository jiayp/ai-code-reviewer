import * as fs from 'fs';
import * as path from 'path';

export interface Config {
  gitlab: {
    apiUrl: string;
    accessToken: string;
    projectId: number;
    mergeRequestId: string;
  };
  openai: {
    apiUrl: string;
    accessToken: string;
    model: string;
    organizationId?: string;
    temperature: number;
    stream: boolean;
  };
  prompts: {
    systemContent: string;
    suggestContent: string;
    fullContent: string;
  };
}

export const defaultConfig: Config = {
  gitlab: {
    apiUrl: 'https://gitlab.com/api/v4',
    accessToken: '',
    projectId: 0,
    mergeRequestId: ''
  },
  openai: {
    apiUrl: 'https://api.openai.com',
    accessToken: '',
    model: 'gpt-3.5-turbo',
    organizationId: undefined,
    temperature: 0,
    stream: false
  },
  prompts: {
    systemContent: "You are a code reviewer,Your role is to identify bugs, performance issues, and areas for optimization in the submitted  code. You are also responsible for providing constructive feedback and suggesting best practices to improve the overall quality of the code. ",
    suggestContent: `Next, I will send you each step of the merge request in standard git diff format, your task is:
      - Review the code changes (diffs) in the patch and provide feedback.
      - Examine it carefully to see if it really has bugs or needs room for optimization, highlight them.
      - The code is compiled and passed linting and can run successfully, so please focus on potential issues and improvements rather than syntax errors.
      - Do not highlight minor issues and nitpicks.
      - Use bullet points if you have multiple comments.
      - You don't have to explain what the code does
      - please use chinese to give feedback.
      - If you think there is no need to optimize or modify, please reply with 666.
      Here are the changes that were committed this time`,
    fullContent: "First step, the following is the revised full text of this file. Please carefully understand the code content in this file."
  }
};

export function loadConfig(configPath?: string): Config {
  const configFilePath = configPath || path.join(process.cwd(), 'ai-code-reviewer.config.json');

  try {
    if (fs.existsSync(configFilePath)) {
      const configData = fs.readFileSync(configFilePath, 'utf-8');
      const userConfig = JSON.parse(configData);
      return mergeConfigs(defaultConfig, userConfig);
    }
  } catch (error) {
    console.warn(`Warning: Could not load config file ${configFilePath}, using defaults. Error: ${error}`);
  }

  return defaultConfig;
}

function mergeConfigs(defaultConfig: Config, userConfig: Partial<Config>): Config {
  return {
    gitlab: { ...defaultConfig.gitlab, ...userConfig.gitlab },
    openai: { ...defaultConfig.openai, ...userConfig.openai },
    prompts: { ...defaultConfig.prompts, ...userConfig.prompts }
  };
}
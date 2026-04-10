import * as fs from 'fs';
import * as path from 'path';

// Simple TOML parser for basic config needs
function parseTOML(content: string): any {
  const result: any = {};
  const lines = content.split('\n');
  let currentSection = '';

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();

    // Skip empty lines and comments
    if (!line || line.startsWith('#')) continue;

    // Section headers
    if (line.startsWith('[') && line.endsWith(']')) {
      currentSection = line.slice(1, -1);
      result[currentSection] = {};
      continue;
    }

    // Key-value pairs
    const equalIndex = line.indexOf('=');
    if (equalIndex > 0) {
      const key = line.slice(0, equalIndex).trim();
      let value: any = line.slice(equalIndex + 1).trim();

      // Check if this starts a multi-line string
      if (value === '"""') {
        // Collect multi-line string
        let multilineContent = '';
        i++; // Move to next line
        while (i < lines.length) {
          const contentLine = lines[i];
          if (contentLine.trim() === '"""') {
            // End of multi-line string
            break;
          }
          multilineContent += contentLine + '\n';
          i++;
        }
        // Remove trailing newline
        multilineContent = multilineContent.replace(/\n$/, '');

        if (currentSection) {
          result[currentSection][key] = multilineContent;
        } else {
          result[key] = multilineContent;
        }
        continue;
      }

      // Handle regular values
      if (value.startsWith('"') && value.endsWith('"')) {
        value = value.slice(1, -1);
      } else if (value === 'true') {
        value = true;
      } else if (value === 'false') {
        value = false;
      } else if (!isNaN(Number(value)) && value !== '') {
        value = Number(value);
      }

      if (currentSection) {
        result[currentSection][key] = value;
      } else {
        result[key] = value;
      }
    }
  }

  return result;
}
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

export interface RawConfig {
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
  const possiblePaths = [
    configPath,
    path.join(process.cwd(), 'ai-code-reviewer.config.toml'),
    path.join(process.cwd(), 'ai-code-reviewer.config.json')
  ].filter(Boolean) as string[];

  for (const configFilePath of possiblePaths) {
    if (fs.existsSync(configFilePath)) {
      try {
        const configData = fs.readFileSync(configFilePath, 'utf-8');

        if (configFilePath.endsWith('.toml')) {
          const rawConfig: RawConfig = parseTOML(configData);
          return processRawConfig(rawConfig);
        } else {
          const rawConfig: RawConfig = JSON.parse(configData);
          return processRawConfig(rawConfig);
        }
      } catch (error) {
        console.warn(`Warning: Could not load config file ${configFilePath}, trying next... Error: ${error}`);
      }
    }
  }

  return defaultConfig;
}

function processRawConfig(rawConfig: RawConfig): Config {
  return {
    gitlab: rawConfig.gitlab,
    openai: rawConfig.openai,
    prompts: {
      systemContent: rawConfig.prompts.systemContent,
      suggestContent: rawConfig.prompts.suggestContent,
      fullContent: rawConfig.prompts.fullContent
    }
  };
}
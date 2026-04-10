import { loadConfig, Config } from './config';

const config: Config = loadConfig();

export const fullContent = {
  "role": "user",
  "content": config.prompts.fullContent
}

export const systemContent = {
  "role": "system",
  "content": config.prompts.systemContent
};

export const suggestContent = {
  "role": "user",
  "content": config.prompts.suggestContent
}

export const openAiCompletionsConfig = {
  "temperature": config.openai.temperature,
  "model": config.openai.model,
  "stream": config.openai.stream,
}

export const delay = (time: number) => {
  return new Promise(resolve => setTimeout(resolve, time));
}

export const getDiffBlocks = (diff: string) => {
  const regex = /(?=@@\s-\d+(?:,\d+)?\s\+\d+(?:,\d+)?\s@@)/g;
  const diffBlocks: string[] = diff.split(regex);
  return diffBlocks;
}

export const getLineObj = (matches: RegExpMatchArray, item: string) => {
  const lineObj: { new_line?: number, old_line?: number } = {};
  const lastLine = item.split(/\r?\n/)?.reverse()?.[1]?.trim();
  const oldLineStart = +matches[1];
  const oldLineEnd = +matches[2] || 0;
  const newLineStart = +matches[3];
  const newLineEnd = +matches[4] || 0;
  if (lastLine?.[0] === '+') {
    lineObj.new_line = newLineStart + newLineEnd - 1;
  } else if (lastLine?.[0] === '-') {
    lineObj.old_line = oldLineStart + oldLineEnd - 1;
  } else {
    lineObj.new_line = newLineStart + newLineEnd - 1;
    lineObj.old_line = oldLineStart + oldLineEnd - 1;
  }
  return lineObj;
}
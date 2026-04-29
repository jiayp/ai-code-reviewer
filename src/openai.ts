import axios, { AxiosInstance } from "axios";
import { openAiCompletionsConfig, suggestContent, systemContent } from "./utils";

interface ICompletion {
  messages?: { role: string; content: string }[];
  temperature: number;
  model: string;
}

export class OpenAI {
  private apiClient: AxiosInstance;
  private accessTokens: string[];
  private accessTokenIndex = 0;

  constructor(
    private apiUrl: string,
    private accessToken: string,
    private orgId?: string,
    private model = "gpt-3.5-turbo",
    private temperature = 0,
  ) {
    this.accessTokens = accessToken.split(",");
    const headers: { "OpenAI-Organization"?: string } = {};
    if (orgId) {
      headers["OpenAI-Organization"] = orgId;
    }
    this.apiClient = axios.create({
      baseURL: apiUrl,
      headers: {
        ...headers,
      },
    });
  }

  async reviewCodeChange(change: string): Promise<string> {
    const newIndex = (this.accessTokenIndex =
      this.accessTokenIndex >= this.accessTokens.length - 1 ? 0 : this.accessTokenIndex + 1);
    const data: ICompletion = {
      ...openAiCompletionsConfig,
      model: this.model,
      temperature: this.temperature,
    };
    data.messages = [
      systemContent,
      suggestContent,
      {
        role: "user",
        content: change,
      },
    ];
    try {
      const response = await this.apiClient.post("/chat/completions", data, {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.accessTokens[newIndex]}`,
        },
      });
      if (!response.data.choices?.[0]?.message?.content) {
        console.log("request data: ", data);
        console.log("response data: ", response.data);
        console.log("response data messages: ", response.data.choices?.[0]?.message);
      }
      return response.data.choices?.[0]?.message?.content;
    } catch (error: unknown) {
      console.error("OpenAI request failed:", error);
      throw new Error(
        `OpenAI request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * 审查文件组（多个文件的diff一起发送）
   */
  async reviewGroupChanges(groupDiffContent: string): Promise<string> {
    const newIndex = (this.accessTokenIndex =
      this.accessTokenIndex >= this.accessTokens.length - 1 ? 0 : this.accessTokenIndex + 1);

    // 为文件组审查创建专门的prompt
    const groupSuggestContent = {
      role: "user",
      content: `Next, I will send you the combined diffs of multiple related files in standard git diff format. The files are separated by "---END_OF_FILE---" markers and each file starts with "=== filename ===".

Your task is to review all code changes across these files and provide feedback for each issue found. For each issue:
- You MUST specify both the file name AND line number where the problem occurs using the format: 【文件路径:行号】评论内容
  For example: 【src/utils/helper.ts:42】这个变量应该使用 const 声明
               【api/controller.ts:105】这里可能存在空指针异常，建议添加非空判断
- If multiple issues exist in different files, use separate markers for each.
- The code is compiled and passed linting and can run successfully, so please focus on potential issues and improvements rather than syntax errors.
- Do not highlight minor issues and nitpicks.
- You don't have to explain what the code does
- Please use Chinese to give feedback.
- If you think there is no need to optimize or modify in any of these files, please reply with only 666 (nothing else).

Here are the changes that were committed this time:`,
    };

    const data: ICompletion = {
      ...openAiCompletionsConfig,
      model: this.model,
      temperature: this.temperature,
    };
    data.messages = [
      systemContent,
      groupSuggestContent,
      { role: "user", content: groupDiffContent },
    ];

    try {
      const response = await this.apiClient.post("/chat/completions", data, {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.accessTokens[newIndex]}`,
        },
      });
      if (!response.data.choices?.[0]?.message?.content) {
        console.log("request data: ", JSON.stringify(data, null, 2));
        console.log("response data: ", response.data);
      }
      return response.data.choices?.[0]?.message?.content;
    } catch (error: unknown) {
      console.error("OpenAI group review request failed:", error);
      throw new Error(
        `OpenAI group review request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * 请求 AI 对大文件进行智能分组（仅发送文件列表，不发送diff内容）
   */
  async requestGrouping(fileListPrompt: string): Promise<string> {
    const newIndex = (this.accessTokenIndex =
      this.accessTokenIndex >= this.accessTokens.length - 1 ? 0 : this.accessTokenIndex + 1);

    const groupingContent = {
      role: "user",
      content: `You are a code architect assistant. I will send you a list of files with their change line counts from a merge request. Your task is to group these files logically based on their functional relationships, module structure, or dependency patterns.

Grouping rules:
1. Files that work together (e.g., controller + service + model) should be in the same group
2. Files related to the same feature or business domain should be grouped together
3. Try to keep total changed lines per group under 2000 when possible
4. If a single file has more than 2000 changed lines, it should be in its own group

Please return your grouping result as valid JSON with this exact structure:
{
  "groups": [
    {
      "groupName": "GroupName",
      "files": ["file1.ts", "file2.ts"]
    }
  ]
}

IMPORTANT: Return ONLY the JSON object, nothing else. No markdown code fences, no explanations.`,
    };

    const data: ICompletion = {
      ...openAiCompletionsConfig,
      model: this.model,
      temperature: this.temperature,
    };
    data.messages = [groupingContent];

    try {
      const response = await this.apiClient.post("/chat/completions", data, {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.accessTokens[newIndex]}`,
        },
      });
      return response.data.choices?.[0]?.message?.content;
    } catch (error: unknown) {
      console.error("OpenAI grouping request failed:", error);
      throw new Error(
        `OpenAI grouping request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

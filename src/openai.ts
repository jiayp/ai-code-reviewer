import axios, { AxiosInstance } from "axios";
import {
  openAiCompletionsConfig,
  suggestContent,
  systemContent,
} from "./utils";

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
      this.accessTokenIndex >= this.accessTokens.length - 1
        ? 0
        : this.accessTokenIndex + 1);
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
        console.log(
          "response data messages: ",
          response.data.choices?.[0]?.message,
        );
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
      this.accessTokenIndex >= this.accessTokens.length - 1
        ? 0
        : this.accessTokenIndex + 1);

    const data: ICompletion = {
      ...openAiCompletionsConfig,
      model: this.model,
      temperature: this.temperature,
    };
    data.messages = [
      systemContent,
      suggestContent,
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
      this.accessTokenIndex >= this.accessTokens.length - 1
        ? 0
        : this.accessTokenIndex + 1);

    const groupingContent = {
      role: "user",
      content: fileListPrompt,
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

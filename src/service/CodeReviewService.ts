import { GitLab } from "../gitlab";
import { OpenAI } from "../openai";
import { delay, getDiffBlocks, getLineObj } from "../utils";
import { Config } from "../config";

/**
 * 单文件审查结果
 */
export interface FileReviewResult {
  filePath: string;
  commentsPosted: number;
  skipped: boolean;
  errors: string[];
}

/**
 * 完整审查结果汇总
 */
export interface ReviewSummary {
  success: boolean;
  filesReviewed: FileReviewResult[];
  totalCommentsPosted: number;
  totalErrors: number;
  durationMs: number;
}

/**
 * CodeReviewService - 核心代码审查服务类
 *
 * 职责：
 * 1. 封装 GitLab MR 变更获取与评论发布逻辑
 * 2. 封装 Diff 分块解析与行号映射逻辑
 * 3. 封装 OpenAI 调用、速率限制重试逻辑
 * 4. 提供统一的审查入口，支持 CLI 和 Web Hook 复用
 */
export class CodeReviewService {
  private config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  /**
   * 执行完整的代码审查流程（核心方法）
   *
   * @param projectId GitLab 项目 ID
   * @param mergeRequestId Merge Request IID
   * @returns 审查结果汇总
   */
  async reviewMergeRequest(
    projectId: number,
    mergeRequestId: string,
  ): Promise<ReviewSummary> {
    const startTime = Date.now();
    const filesReviewed: FileReviewResult[] = [];
    let totalCommentsPosted = 0;
    let totalErrors = 0;

    // --- Step 1: 创建 GitLab 实例并初始化 ---
    const gitlab = new GitLab({
      gitlabApiUrl: this.config.gitlab.apiUrl,
      gitlabAccessToken: this.config.gitlab.accessToken,
      projectId: String(projectId),
      mergeRequestId,
    });

    await gitlab.init().catch((err) => {
      console.warn("[CodeReview] GitLab init failed (non-fatal):", err);
    });

    // --- Step 2: 获取 MR 所有变更文件 ---
    let changes;
    try {
      changes = await gitlab.getMergeRequestChanges();
    } catch (err) {
      console.error("[CodeReview] Failed to get merge request changes:", err);
      return this.buildSummary(
        filesReviewed,
        totalCommentsPosted,
        1,
        startTime,
      );
    }

    if (!changes || changes.length === 0) {
      console.log(`[CodeReview] No changes found for MR #${mergeRequestId}`);
      return this.buildSummary(filesReviewed, 0, 0, startTime);
    }

    // --- Step 3: 创建 OpenAI 实例（每个审查请求创建一个新实例）---
    const openai = new OpenAI(
      this.config.openai.apiUrl,
      this.config.openai.accessToken,
      this.config.openai.organizationId,
      this.config.openai.model,
      this.config.openai.temperature,
    );

    // --- Step 4: 逐个文件审查 ---
    for (const change of changes) {
      const filePath = change.new_path || change.old_path;
      let fileCommentsPosted = 0;
      const fileErrors: string[] = [];

      // 跳过重命名、删除的文件或非 diff 内容
      if (
        change.renamed_file ||
        change.deleted_file ||
        !change?.diff?.startsWith("@@")
      ) {
        console.log(`[CodeReview] Skipping file: ${filePath}`);
        filesReviewed.push({
          filePath,
          commentsPosted: 0,
          skipped: true,
          errors: [],
        });
        continue;
      }

      // --- Step 5: Diff 分块遍历与审查 ---
      const diffBlocks = getDiffBlocks(change.diff);

      while (diffBlocks.length > 0) {
        const item = diffBlocks.shift()!;
        const lineRegex = /@@\s-(\d+)(?:,(\d+))?\s\+(\d+)(?:,(\d+))?\s@@/;
        const matches = lineRegex.exec(item);

        if (matches) {
          const lineObj = getLineObj(matches, item);

          // 确保行号有效
          if (
            (lineObj?.new_line && lineObj.new_line > 0) ||
            (lineObj.old_line && lineObj.old_line > 0)
          ) {
            try {
              console.log(
                `[CodeReview] Reviewing diff block for file: ${filePath}`,
              );

              // 调用 AI 获取审查建议
              const suggestion = await openai.reviewCodeChange(item);

              // 如果建议包含 "666"，表示没有问题需要反馈（不发表评论）
              if (!suggestion.includes("666")) {
                console.log(
                  `[CodeReview] Posting comment for file: ${filePath}`,
                );
                await gitlab.addReviewComment(lineObj, change, suggestion);
                fileCommentsPosted++;
                totalCommentsPosted++;
              } else {
                console.log(`[CodeReview] No issues found in diff block`);
              }
            } catch (error: any) {
              // 处理速率限制错误（429）：等待后重试同一块
              if (error?.response?.status === 429) {
                console.log(
                  "[CodeReview] Rate limited by API, waiting 60 seconds...",
                );
                await delay(60 * 1000);

                // 将当前块重新放回队列头部
                diffBlocks.unshift(item);
              } else {
                const errorMsg =
                  error instanceof Error ? error.message : String(error);
                console.error(`[CodeReview] Error reviewing code: ${errorMsg}`);
                fileErrors.push(errorMsg);
                totalErrors++;
              }
            }
          }
        }
      }

      filesReviewed.push({
        filePath,
        commentsPosted: fileCommentsPosted,
        skipped: false,
        errors: fileErrors,
      });
    }

    return this.buildSummary(
      filesReviewed,
      totalCommentsPosted,
      totalErrors,
      startTime,
    );
  }

  /**
   * 构建审查结果汇总对象
   */
  private buildSummary(
    filesReviewed: FileReviewResult[],
    totalCommentsPosted: number,
    totalErrors: number,
    startTime: number,
  ): ReviewSummary {
    const durationMs = Date.now() - startTime;
    return {
      success: totalErrors === 0,
      filesReviewed,
      totalCommentsPosted,
      totalErrors,
      durationMs,
    };
  }

  /**
   * 获取当前配置摘要（用于调试和日志记录）
   */
  getConfigSummary(): {
    gitlabUrl: string;
    model: string;
    temperature: number;
  } {
    return {
      gitlabUrl: this.config.gitlab.apiUrl,
      model: this.config.openai.model,
      temperature: this.config.openai.temperature,
    };
  }
}

export default CodeReviewService;

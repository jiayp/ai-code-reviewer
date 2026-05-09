import { GitLab } from "../gitlab";
import { OpenAI } from "../openai";
import { delay, buildPositionForGitLab } from "../utils";
import { Config } from "../config";

// ==================== 导出接口定义 ====================

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

// ==================== AI 分组接口定义 ====================

/** AI 文件分组请求 - 发送给AI的文件信息列表 */
interface LargeFileInfo {
  filePath: string;
  addedLines: number;
  removedLines: number;
}

/** AI 返回的文件分组结果 */
interface AIFileGroupingResult {
  groups: Array<{
    groupName: string;
    files: string[];
  }>;
}

// ==================== 文件组内部定义 ====================

/** 文件组内的单个文件信息 */
interface GroupFileInfo {
  filePath: string;
  change: any;
  diffContent: string;
  addedLines: number;
  removedLines: number;
}

/** 解析后的评论，包含行号类型（+ = 新增, - = 删除, 无符号 = 上下文） */
interface ParsedComment {
  filePath?: string;
  lineNumber: number;
  lineType: 'added' | 'removed' | 'context';
  codeContent?: string;
  content: string;
}

/** 文件组 - 用于一起发送给AI审查的文件集合 */
interface FileGroup {
  groupName: string;
  files: GroupFileInfo[];
}

// ==================== Diff 行统计接口定义 ====================

/** Diff 变更行数统计 */
interface DiffLineCount {
  addedLines: number;
  removedLines: number;
  totalChangedLines: number;
}

// ==================== CodeReviewService 类定义 ====================

/**
 * CodeReviewService - 核心代码审查服务类
 *
 * 职责：
 * 1. 统计 MR 所有变更文件的总行数
 * 2. 总变更行数 ≤ 2000：一次性将所有文件一起发送给 AI 审查
 * 3. 总变更行数 > 2000：请求 AI 进行智能分组，再按组审查
 * 4. AI 返回带【文件:行号】格式的评论，解析后逐个发布到 GitLab
 */
export class CodeReviewService {
  private config: Config;

  /** 获取配置中的最大分组行数阈值，默认2000 */
  private get maxLinesForGrouping(): number {
    return this.config.codeReview?.maxLinesForGrouping ?? 2000;
  }

  constructor(config: Config) {
    this.config = config;
  }

  // ==================== 主入口方法 ====================

  /**
   * 执行完整的代码审查流程（核心方法）
   */
  async reviewMergeRequest(projectId: number, mergeRequestId: string): Promise<ReviewSummary> {
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
      return this.buildSummary(filesReviewed, totalCommentsPosted, 1, startTime);
    }

    if (!changes || changes.length === 0) {
      console.log(`[CodeReview] No changes found for MR #${mergeRequestId}`);
      return this.buildSummary(filesReviewed, 0, 0, startTime);
    }

    // --- Step 3: 创建 OpenAI 实例 ---
    const openai = new OpenAI(
      this.config.openai.apiUrl,
      this.config.openai.accessToken,
      this.config.openai.organizationId,
      this.config.openai.model,
      this.config.openai.temperature,
    );

    // --- Step 4: 收集有效文件并跳过无效文件 ---
    const validChangesMap = new Map<string, any>();

    for (const change of changes) {
      const filePath = change.new_path || change.old_path;

      if (change.renamed_file || change.deleted_file || !change?.diff?.startsWith("@@")) {
        // 记录跳过文件的结果（重命名、删除等）
        filesReviewed.push({
          filePath,
          commentsPosted: 0,
          skipped: true,
          errors: [],
        });
      } else {
        validChangesMap.set(filePath, change);
      }
    }

    if (validChangesMap.size === 0) {
      console.log(`[CodeReview] No valid changes to review`);
      return this.buildSummary(filesReviewed, totalCommentsPosted, totalErrors, startTime);
    }

    // --- Step 5: 统计总变更行数 ---
    let totalChangedLines = 0;
    for (const change of validChangesMap.values()) {
      const lineCount = this.countDiffLines(change.diff);
      totalChangedLines += lineCount.totalChangedLines;
    }

    console.log(`[CodeReview] Total changed lines across all files: ${totalChangedLines}`);

    // --- Step 6: 根据总行数决定审查策略 ---
    const reviewResult = await this.executeReviewStrategy(
      openai,
      validChangesMap,
      gitlab,
      totalChangedLines,
    );

    totalCommentsPosted += reviewResult.commentsPosted;
    totalErrors += reviewResult.errors.length;

    // 添加所有文件的审查结果（如果没有错误）
    if (reviewResult.errors.length === 0) {
      for (const filePath of validChangesMap.keys()) {
        filesReviewed.push({
          filePath,
          commentsPosted: 0,
          skipped: false,
          errors: [],
        });
      }
    } else {
      // 如果有错误，只为未记录的文件添加结果
      const reviewedFiles = new Set(filesReviewed.map((f) => f.filePath));
      for (const filePath of validChangesMap.keys()) {
        if (!reviewedFiles.has(filePath)) {
          filesReviewed.push({
            filePath,
            commentsPosted: 0,
            skipped: false,
            errors: [],
          });
        }
      }
    }

    return this.buildSummary(filesReviewed, totalCommentsPosted, totalErrors, startTime);
  }

  // ==================== 审查策略执行 ====================

  /**
   * 根据总行数选择合适的审查策略
   */
  private async executeReviewStrategy(
    openai: OpenAI,
    validChangesMap: Map<string, any>,
    gitlab: GitLab,
    totalChangedLines: number,
  ): Promise<{ commentsPosted: number; errors: string[] }> {
    if (totalChangedLines <= this.maxLinesForGrouping) {
      // 情况A：总变更行数 ≤ maxLinesForGrouping，一次性将所有文件一起发送给AI审查
      console.log(
        `[CodeReview] Total changes (${totalChangedLines} lines) is within limit, reviewing all files together`,
      );
      return await this.reviewAllFilesTogether(openai, validChangesMap, gitlab);
    } else {
      // 情况B：总变更行数 > maxLinesForGrouping，让AI分组后再审查
      console.log(
        `[CodeReview] Total changes (${totalChangedLines} lines) exceeds limit, requesting AI grouping`,
      );
      return await this.reviewFilesWithAIGrouping(openai, validChangesMap, gitlab);
    }
  }

  // ==================== 策略A: 一次性审查所有文件 ====================

  /**
   * 一次性审查所有文件（适用于总变更行数 ≤ maxLinesForGrouping）
   */
  private async reviewAllFilesTogether(
    openai: OpenAI,
    validChangesMap: Map<string, any>,
    gitlab: GitLab,
  ): Promise<{ commentsPosted: number; errors: string[] }> {
    let commentsPosted = 0;
    const errors: string[] = [];

    // 构建所有文件的diff内容，每个文件之间用分隔符隔开
    const allDiffContent = Array.from(validChangesMap.values())
      .map((change) => `=== ${change.new_path || change.old_path} ===\n${change.diff}\n`)
      .join("---END_OF_FILE---\n");

    const filePaths = Array.from(validChangesMap.keys());

    console.log(`[CodeReview] Reviewing all ${filePaths.length} files together`);

    // 调用AI进行审查
    let suggestion: string;
    try {
      suggestion = await openai.reviewGroupChanges(allDiffContent);
    } catch (error: any) {
      console.error("[CodeReview] Failed to review all files together:", error);
      throw new Error(`Failed to review all files: ${error.message}`);
    }

    // 如果建议包含 "666"，表示没有问题需要反馈
    if (suggestion.includes("666")) {
      console.log(`[CodeReview] No issues found in any file`);
      return { commentsPosted: 0, errors: [] };
    }

    // 解析AI返回的评论并构建文件上下文用于发布
    const parsedComments = this.parseAiGroupComments(suggestion, filePaths);

    if (parsedComments.length === 0) {
      console.log(suggestion);
      console.log(`[CodeReview] No specific comments could be parsed`);
      return { commentsPosted: 0, errors: [] };
    }

    // 构建文件上下文（用于查找change对象）
    const fileContexts: GroupFileInfo[] = Array.from(validChangesMap.values()).map((change) => ({
      filePath: change.new_path || change.old_path,
      change,
      diffContent: change.diff,
      addedLines: 0,
      removedLines: 0,
    }));

    // 委托给统一方法发布评论
    const result = await this.postCommentsWithFileContext(suggestion, fileContexts, gitlab);

    return { commentsPosted: result.commentsPosted, errors: result.errors };
  }

  // ==================== 策略B: AI分组后审查 ====================

  /**
   * AI分组后审查文件（适用于总变更行数 > maxLinesForGrouping）
   */
  private async reviewFilesWithAIGrouping(
    openai: OpenAI,
    validChangesMap: Map<string, any>,
    gitlab: GitLab,
  ): Promise<{ commentsPosted: number; errors: string[] }> {
    let totalCommentsPosted = 0;
    const allErrors: string[] = [];

    // --- Step 1: 获取所有文件的元信息用于AI分组 ---
    const fileInfos: LargeFileInfo[] = Array.from(validChangesMap.values()).map((change) => ({
      filePath: change.new_path || change.old_path,
      addedLines: this.countDiffLines(change.diff).addedLines,
      removedLines: this.countDiffLines(change.diff).removedLines,
    }));

    console.log(`[CodeReview] Requesting AI to group ${fileInfos.length} files...`);

    // --- Step 2: 请求AI进行智能分组 ---
    let aiGroups: AIFileGroupingResult["groups"];
    try {
      aiGroups = await this.requestAIGrouping(openai, fileInfos);
    } catch (error: any) {
      console.error("[CodeReview] Error during AI grouping:", error);
      throw new Error(`AI grouping failed: ${error.message}`);
    }

    // --- Step 3: 将 AI 返回的分组转换为 FileGroup 格式，并填充实际的 diffContent ---
    const fileGroups: FileGroup[] = aiGroups
      .map((aiGroup) => ({
        groupName: aiGroup.groupName,
        files: aiGroup.files
          .map((filePath) => {
            const change = validChangesMap.get(filePath);
            if (!change || !change.diff) return null;

            const lineCount = this.countDiffLines(change.diff);
            return {
              filePath,
              change,
              diffContent: change.diff,
              addedLines: lineCount.addedLines,
              removedLines: lineCount.removedLines,
            };
          })
          .filter((file): file is GroupFileInfo => file !== null), // 过滤掉无效文件
      }))
      .filter((group) => group.files.length > 0); // 过滤掉空组

    console.log(`[CodeReview] Created ${fileGroups.length} groups for review`);

    // --- Step 4: 按组审查 ---
    for (const group of fileGroups) {
      try {
        const result = await this.reviewFileGroup(openai, group, gitlab);
        totalCommentsPosted += result.commentsPosted;

        if (result.errors.length > 0) {
          allErrors.push(...result.errors.map((e) => `Group "${group.groupName}": ${e}`));
        }
      } catch (error: any) {
        console.error(`[CodeReview] Error reviewing group "${group.groupName}":`, error);

        // 重试逻辑
        if (error?.response?.status === 429) {
          console.log("[CodeReview] Rate limited, waiting 60 seconds before retry...");
          await delay(60 * 1000);

          try {
            const retryResult = await this.reviewFileGroup(openai, group, gitlab);
            totalCommentsPosted += retryResult.commentsPosted;

            if (retryResult.errors.length > 0) {
              allErrors.push(...retryResult.errors.map((e) => `Retry "${group.groupName}": ${e}`));
            }
          } catch (retryError: any) {
            console.error(`[CodeReview] Retry failed for group "${group.groupName}":`, retryError);
            allErrors.push(`Retry failed for "${group.groupName}": ${retryError.message}`);
          }
        } else {
          allErrors.push(`Group "${group.groupName}" failed: ${error.message}`);
        }
      }
    }

    return { commentsPosted: totalCommentsPosted, errors: allErrors };
  }

  // ==================== Diff 行数统计方法 ====================

  /**
   * 统计 Diff 中的变更行数（新增 + 删除）
   */
  private countDiffLines(diffContent: string): DiffLineCount {
    let addedLines = 0;
    let removedLines = 0;

    const lines = diffContent.split("\n");
    for (const line of lines) {
      if (line.startsWith("+") && !line.startsWith("+++")) {
        addedLines++;
      } else if (line.startsWith("-") && !line.startsWith("---")) {
        removedLines++;
      }
    }

    return {
      addedLines,
      removedLines,
      totalChangedLines: addedLines + removedLines,
    };
  }

  // ==================== AI 分组请求方法 ====================

  /**
   * 请求 AI 对大文件进行智能分组
   */
  private async requestAIGrouping(
    openai: OpenAI,
    largeFileInfos: LargeFileInfo[],
  ): Promise<AIFileGroupingResult["groups"]> {
    const fileSummary = largeFileInfos
      .map(
        (info) =>
          `文件: ${info.filePath}, 新增: ${info.addedLines} 行, 删除: ${info.removedLines} 行`,
      )
      .join("\n");

    const prompt = `我有以下大文件的变更信息，请根据文件的相关性和功能模块将它们分成若干个逻辑组。每组的目标是总变更行数尽量控制在 2000 行以内（如果单个文件本身就超过2000行则单独一组）。

文件列表：
${fileSummary}

请以 JSON 格式返回分组结果，格式如下：
{
  "groups": [
    {
      "groupName": "第一组名称",
      "files": ["file1.ts", "file2.ts"]
    },
    ...
  ]
}

注意：只返回 JSON，不要包含其他内容。`;

    try {
      const response = await openai.requestGrouping(prompt);

      // 尝试从响应中提取 JSON
      let jsonStr: string;

      // 尝试找到第一个 [ 到最后一个 } 之间的内容
      const firstBrace = response.indexOf("{");
      const lastBrace = response.lastIndexOf("}");

      if (firstBrace !== -1 && lastBrace !== -1) {
        jsonStr = response.substring(firstBrace, lastBrace + 1);
      } else {
        // 尝试直接解析整个响应为JSON
        try {
          JSON.parse(response);
          jsonStr = response;
        } catch {
          throw new Error("无法从 AI 响应中提取有效的 JSON");
        }
      }

      const parsed: AIFileGroupingResult = JSON.parse(jsonStr);
      console.log(`[CodeReview] AI suggested ${parsed.groups.length} groups for large files`);
      return parsed.groups;
    } catch (error) {
      console.error("[CodeReview] Failed to parse AI grouping response:", error);
      console.warn(`[CodeReview] Fallback: Putting all large files in one group`);

      // 如果AI分组失败，将所有大文件放在一个组中（作为兜底方案）
      return [
        {
          groupName: "All Large Files",
          files: largeFileInfos.map((info) => info.filePath),
        },
      ];
    }
  }

  // ==================== 文件组审查方法 ====================

  /**
   * 审查一组文件（将多个文件的diff内容一起发送给AI）
   */
  private async reviewFileGroup(
    openai: OpenAI,
    group: FileGroup,
    gitlab: GitLab,
  ): Promise<{ commentsPosted: number; errors: string[] }> {
    let commentsPosted = 0;
    const fileErrors: string[] = [];

    // 构建组内所有文件的diff内容，每个文件之间用分隔符隔开
    const groupDiffContent = group.files
      .map((file) => `=== ${file.filePath} ===\n${file.diffContent}\n`)
      .join("---END_OF_FILE---\n");

    console.log(
      `[CodeReview] Reviewing file group: "${group.groupName}" (${group.files.length} files, total ~${this.countGroupLines(group)} lines changed)`,
    );

    // 调用AI进行审查
    let suggestion = "";
    try {
      suggestion = await openai.reviewGroupChanges(groupDiffContent);
    } catch (error: any) {
      console.error(`[CodeReview] Failed to review group ${group.groupName}:`, error);
      throw new Error(`Failed to review group ${group.groupName}: ${error.message}`);
    }

    // 如果建议包含 "666"，表示没有问题需要反馈
    if (suggestion.includes("666")) {
      console.log(`[CodeReview] No issues found in group: "${group.groupName}"`);
      return { commentsPosted: 0, errors: [] };
    }

    // 解析AI返回的评论
    const validFilePaths = group.files.map((f) => f.filePath);
    const parsedComments = this.parseAiGroupComments(suggestion, validFilePaths);

    if (parsedComments.length === 0) {
      console.log(
        `[CodeReview] No specific comments could be parsed for group: "${group.groupName}"`,
      );
      return { commentsPosted: 0, errors: [] };
    }

    // 按行号发布评审意见（委托给统一方法）
    const result = await this.postCommentsWithFileContext(suggestion, group.files, gitlab);

    return { commentsPosted: result.commentsPosted, errors: result.errors };
  }

  /**
   * 统一的评论发布方法：根据解析后的评论和文件上下文发送评审意见到GitLab
   */
  private async postCommentsWithFileContext(
    suggestion: string,
    fileContexts: GroupFileInfo[],
    gitlab: GitLab,
  ): Promise<{ commentsPosted: number; errors: string[] }> {
    const validFilePaths = fileContexts.map((f) => f.filePath);
    const parsedComments = this.parseAiGroupComments(suggestion, validFilePaths);

    let commentsPosted = 0;
    const fileErrors: string[] = [];

    for (const comment of parsedComments) {
      try {
        let targetFile: any = null;
        let filePath = "";

        if (comment.filePath) {
          // 使用【文件:行号】格式指定的文件路径 - 精确匹配或后缀匹配
          for (const file of fileContexts) {
            if (file.filePath === comment.filePath || file.filePath.endsWith(comment.filePath)) {
              targetFile = file.change;
              filePath = file.filePath;
              break;
            }
          }
        } else {
          // 如果没有指定文件路径，且组内只有一个文件，则使用该文件
          if (fileContexts.length === 1) {
            filePath = fileContexts[0].filePath;
            targetFile = fileContexts[0].change;
          }
        }

        if (!targetFile || !filePath) {
          console.warn(
            `[CodeReview] Could not find file for comment: "${comment.filePath || "unknown"}"`,
          );
          continue;
        }

        const { lineNumber, lineType, codeContent } = comment;

        const lineObj = buildPositionForGitLab(lineNumber, lineType, targetFile, codeContent);

        console.log(
          `[CodeReview] Posting comment at old_line ${lineNumber} → position: ${JSON.stringify(lineObj)} (${lineType}) for file: ${filePath}`,
        );

        await gitlab.addReviewComment(lineObj as any, targetFile, comment.content);
        commentsPosted++;
      } catch (error: any) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.error(
          `[CodeReview] Failed to post comment at line ${comment.lineNumber} for file "${comment.filePath || "unknown"}":`,
          errorMsg,
        );
        fileErrors.push(
          `Failed to post comment at line ${comment.lineNumber} for file "${comment.filePath || "unknown"}": ${errorMsg}`,
        );
      }
    }

    return { commentsPosted, errors: fileErrors };
  }

  // ==================== 评论解析方法 ====================

  /**
   * 解析组审查时 AI 返回的评论。
   *
   * 新格式（推荐）：【文件路径:+/-行号:代码行内容】
   *   例如：【src/foo.java:+131:  List<Indicator> findByCodeIn(String[] codes);】
   * 旧格式（兼容）：【文件路径:+/-行号】
   *   例如：【src/foo.java:+131】
   *
   * + = 新增行, - = 删除行, 无符号 = 上下文行
   */
  private parseAiGroupComments(
    suggestion: string,
    validFilePaths: string[],
  ): ParsedComment[] {
    const comments: ParsedComment[] = [];

    // 先匹配新格式：【文件路径:行号:代码行内容】
    // match[1]=文件路径, match[2]=行号(含前缀), match[3]=代码行内容
    const newFormatRegex = /【([^】]+):\s*([+-]?\d+):\s*([^】]+)】/g;
    let match;

    while ((match = newFormatRegex.exec(suggestion)) !== null) {
      const filePathCandidate = match[1].trim();
      const rawLineNum = match[2];
      const codeContent = match[3].trim();
      const lineTypePrefix = rawLineNum.charAt(0);

      let lineNumber: number;
      let lineType: 'added' | 'removed' | 'context';

      if (lineTypePrefix === '+') {
        lineNumber = parseInt(rawLineNum.slice(1), 10);
        lineType = 'added';
      } else if (lineTypePrefix === '-') {
        lineNumber = parseInt(rawLineNum.slice(1), 10);
        lineType = 'removed';
      } else {
        lineNumber = parseInt(rawLineNum, 10);
        lineType = 'context';
      }

      if (isNaN(lineNumber) || lineNumber <= 0 || !filePathCandidate) {
        continue;
      }

      const contentStartIndex = newFormatRegex.lastIndex;
      const nextTagMatch = suggestion.substring(contentStartIndex).match(/【/);
      const contentEndIndex = nextTagMatch
        ? contentStartIndex + (nextTagMatch.index ?? 0)
        : suggestion.length;

      let rawContent = suggestion.substring(contentStartIndex, contentEndIndex).trim();

      if (!rawContent) {
        continue;
      }

      const isValidPath = validFilePaths.some(
        (fp) => fp === filePathCandidate || fp.endsWith(filePathCandidate),
      );

      if (isValidPath) {
        comments.push({
          filePath: filePathCandidate,
          lineNumber,
          lineType,
          codeContent: codeContent || undefined,
          content: rawContent,
        });
      } else {
        console.warn(`[CodeReview] Comment references unknown file path: "${filePathCandidate}"`);
      }
    }

    // 如果新格式匹配到结果就不再尝试旧格式
    if (comments.length > 0) return comments;

    // 向后兼容：旧格式【文件路径:行号】
    const oldFormatRegex = /【([^】]+):\s*([+-]?\d+)】/g;

    while ((match = oldFormatRegex.exec(suggestion)) !== null) {
      const filePathCandidate = match[1].trim();
      const rawLineNum = match[2];
      const lineTypePrefix = rawLineNum.charAt(0);

      let lineNumber: number;
      let lineType: 'added' | 'removed' | 'context';

      if (lineTypePrefix === '+') {
        lineNumber = parseInt(rawLineNum.slice(1), 10);
        lineType = 'added';
      } else if (lineTypePrefix === '-') {
        lineNumber = parseInt(rawLineNum.slice(1), 10);
        lineType = 'removed';
      } else {
        lineNumber = parseInt(rawLineNum, 10);
        lineType = 'context';
      }

      if (isNaN(lineNumber) || lineNumber <= 0 || !filePathCandidate) {
        continue;
      }

      const contentStartIndex = oldFormatRegex.lastIndex;
      const nextTagMatch = suggestion.substring(contentStartIndex).match(/【/);
      const contentEndIndex = nextTagMatch
        ? contentStartIndex + (nextTagMatch.index ?? 0)
        : suggestion.length;

      let rawContent = suggestion.substring(contentStartIndex, contentEndIndex).trim();

      if (!rawContent) {
        continue;
      }

      const isValidPath = validFilePaths.some(
        (fp) => fp === filePathCandidate || fp.endsWith(filePathCandidate),
      );

      if (isValidPath) {
        comments.push({
          filePath: filePathCandidate,
          lineNumber,
          lineType,
          content: rawContent,
        });
      } else {
        console.warn(`[CodeReview] Comment references unknown file path: "${filePathCandidate}"`);
      }
    }

    // 向后兼容：如果没有带文件路径的评论，尝试只匹配【行号】格式（视为 context）
    if (comments.length === 0) {
      const lineOnlyRegex = /【(\d+)】\s*([\s\S]*?)(?=【\d+】|$)/g;
      let match2;

      while ((match2 = lineOnlyRegex.exec(suggestion)) !== null) {
        const lineNumber = parseInt(match2[1], 10);
        const content = match2[2].trim();

        if (!isNaN(lineNumber) && lineNumber > 0 && content.length > 0) {
          comments.push({ filePath: undefined, lineNumber, lineType: 'context', content });
        }
      }
    }

    return comments;
  }

  /**
   * 统计文件组总变更行数（用于日志）
   */
  private countGroupLines(group: FileGroup): number {
    return group.files.reduce((total, file) => total + file.addedLines + file.removedLines, 0);
  }

  // ==================== 辅助方法 ====================

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

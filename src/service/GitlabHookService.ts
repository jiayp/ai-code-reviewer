import { CodeReviewService } from "./CodeReviewService";
import { Config } from "../config";

/**
 * GitLab Webhook Event Data Interfaces
 */
export interface GitlabMergeRequestEventData {
  object_kind: "merge_request";
  event_type: "merge_request";
  user: { name: string; email?: string };
  project: {
    id: number;
    name: string;
    description: string;
    web_url: string;
    avatar_url?: string;
    git_ssh_url: string;
    git_http_url: string;
    namespace: string;
    visibility_level: number;
    path_with_namespace: string;
    default_branch: string;
    ci_config_path?: string;
    hidden_ci_pipelines?: boolean;
    archived?: boolean;
    created_at: string;
    last_activity_at: string;
    creator_id?: number;
    shared_runners_enabled: boolean;
    runner_token_version?: string;
  };
  object_attributes: {
    id: number;
    title: string;
    description: string;
    created_at: string;
    updated_at: string;
    updated_by?: any;
    state: "opened" | "merged" | "closed";
    merged_by?: any;
    merged_at?: string;
    closed_by?: any;
    closed_at?: string;
    target_branch: string;
    source_branch: string;
    user_notes_count: number;
    draft: boolean;
    assigns: Array<{
      id: number;
      name: string;
      username: string;
      avatar_url?: string;
    }>;
    assignees: Array<{
      id: number;
      name: string;
      username: string;
      avatar_url?: string;
    }>;
    reviewers: Array<{
      id: number;
      name: string;
      username: string;
      avatar_url?: string;
    }>;
    author_id: number;
    merge_status: "checking" | "can_be_merged" | "cannot_be_merged"; // 兼容旧字段
    merged_by_iid?: any;
    merged_by_user_id?: any;
    target_project_id: number;
    source_project_id: number;
    time_estimate: number;
    total_time_spent: number;
    human_total_time_spent?: string;
    human_time_estimate?: string;
    iid?: number; // Merge Request IID (visible ID) - optional in some webhook versions
    web_url: string;
    diff_refs: {
      base_sha: string;
      head_sha: string;
      start_sha: string;
    };
    last_edited_at?: any;
    last_edited_by_id?: any;
    _links: {
      self: string;
      notes: string;
      closure_events: string;
    };
  };
  labels: Array<any>[];
  changes: {
    [key: string]: {
      previous?: any;
      current?: any;
    };
  };
}

/**
 * GitlabHookService - 处理 GitLab Webhook 事件并触发代码审查
 */
export class GitlabHookService {
  private codeReviewService: CodeReviewService;

  constructor(
    private config: Config,
    secretToken?: string,
  ) {
    this.codeReviewService = new CodeReviewService(config);
  }

  /**
   * 处理来自 GitLab 的 Webhook 请求
   * @param body Webhook payload 原始 JSON 字符串或对象
   * @returns 审查结果摘要
   */
  async handleWebhook(
    body: any,
  ): Promise<{ success: boolean; message: string }> {
    try {
      // 验证事件类型
      if (body.object_kind !== "merge_request") {
        console.log(
          "[Hook] Ignoring non-merge-request event:",
          body.object_kind,
        );
        return { success: false, message: "Not a merge request event" };
      }

      const event = body as unknown as GitlabMergeRequestEventData;
      const mrData = event.object_attributes;
      const projectId = event.project.id;
      // Use iid from object_attributes if available, otherwise fallback to id
      const mergeRequestId = String(mrData.iid || mrData.id);

      console.log("[Hook] Received MR event:", {
        action: this.detectAction(event),
        projectId,
        mergeRequestId,
        state: mrData.state,
        title: mrData.title,
        authorId: mrData.author_id,
        assigns: mrData.assigns,
      });

      // 只处理 assignee 初次赋值的事件
      const action = this.detectAction(event);

      if (action !== "assign") {
        console.log("[Hook] Ignoring event:", action);
        return { success: false, message: `Not an assign event (${action})` };
      }

      // 检查 MR 状态是否为打开（只有打开的 MR 才需要审查）
      if (mrData.state !== "opened") {
        console.log("[Hook] MR is not open:", mrData.state);
        return {
          success: false,
          message: `MR state is ${mrData.state}, skipping review`,
        };
      }

      // 检查是否有 assignee（assignees 数组非空）
      const hasAssignee = (mrData.assigns || mrData.assignees).length > 0;
      if (!hasAssignee) {
        console.log("[Hook] No assignee detected");
        return { success: false, message: "No assignee in MR" };
      }

      // 执行代码审查
      console.log(
        `[Hook] Triggering code review for project ${projectId}, MR #${mergeRequestId}`,
      );

      const summary = await this.codeReviewService.reviewMergeRequest(
        projectId,
        mergeRequestId,
      );

      if (summary.totalErrors === 0) {
        return {
          success: true,
          message: `Code review completed successfully for MR #${mergeRequestId}`,
        };
      } else {
        return {
          success: false,
          message: `Code review finished with some failures for MR #${mergeRequestId} (${summary.totalErrors} errors)`,
        };
      }
    } catch (error) {
      console.error("[Hook] Error processing webhook:", error);
      return {
        success: false,
        message: `Webhook processing failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * 检测 MR 事件的具体动作类型
   */
  private detectAction(event: GitlabMergeRequestEventData): string {
    // 优先检查 changes 对象（GitLab 会在 event 中提供变更字段）
    const changes = event.changes;
    if (changes && typeof changes === "object") {
      // assignee 在 object_attributes.assignees 或 assigns 数组中出现/变化时触发
      if (
        changes.assignees ||
        changes.assignees_prev ||
        changes.assignees_after
      ) {
        return "assign";
      }

      // GitLab webhook payload 格式中，assignees 字段在第一次赋值时会从 null -> [] 或者 [] -> [{...}]
      const assignsCurrent = event.object_attributes.assigns;
      if (Array.isArray(assignsCurrent) && assignsCurrent.length > 0) {
        // 如果 changes.assignees_previous 或 assignees_before 是空数组/null，而当前非空
        let previousAssignees: any;

        if (changes.assignees && "previous" in changes.assignees) {
          previousAssignees = (changes as any).assignees.previous;
        } else if (
          (changes as any).assignees_after &&
          "previous" in (changes as any).assignees_after
        ) {
          previousAssignees = (changes as any).assignees_after.previous;
        }

        if (!previousAssignees || JSON.stringify(previousAssignees) === "[]") {
          return "assign"; // 初次赋值
        }
      }
    }

    // fallback: 如果 object_kind 是 merge_request，直接返回 assign 让主流程处理
    // （实际生产中应依赖 changes.assignees 精确判断）
    if (event.object_attributes.state === "opened") {
      return "assign";
    }

    return "unknown";
  }

  /**
   * 健康检查端点
   */
  healthCheck(): boolean {
    return true;
  }
}

export default GitlabHookService;

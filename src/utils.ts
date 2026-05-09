import { loadConfig, Config } from "./config";

const config: Config = loadConfig();

export const fullContent = {
  role: "user",
  content: config.prompts.fullContent,
};

export const systemContent = {
  role: "system",
  content: config.prompts.systemContent,
};

export const suggestContent = {
  role: "user",
  content: config.prompts.suggestContent,
};

export const openAiCompletionsConfig = {
  temperature: config.openai.temperature,
  model: config.openai.model,
  stream: config.openai.stream,
};

export const delay = (time: number) => {
  return new Promise((resolve) => setTimeout(resolve, time));
};

export const getDiffBlocks = (diff: string) => {
  const regex = /(?=@@\s-\d+(?:,\d+)?\s\+\d+(?:,\d+)?\s@@)/g;
  const diffBlocks: string[] = diff.split(regex);
  return diffBlocks;
};

// ==================== Diff Hunk Header 解析 ====================

/**
 * 表示一个 diff hunk 的偏移量信息
 */
export interface HunkOffset {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
}

/**
 * 从 diff hunk header（如 @@ -10,5 +16,3 @@）中提取偏移量信息
 */
export function parseHunkHeader(hunkHeader: string): HunkOffset | null {
  const regex = /@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s*@@/;
  const match = hunkHeader.match(regex);

  if (!match) return null;

  const oldStart = parseInt(match[1], 10);
  const oldLines = match[2] ? parseInt(match[2], 10) : 1;
  const newStart = parseInt(match[3], 10);
  const newLines = match[4] ? parseInt(match[4], 10) : 1;

  return {
    oldStart,
    oldLines: isNaN(oldLines) || oldLines < 0 ? 0 : oldLines,
    newStart,
    newLines: isNaN(newLines) || newLines < 0 ? 0 : newLines,
  };
}

/**
 * 从完整的 diff 字符串中解析出所有 hunk header 偏移量信息
 */
export function parseAllHunkHeaders(diffContent: string): HunkOffset[] {
  const offsets: HunkOffset[] = [];

  for (const block of getDiffBlocks(diffContent)) {
    const lines = block.split("\n");
    for (const line of lines) {
      if (line.startsWith("@@") && line.includes("@@")) {
        const offset = parseHunkHeader(line);
        if (offset) offsets.push(offset);
        break;
      }
    }
  }

  return offsets;
}

/**
 * 获取文件 diff 中所有上下文/删除行对应的旧行号范围（用于 - 和 context 类型验证）
 */
export function getOldLineRanges(change: Record<string, any>): Array<[number, number]> {
  if (!change?.diff) return [];

  const ranges: Array<[number, number]> = [];
  let oldCounter: number | null = null;

  for (const line of change.diff.split("\n")) {
    if (line.startsWith("@@") && line.includes("@@")) {
      const offset = parseHunkHeader(line);
      oldCounter = offset ? offset.oldStart - 1 : null;
      continue;
    }

    if (!line || line.startsWith("\\") || line[0] === "+") continue;

    if (oldCounter === null) continue;

    const currentNum = oldCounter + 1;
    oldCounter = currentNum;

    if (ranges.length === 0 || ranges[ranges.length - 1][1] + 1 < currentNum) {
      ranges.push([currentNum, currentNum]);
    } else {
      ranges[ranges.length - 1][1] = currentNum;
    }
  }

  return ranges;
}

/**
 * 获取文件中所有新增行（+ 开头的行）对应的新行号范围。
 * 计数器与 buildOldToNewMapping 一致，从 newStart-1 开始递增。
 */
export function getAddedOnlyNewLineRanges(change: Record<string, any>): Array<[number, number]> {
  if (!change?.diff) return [];

  const ranges: Array<[number, number]> = [];
  let oldCounter: number | null = null;
  let newCounter: number | null = null;

  for (const line of change.diff.split("\n")) {
    if (line.startsWith("@@") && line.includes("@@")) {
      const offset = parseHunkHeader(line);
      if (offset) {
        oldCounter = offset.oldStart - 1;
        newCounter = offset.newStart - 1;
      } else {
        oldCounter = null;
        newCounter = null;
      }
      continue;
    }

    if (!line || line.startsWith("\\")) continue;

    const isFirstCharPlus = line[0] === "+";
    const isFirstCharMinus = line[0] === "-";

    if (isFirstCharPlus) {
      if (newCounter !== null) {
        newCounter++;
        const currentNum: number = newCounter;
        if (ranges.length === 0 || ranges[ranges.length - 1][1] + 1 < currentNum) {
          ranges.push([currentNum, currentNum]);
        } else {
          ranges[ranges.length - 1][1] = currentNum;
        }
      }
    } else if (isFirstCharMinus) {
      if (oldCounter !== null) {
        oldCounter++;
      }
    } else {
      if (oldCounter !== null && newCounter !== null) {
        const oldLineNum: number = oldCounter + 1;
        const newLineNum: number = newCounter + 1;
        oldCounter = oldLineNum;
        newCounter = newLineNum;
      }
    }
  }

  return ranges;
}

/**
 * 判断给定的行号是否在任意一个范围内
 */
function isWithinAnyRange(lineNum: number, ranges: Array<[number, number]>): boolean {
  for (const [start, end] of ranges) {
    if (lineNum >= start && lineNum <= end) return true;
  }
  return false;
}

/**
 * 将行号校正到最近的修改范围内
 */
function snapToNearestRange(
  lineNumber: number,
  minLine: number,
  maxLine: number,
): number | null {
  if (minLine > maxLine || maxLine < 0) return null;

  if (lineNumber < minLine) return minLine;
  else if (lineNumber > maxLine) return maxLine;
  return lineNumber;
}

/**
 * 表示 diff 中每一行的结构化信息
 */
export interface DiffLineEntry {
  oldLine: number;
  newLine: number;
  content: string;
  type: "context" | "added" | "removed";
}

/**
 * 构建 diff 行索引：遍历 diff 中所有行，为每行建立 oldLine/newLine/content/type 记录。
 * 计数器逻辑与 buildOldToNewMapping / buildNewToOldMapping 完全一致。
 */
export function buildDiffLineIndex(change: Record<string, any>): DiffLineEntry[] {
  const entries: DiffLineEntry[] = [];

  if (!change?.diff) return entries;

  let oldCounter: number | null = null;
  let newCounter: number | null = null;

  for (const line of change.diff.split("\n")) {
    if (line.startsWith("@@") && line.includes("@@")) {
      const offset = parseHunkHeader(line);
      if (offset) {
        oldCounter = offset.oldStart - 1;
        newCounter = offset.newStart - 1;
      } else {
        oldCounter = null;
        newCounter = null;
      }
      continue;
    }

    if (!line || line.startsWith("\\")) continue;

    const isFirstCharPlus = line[0] === "+";
    const isFirstCharMinus = line[0] === "-";

    if (isFirstCharPlus) {
      newCounter = (newCounter ?? -1) + 1;
      if (oldCounter === null) continue;
      entries.push({
        oldLine: -1,
        newLine: newCounter,
        content: line.substring(1),
        type: "added",
      });
    } else if (isFirstCharMinus) {
      if (oldCounter === null) continue;
      oldCounter = oldCounter + 1;
      entries.push({
        oldLine: oldCounter,
        newLine: -1,
        content: line.substring(1),
        type: "removed",
      });
    } else {
      if (oldCounter === null || newCounter === null) continue;
      const oldLineNum: number = oldCounter + 1;
      const newLineNum: number = newCounter + 1;

      entries.push({
        oldLine: oldLineNum,
        newLine: newLineNum,
        content: line.length > 0 ? line.substring(1) : "",
        type: "context",
      });
      oldCounter = oldLineNum;
      newCounter = newLineNum;
    }
  }

  return entries;
}

/** 内容定位结果来源 */
export type LocateSource = "exact" | "normalized" | "multi-norm" | "fallback";

/** 内容定位结果 */
export interface LocateResult {
  lineNumber: number;
  oldLine: number;
  newLine: number;
  source: LocateSource;
  lineType: "added" | "removed" | "context";
}

/**
 * 根据代码行内容在 diff 中定位准确的 oldLine 和 newLine。
 *
 * 三级策略：
 *   1. exact      — 精确匹配，仅在 AI 声明的 lineType 对应条目中搜索
 *   2. normalized — trim 后匹配（处理 AI 多余空格），同样限 lineType
 *   3. multi-norm — 放宽 lineType 限制，在全部条目中 trim 匹配
 *   4. fallback   — 回到 correctLineNumber 行号修正
 *
 * 歧义处理：多个候选时取离 aiHintLine 最近的那个。
 */
export function locateLineByContent(
  targetContent: string,
  aiHintLine: number,
  lineType: "added" | "removed" | "context",
  change: Record<string, any>,
): LocateResult | null {
  const entries = buildDiffLineIndex(change);
  if (entries.length === 0) return null;

  const t = targetContent;

  function bestOf(candidates: DiffLineEntry[], source: LocateSource): LocateResult | null {
    if (candidates.length === 0) return null;
    if (candidates.length === 1) {
      const c = candidates[0];
      return {
        lineNumber: lineType === "removed" ? c.oldLine : c.newLine,
        oldLine: c.oldLine,
        newLine: c.newLine,
        source,
        lineType: c.type,
      };
    }
    let best = candidates[0];
    let bestDist = Math.abs(
      (lineType === "removed" ? best.oldLine : best.newLine) - aiHintLine,
    );
    for (let i = 1; i < candidates.length; i++) {
      const dist = Math.abs(
        (lineType === "removed" ? candidates[i].oldLine : candidates[i].newLine) - aiHintLine,
      );
      if (dist < bestDist) {
        best = candidates[i];
        bestDist = dist;
      }
    }
    return {
      lineNumber: lineType === "removed" ? best.oldLine : best.newLine,
      oldLine: best.oldLine,
      newLine: best.newLine,
      source,
      lineType: best.type,
    };
  }

  if (!t) return null;

  // Level 1: exact match within declared lineType
  const exact = entries.filter((e) => e.type === lineType && e.content === t);
  const r1 = bestOf(exact, "exact");
  if (r1) return r1;

  // Level 2: normalized match within declared lineType
  const normT = t.trim();
  const normalized = entries.filter((e) => e.type === lineType && e.content.trim() === normT);
  const r2 = bestOf(normalized, "normalized");
  if (r2) return r2;

  // Level 3: normalized match across all types (wider search)
  const multi = entries.filter((e) => e.content.trim() === normT);
  const r3 = bestOf(multi, "multi-norm");
  if (r3) return r3;

  // Level 4: fallback
  return null;
}

/**
 * 根据 diff 内容构建旧行号到新行号的映射表。
 *
 * 计数器逻辑：从 hunk header 的 oldStart-1 / newStart-1 开始，遍历每一行：
 *   - + 行 → 只递增 newCounter（新增行只存在于新文件）
 *   - - 行 → mapping[old] = undefined, 递增 oldCounter（删除行只存在于旧文件）
 *   - 上下文行 → mapping[oldNum] = newNum, 同时递增两个 counter
 */
export function buildOldToNewMapping(
  change: Record<string, any>,
): { [oldLine: number]: number | undefined } {
  const mapping: { [oldLine: number]: number | undefined } = {};

  if (!change?.diff) return mapping;

  let oldCounter: number | null = null;
  let newCounter: number | null = null;

  for (const line of change.diff.split("\n")) {
    if (line.startsWith("@@") && line.includes("@@")) {
      const offset = parseHunkHeader(line);
      if (offset) {
        oldCounter = offset.oldStart - 1;
        newCounter = offset.newStart - 1;
      } else {
        oldCounter = null;
        newCounter = null;
      }
      continue;
    }

    if (!line || line.startsWith("\\")) continue;

    const isFirstCharPlus = line[0] === "+";
    const isFirstCharMinus = line[0] === "-";

    if (isFirstCharPlus) {
      // 新增行：只存在于新文件，递增 newCounter
      newCounter = (newCounter ?? -1) + 1;
    } else if (isFirstCharMinus) {
      // 删除行：只存在于旧文件，没有新行号映射。先记录再更新 counter
      if (oldCounter !== null) {
        const oldNum = oldCounter + 1;
        mapping[oldNum] = undefined;
        oldCounter = oldNum;
      }
    } else {
      // 上下文行：同时计入旧文件和新文件，映射并更新两个 counter
      if (oldCounter !== null && newCounter !== null) {
        const oldLineNum: number = oldCounter + 1;
        const newLineNum: number = newCounter + 1;

        mapping[oldLineNum] = newLineNum;
        oldCounter = oldLineNum;
        newCounter = newLineNum;
      }
    }
  }

  return mapping;
}

/**
 * 构建新行号到旧行号的逆向映射表（用于 AI 返回新文件行号时反查旧行号）。
 * 与 buildOldToNewMapping 计数逻辑一致，仅登记上下文行（不含新增/删除行）。
 */
export function buildNewToOldMapping(
  change: Record<string, any>,
): { [newLine: number]: number | undefined } {
  const mapping: { [newLine: number]: number | undefined } = {};

  if (!change?.diff) return mapping;

  let oldCounter: number | null = null;
  let newCounter: number | null = null;

  for (const line of change.diff.split("\n")) {
    if (line.startsWith("@@") && line.includes("@@")) {
      const offset = parseHunkHeader(line);
      if (offset) {
        oldCounter = offset.oldStart - 1;
        newCounter = offset.newStart - 1;
      } else {
        oldCounter = null;
        newCounter = null;
      }
      continue;
    }

    if (!line || line.startsWith("\\")) continue;

    const isFirstCharPlus = line[0] === "+";
    const isFirstCharMinus = line[0] === "-";

    if (isFirstCharPlus) {
      newCounter = (newCounter ?? -1) + 1;
    } else if (isFirstCharMinus) {
      if (oldCounter !== null) {
        oldCounter = oldCounter + 1;
      }
    } else {
      if (oldCounter !== null && newCounter !== null) {
        const oldLineNum: number = oldCounter + 1;
        const newLineNum: number = newCounter + 1;

        mapping[newLineNum] = oldLineNum;
        oldCounter = oldLineNum;
        newCounter = newLineNum;
      }
    }
  }

  return mapping;
}

/**
 * 校正 AI 返回的行号，使其适应修改后文件的行号空间。
 *
 * 规则：
 *   removed（删除行）→ AI 返回的是 old_line，直接使用；超出范围则 snapToNearestRange
 *   added（新增行） → AI 可能返回了旧文件行号而非新文件行号，需要转换
 */
export function correctLineNumber(
  oldLineNumber: number,
  lineType: "added" | "removed",
  change: Record<string, any>,
): { lineNumber: number; corrected: boolean } {
  if (!change || !change.diff) {
    return { lineNumber: oldLineNumber, corrected: false };
  }

  const oldLineRanges = getOldLineRanges(change);
  const addedLineRanges = getAddedOnlyNewLineRanges(change);
  const mapping = buildOldToNewMapping(change);

  // 计算范围边界
  let minOldLine = Infinity;
  let maxOldLine = -Infinity;
  let minAddedLine = Infinity;
  let maxAddedLine = -Infinity;

  for (const [start, end] of oldLineRanges) {
    if (start < minOldLine) minOldLine = start;
    if (end > maxOldLine) maxOldLine = end;
  }
  for (const [start, end] of addedLineRanges) {
    if (start < minAddedLine) minAddedLine = start;
    if (end > maxAddedLine) maxAddedLine = end;
  }

  // === removed（删除行）→ AI 返回的是 old_line，直接使用 ===
  if (lineType === "removed") {
    let finalLine = oldLineNumber;
    const inRange = isWithinAnyRange(oldLineNumber, oldLineRanges);

    if (!inRange && minOldLine <= maxOldLine) {
      const snapped = snapToNearestRange(oldLineNumber, minOldLine, maxOldLine);
      if (snapped !== null) finalLine = snapped;
      else return { lineNumber: oldLineNumber, corrected: false };
    }

    return { lineNumber: finalLine, corrected: finalLine !== oldLineNumber };
  }

  // === added（新增行）→ AI 可能返回了旧文件行号而非新文件行号 ===
  if (lineType === "added") {
    let newLineNum = oldLineNumber;
    let wasCorrected = false;

    const inOldRange = isWithinAnyRange(oldLineNumber, oldLineRanges);
    const inAddedRange = isWithinAnyRange(oldLineNumber, addedLineRanges);

    if (inOldRange && !inAddedRange) {
      // AI 返回了旧文件行号，需要转换为新行号
      wasCorrected = true;
      const mappedNew = mapping[oldLineNumber];
      if (mappedNew !== undefined && mappedNew > 0) {
        // mapping 成功：直接使用映射后的行号
        // 如果映射后的新行号也在 addedLineRanges 中，说明这一行确实是新增行（旧→内容改变）
        // 如果不在 addedLineRanges 中，说明 AI 类型标记错误（原行就是上下文/未变行）
        // 无论哪种情况，都信任 mapping 的结果，不 snap 到 addedLineRanges
        newLineNum = mappedNew;
      } else {
        // 找不到映射：snap 到最近范围
        let snapped: number | null = null;
        if (minOldLine <= maxOldLine) {
          const s1 = snapToNearestRange(oldLineNumber, minOldLine, maxOldLine);
          if (s1 !== null) snapped = s1;
        }
        if (snapped === null && minAddedLine <= maxAddedLine) {
          const s2 = snapToNearestRange(oldLineNumber, minAddedLine, maxAddedLine);
          if (s2 !== null) snapped = s2;
        }
        if (snapped !== null && snapped > 0) {
          newLineNum = snapped;
          wasCorrected = true;
        } else if (minOldLine <= maxOldLine) {
          const sn3 = snapToNearestRange(oldLineNumber, minOldLine, maxOldLine);
          if (sn3 !== null && sn3 > 0) {
            newLineNum = sn3;
            wasCorrected = true;
          }
        }
      }
    } else if (!inOldRange && inAddedRange) {
      // AI 已经返回了新行号，直接使用
      newLineNum = oldLineNumber;
      wasCorrected = false;
    }

    // 如果两个范围都不在 → snap 到最近的修改范围
    if (!inOldRange && !inAddedRange) {
      let snapped: number | null = null;

      if (minAddedLine <= maxAddedLine) {
        snapped = snapToNearestRange(oldLineNumber, minAddedLine, maxAddedLine);
      }

      if (snapped === null && minOldLine <= maxOldLine) {
        snapped = snapToNearestRange(oldLineNumber, minOldLine, maxOldLine);
      }

      if (snapped !== null && snapped > 0) {
        newLineNum = snapped;
        wasCorrected = true;
      } else {
        return { lineNumber: oldLineNumber, corrected: false };
      }
    }

    return { lineNumber: newLineNum, corrected: wasCorrected };
  }

  // === 兜底：未识别的类型 → 原样返回 ===
  return { lineNumber: oldLineNumber, corrected: false };
}

/**
 * 主入口：对单个评论进行行号校正并返回用于 GitLab API 的 position 对象。
 *
 * @param oldLineNumber AI 返回的行号提示
 * @param lineType       AI 声明的行类型
 * @param change         GitLab change 对象
 * @param codeContent    可选的代码行内容（用于 content-based 定位）
 */
export function buildPositionForGitLab(
  oldLineNumber: number,
  lineType: "added" | "removed" | "context",
  change: Record<string, any>,
  codeContent?: string,
): { new_line?: number; old_line?: number } {
  // === 有 codeContent：优先使用 content-based 定位 ===
  if (codeContent && codeContent.trim().length > 0) {
    const located = locateLineByContent(codeContent, oldLineNumber, lineType, change);

    if (located && located.source !== "fallback") {
      console.log(
        `[Position] Content-based locate: ${located.source} match, ` +
        `old=${located.oldLine} new=${located.newLine} (hint=${oldLineNumber}, type=${lineType})`,
      );

      // 构建 position：根据定位后的实际 lineType 决定
      if (located.lineType === "context") {
        return { old_line: located.oldLine, new_line: located.newLine };
      } else if (located.lineType === "added") {
        return { new_line: located.newLine };
      } else {
        return { old_line: located.oldLine };
      }
    }
  }

  // === context（未改行）：直接通过映射表查找新行号，不走 correctLineNumber ===
  if (lineType === "context") {
    const mapping = buildOldToNewMapping(change);
    const newLine = mapping[oldLineNumber];

    if (newLine !== undefined && newLine > 0) {
      return { old_line: oldLineNumber, new_line: newLine };
    }

    const reverseMapping = buildNewToOldMapping(change);
    const oldLine = reverseMapping[oldLineNumber];

    if (oldLine !== undefined && oldLine > 0) {
      return { old_line: oldLine, new_line: oldLineNumber };
    }

    return { old_line: oldLineNumber, new_line: oldLineNumber };
  }

  // === removed / added：走 correctLineNumber 校正后返回 ===
  const corrected = correctLineNumber(oldLineNumber, lineType as "added" | "removed", change);

  switch (lineType) {
    case "added": {
      const oldLineRanges = getOldLineRanges(change);
      const addedLineRanges = getAddedOnlyNewLineRanges(change);
      const inOldRange = isWithinAnyRange(oldLineNumber, oldLineRanges);
      const inAddedRange = isWithinAnyRange(oldLineNumber, addedLineRanges);

      // 仅在「在 old 范围但不在 added 范围」时才加 old_line
      // 这种 case 是 AI 把 context 行误标为 added，GitLab 需要同时传 old_line 和 new_line
      // 如果同时在两个范围中（如 @@ -128,4 +128,6 @@ 的 +131），那就是纯新增行
      if (inOldRange && !inAddedRange) {
        return { old_line: oldLineNumber, new_line: corrected.lineNumber };
      }
      return { new_line: corrected.lineNumber };
    }
    case "removed": {
      return { old_line: corrected.lineNumber };
    }
    default: {
      const mapping = buildOldToNewMapping(change);
      let newLine = mapping[oldLineNumber];
      if (newLine !== undefined && newLine > 0) {
        return { old_line: corrected.lineNumber, new_line: newLine };
      } else {
        return { old_line: corrected.lineNumber, new_line: corrected.lineNumber };
      }
    }
  }
}

export const getLineObj = (matches: RegExpMatchArray, item: string) => {
  const lineObj: { new_line?: number; old_line?: number } = {};
  const lastLine = item.split(/\r?\n/)?.reverse()?.[1]?.trim();
  const oldLineStart = +matches[1];
  const oldLineEnd = +matches[2] || 0;
  const newLineStart = +matches[3];
  const newLineEnd = +matches[4] || 0;
  if (lastLine?.[0] === "+") {
    lineObj.new_line = newLineStart + newLineEnd - 1;
  } else if (lastLine?.[0] === "-") {
    lineObj.old_line = oldLineStart + oldLineEnd - 1;
  } else {
    lineObj.new_line = newLineStart + newLineEnd - 1;
    lineObj.old_line = oldLineStart + oldLineEnd - 1;
  }
  return lineObj;
};

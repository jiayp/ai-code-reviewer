/**
 * 行号映射、内容定位与校正的单元测试
 */
import {
  parseHunkHeader,
  getOldLineRanges,
  getAddedOnlyNewLineRanges,
  buildOldToNewMapping,
  buildNewToOldMapping,
  buildDiffLineIndex,
  locateLineByContent,
  correctLineNumber,
  buildPositionForGitLab,
} from "../utils";

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

function assertEqual(actual: any, expected: any, message: string) {
  totalTests++;
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    console.error("FAIL: " + message);
    console.error("  Expected: " + JSON.stringify(expected));
    console.error("  Actual:   " + JSON.stringify(actual));
    failedTests++;
    process.exitCode = 1;
  } else {
    console.log("PASS: " + message);
    passedTests++;
  }
}

function assertTrue(condition: boolean, message: string) {
  totalTests++;
  if (!condition) {
    console.error("FAIL: " + message);
    failedTests++;
    process.exitCode = 1;
  } else {
    console.log("PASS: " + message);
    passedTests++;
  }
}

function assertFalse(condition: boolean, message: string) {
  totalTests++;
  if (condition) {
    console.error("FAIL: " + message);
    failedTests++;
    process.exitCode = 1;
  } else {
    console.log("PASS: " + message);
    passedTests++;
  }
}

function assertUndefined(value: any, message: string) {
  totalTests++;
  if (value !== undefined) {
    console.error("FAIL: " + message);
    failedTests++;
    process.exitCode = 1;
  } else {
    console.log("PASS: " + message);
    passedTests++;
  }
}

function assertNotNull(value: any, message: string) {
  totalTests++;
  if (value === null || value === undefined) {
    console.error("FAIL: " + message);
    console.error("  Value is null/undefined");
    failedTests++;
    process.exitCode = 1;
  } else {
    console.log("PASS: " + message);
    passedTests++;
  }
}

function makeChange(diff: string, newPath?: string): Record<string, any> {
  return { new_path: newPath || "test/file.ts", diff };
}

// ====================== Diff Fixtures ======================

// 1 hunk: context + removed + 2 added + context
const DIFF_1 = `@@ -5,7 +5,9 @@
 line4
-line5
+line5_new
+extra_line
 line6
 line7`;

// 2 hunks
const DIFF_2_HUNKS = `@@ -14,6 +14,8 @@
 context14
+added15
+added16
 context15
 context16

@@ -68,5 +68,7 @@
 line68
line69
line70
+newLine71
+newLine72`;

// Diff with full GitLab header lines
const DIFF_WITH_HEADER = `diff --git a/src/file.ts b/src/file.ts
index abc123..def456 100644
--- a/src/file.ts
+++ b/src/file.ts
@@ -68,5 +68,7 @@
 line68
line69
line70
+newLine71
+newLine72`;

// Context line miscategorized as "added" (+70)
const DIFF_CONTEXT_AS_ADDED = `@@ -68,7 +68,9 @@
 line68
 line69
 line70
 line71
 line72
+newLine73
+newLine74`;

// Off-by-2: 2 added lines shift context
const DIFF_OFF_BY_2 = `@@ -14,6 +14,8 @@
 context14
+added15
+added16
 context15
 context16`;

// Only removed
const DIFF_ONLY_REMOVED = `@@ -42,3 +42,0 @@
 context41
-line42
-line43
 context44`;

// Mixed: 2 removed then 2 added
const DIFF_MIXED = `@@ -42,4 +42,4 @@
 context41
-line42_old
-line43_old
+line42_new
+line43_new
 context44`;

// 131 regression: pure added line at end of file
// @@ -128,4 +128,6 @@ → oldStart=128, newStart=128
// old context (4 lines): 128,129,130,131
// added: 1 line at new=132
// old->new: {128→128, 129→129, 130→130, 131→131}
const DIFF_PURE_ADDED = `@@ -128,4 +128,6 @@
 public interface IndicatorRepository extends QueryDslRepository<Indicator> {
     BigInteger total = (BigInteger) queryCount.getSingleResult();
     return total.longValue();
   }
+  List<Indicator> findByCodeIn(String[] codes);
 }`;

// ====================== Tests ======================

// ---- Part A: Core mapping functions (regression) ----

console.log("\n===== A1: parseHunkHeader =====");
{
  const h = parseHunkHeader("@@ -5,7 +5,9 @@");
  assertEqual(h?.oldStart, 5, "oldStart=5");
  assertEqual(h?.oldLines, 7, "oldLines=7");
  assertEqual(h?.newStart, 5, "newStart=5");
  assertEqual(h?.newLines, 9, "newLines=9");
}

console.log("\n===== A2: buildOldToNewMapping DIFF_1 =====");
{
  const change = makeChange(DIFF_1);
  const mapping = buildOldToNewMapping(change);
  assertEqual(mapping[5], 5, "old=5 → new=5");
  assertUndefined(mapping[6], "old=6 (deleted)");
  assertEqual(mapping[7], 8, "old=7 → new=8 (shifted +2)");
  assertEqual(mapping[8], 9, "old=8 → new=9");
}

console.log("\n===== A3: getOldLineRanges DIFF_1 =====");
{
  const change = makeChange(DIFF_1);
  assertEqual(getOldLineRanges(change), [[5, 8]], "old ranges = [[5,8]]");
}

console.log("\n===== A4: getOldLineRanges no garbage from header =====");
{
  const change = makeChange(DIFF_WITH_HEADER);
  const ranges = getOldLineRanges(change);
  const noGarbage = ranges.every(([s]) => s > 0);
  assertTrue(noGarbage, "No garbage [0,N] range");
  assertEqual(ranges, [[68, 70]], "old ranges = [[68,70]]");
}

console.log("\n===== A5: correctLineNumber 'added' — valid added =====");
{
  const change = makeChange(DIFF_1);
  const r6 = correctLineNumber(6, "added", change);
  assertEqual(r6.lineNumber, 6, "+6 = 6");
  assertFalse(r6.corrected, "not corrected");
}

console.log("\n===== A6: correctLineNumber 'added' — +70 is context → NOT snap =====");
{
  const change = makeChange(DIFF_CONTEXT_AS_ADDED);
  const corrected = correctLineNumber(70, "added", change);
  assertEqual(corrected.lineNumber, 70, "+70 context → 70, NOT snap to 73");
  assertTrue(corrected.corrected, "flagged as corrected");
}

console.log("\n===== A7: correctLineNumber 'added' — out of range → snap =====");
{
  const change = makeChange(DIFF_CONTEXT_AS_ADDED);
  const r = correctLineNumber(999, "added", change);
  assertEqual(r.lineNumber, 74, "snap to max added (74)");
  assertTrue(r.corrected, "corrected");

  const r2 = correctLineNumber(1, "added", change);
  assertEqual(r2.lineNumber, 73, "snap to min added (73)");
}

console.log("\n===== A8: correctLineNumber 'removed' =====");
{
  const change = makeChange(DIFF_1);
  const r = correctLineNumber(6, "removed", change);
  assertEqual(r.lineNumber, 6, "-6 (valid) = 6");
  assertFalse(r.corrected, "not corrected");

  const r2 = correctLineNumber(999, "removed", change);
  assertEqual(r2.lineNumber, 8, "-999 snaps to max old (8)");
}

console.log("\n===== A9: buildPositionForGitLab 'context' =====");
{
  const change = makeChange(DIFF_1);
  const pos5 = buildPositionForGitLab(5, "context", change);
  assertEqual(pos5, { old_line: 5, new_line: 5 }, "context old=5 → (5,5)");

  const pos7 = buildPositionForGitLab(7, "context", change);
  assertEqual(pos7, { old_line: 7, new_line: 8 }, "context old=7 → (7,8)");
}

console.log("\n===== A10: buildPositionForGitLab 'context' — AI returns NEW line number =====");
{
  const change = makeChange(DIFF_OFF_BY_2);
  const pos = buildPositionForGitLab(17, "context", change);
  assertEqual(pos, { old_line: 15, new_line: 17 }, "reverse-map: new=17 → old=15");
}

console.log("\n===== A11: buildPositionForGitLab 'removed' =====");
{
  const change = makeChange(DIFF_1);
  const pos = buildPositionForGitLab(6, "removed", change);
  assertEqual(pos, { old_line: 6 }, "removed: {old_line:6}");
  assertUndefined(pos.new_line, "removed: no new_line");
}

// ---- Part B: buildDiffLineIndex ----

console.log("\n===== B1: buildDiffLineIndex DIFF_1 =====");
{
  const change = makeChange(DIFF_1);
  const idx = buildDiffLineIndex(change);

  assertEqual(idx.length, 6, "6 entries (2 context + 1 removed + 2 added + 1 context)");

  assertEqual(idx[0], { oldLine: 5, newLine: 5, content: "line4", type: "context" }, "ctx: line4");
  assertEqual(idx[1], { oldLine: 6, newLine: -1, content: "line5", type: "removed" }, "rem: line5");
  assertEqual(idx[2], { oldLine: -1, newLine: 6, content: "line5_new", type: "added" }, "add: line5_new");
  assertEqual(idx[3], { oldLine: -1, newLine: 7, content: "extra_line", type: "added" }, "add: extra_line");
  assertEqual(idx[4], { oldLine: 7, newLine: 8, content: "line6", type: "context" }, "ctx: line6 (shifted)");
}

console.log("\n===== B2: buildDiffLineIndex DIFF_MIXED =====");
{
  const change = makeChange(DIFF_MIXED);
  const idx = buildDiffLineIndex(change);

  // entries: context(41) + removed(42_old) + removed(43_old) + added(42_new) + added(43_new) + context(44)
  assertEqual(idx.length, 6, "6 entries");

  assertEqual(idx[0].type, "context", "entry 0 = context");
  assertEqual(idx[0].oldLine, 42, "ctx old=42");
  assertEqual(idx[0].newLine, 42, "ctx new=42");

  assertEqual(idx[1].type, "removed", "entry 1 = removed");
  assertEqual(idx[1].content, "line42_old", "removed content");

  assertEqual(idx[3].type, "added", "entry 3 = added");
  assertEqual(idx[3].newLine, 43, "added new=43");

  assertEqual(idx[5].type, "context", "entry 5 = context");
  assertEqual(idx[5].oldLine, 45, "ctx old=45");
  assertEqual(idx[5].newLine, 45, "ctx new=45");
}

console.log("\n===== B3: buildDiffLineIndex DIFF_2_HUNKS =====");
{
  const change = makeChange(DIFF_2_HUNKS);
  const idx = buildDiffLineIndex(change);

  // Hunk1: context(14) + added(15) + added(16) + context(15→17) + context(16→18)
  // Hunk2: context(68) + context(69) + context(70) + added(71) + added(72)
  assertEqual(idx.length, 10, "10 entries across 2 hunks");

  const h2ctx = idx.filter((e) => e.type === "context" && e.oldLine === 70);
  assertEqual(h2ctx.length, 1, "hunk2 old=70 context exists");
  assertEqual(h2ctx[0].newLine, 70, "hunk2 old=70 → new=70");
}

console.log("\n===== B4: buildDiffLineIndex DIFF_PURE_ADDED =====");
{
  const change = makeChange(DIFF_PURE_ADDED);
  const idx = buildDiffLineIndex(change);

  // entries: context(128)+context(129)+context(130)+context(131) + added(132)+context(133)
  // Hmm, let me verify... header: @@ -128,4 +128,6 @@
  // context128, context129, context130, context131, +added132, context133
  // Actually: newStart=128, so new lines start at 128.
  // context(lines in diff):
  //   " public interface..." → old=128, new=128
  //   "     BigInteger total..." → old=129, new=129
  //   "     return total..." → old=130, new=130
  //   "   }" → old=131, new=131
  // added:
  //   "+  List<Indicator>..." → new=132
  // context:
  //   " }" → old=132, new=133

  const added = idx.filter((e) => e.type === "added");
  assertEqual(added.length, 1, "1 added entry");
  assertEqual(added[0].newLine, 132, "added at new=132");
  assertTrue(added[0].oldLine === -1, "pure added: oldLine = -1");
  assertEqual(added[0].content.trim(), "List<Indicator> findByCodeIn(String[] codes);",
    "added content correct");
}

// ---- Part C: locateLineByContent ----

console.log("\n===== C1: locateLineByContent exact match =====");
{
  const change = makeChange(DIFF_1);

  // Search for the exact added line
  const r = locateLineByContent("line5_new", 6, "added", change);
  assertNotNull(r, "exact match found");
  assertEqual(r!.source, "exact", "source = exact");
  assertEqual(r!.newLine, 6, "newLine = 6");
  assertEqual(r!.lineType, "added", "type = added");
}

console.log("\n===== C2: locateLineByContent exact match for context =====");
{
  const change = makeChange(DIFF_1);

  const r = locateLineByContent("line6", 7, "context", change);
  assertNotNull(r, "context match found");
  assertEqual(r!.source, "exact", "source = exact");
  assertEqual(r!.oldLine, 7, "oldLine = 7");
  assertEqual(r!.newLine, 8, "newLine = 8 (shifted)");
}

console.log("\n===== C3: locateLineByContent exact match for removed =====");
{
  const change = makeChange(DIFF_1);

  const r = locateLineByContent("line5", 6, "removed", change);
  assertNotNull(r, "removed match found");
  assertEqual(r!.source, "exact", "source = exact");
  assertEqual(r!.oldLine, 6, "oldLine = 6");
  assertEqual(r!.newLine, -1, "newLine = -1 (no new file)");
}

console.log("\n===== C4: locateLineByContent normalized match (AI adds spaces) =====");
{
  const change = makeChange(DIFF_1);

  const r = locateLineByContent("  line5_new  ", 6, "added", change);
  assertNotNull(r, "normalized match found");
  assertEqual(r!.source, "normalized", "source = normalized");
  assertEqual(r!.newLine, 6, "newLine = 6");
}

console.log("\n===== C5: locateLineByContent multi-norm (wrong type, right content) =====");
{
  const change = makeChange(DIFF_1);

  // AI says "context" but content matches an "added" line
  const r = locateLineByContent("line5_new", 6, "context", change);
  assertNotNull(r, "multi-norm match found");
  assertEqual(r!.source, "multi-norm", "source = multi-norm");
  assertEqual(r!.lineType, "added", "actual type = added");
  assertEqual(r!.newLine, 6, "newLine = 6");
}

console.log("\n===== C6: locateLineByContent not found → null =====");
{
  const change = makeChange(DIFF_1);

  const r = locateLineByContent("nonexistent_code", 42, "added", change);
  assertEqual(r, null, "not found returns null");
}

console.log("\n===== C7: locateLineByContent ambiguous — picks nearest aiHintLine =====");
{
  // Create diff with duplicate content
  const dupDiff = `@@ -10,5 +10,7 @@
 line10
+return x;
 line12
 line13
+return x;`;

  const change = makeChange(dupDiff);

  // Two "return x;" added lines at new=11 and new=14
  const r1 = locateLineByContent("return x;", 11, "added", change);
  assertNotNull(r1, "match found near 11");
  assertEqual(r1!.newLine, 11, "picks new=11 (closer to hint 11)");

  const r2 = locateLineByContent("return x;", 13, "added", change);
  assertNotNull(r2, "match found near 13");
  assertEqual(r2!.newLine, 14, "picks new=14 (closer to hint 13)");
}

// ---- Part D: buildPositionForGitLab with codeContent ----

console.log("\n===== D1: buildPositionForGitLab with codeContent — exact match =====");
{
  const change = makeChange(DIFF_1);

  const pos = buildPositionForGitLab(6, "added", change, "line5_new");
  assertEqual(pos, { new_line: 6 }, "content match → {new_line:6}");
}

console.log("\n===== D2: buildPositionForGitLab with codeContent — context match → both lines =====");
{
  const change = makeChange(DIFF_1);

  // Match context line 'line6' with AI hint 7
  const pos = buildPositionForGitLab(7, "context", change, "line6");
  assertEqual(pos, { old_line: 7, new_line: 8 }, "context content match → (7,8)");
}

console.log("\n===== D3: buildPositionForGitLab with codeContent — normalized fallback =====");
{
  const change = makeChange(DIFF_1);

  // AI returns content with extra spaces
  const pos = buildPositionForGitLab(6, "added", change, "  line5_new  ");
  assertEqual(pos, { new_line: 6 }, "normalized match → {new_line:6}");
}

console.log("\n===== D4: buildPositionForGitLab with codeContent — not found → line number fallback =====");
{
  const change = makeChange(DIFF_CONTEXT_AS_ADDED);

  // Content not in diff → falls back to line number correction
  const pos = buildPositionForGitLab(70, "added", change, "nonexistent");
  // With the bug fix: inOld && !inAdded → context correction
  assertEqual(pos.old_line, 70, "fallback: old_line=70");
  assertEqual(pos.new_line, 70, "fallback: new_line=70");
}

console.log("\n===== D5: buildPositionForGitLab with codeContent — mislabeled type corrected =====");
{
  const change = makeChange(DIFF_1);

  // AI says +5 but content matches context line 'line4'
  const pos = buildPositionForGitLab(5, "added", change, "line4");
  assertEqual(pos, { old_line: 5, new_line: 5 }, "multi-norm corrects type → context (5,5)");
}

// ---- Part E: 131 regression — pure added line NOT getting old_line ----

console.log("\n===== E1: 131 regression — AI wrong number, without content =====");
{
  const change = makeChange(DIFF_PURE_ADDED);

  console.log("old ranges:", JSON.stringify(getOldLineRanges(change)));
  console.log("added ranges:", JSON.stringify(getAddedOnlyNewLineRanges(change)));

  // AI says +131 but actual added is at new=132
  // Without codeContent, the code sees 131 is in oldLineRanges → treats as context
  const pos = buildPositionForGitLab(131, "added", change);
  console.log("buildPositionForGitLab(131, 'added') =", JSON.stringify(pos));

  // AI number was wrong (it's actually 132), so system falls back to treating 131 as context
  assertEqual(pos.new_line, 131, "new_line corrected to 131");
  assertTrue(pos.old_line !== undefined, "old_line present (system thinks it's context)");
}

console.log("\n===== E2: 131 regression — content-based finds correct line =====");
{
  const change = makeChange(DIFF_PURE_ADDED);

  // With code content, locateLineByContent finds the actual added line at new=132
  const pos = buildPositionForGitLab(131, "added", change,
    "  List<Indicator> findByCodeIn(String[] codes);");
  console.log("content-based match:", JSON.stringify(pos));

  assertEqual(pos.new_line, 132, "content match → correct new=132");
  assertUndefined(pos.old_line, "pure added → no old_line");
}

console.log("\n===== E3: context line still correctly gets old_line =====");
{
  const change = makeChange(DIFF_CONTEXT_AS_ADDED);

  const pos = buildPositionForGitLab(70, "added", change);
  assertEqual(pos.old_line, 70, "context +70 → old_line=70");
  assertEqual(pos.new_line, 70, "context +70 → new_line=70");
}

// ---- Part F: buildNewToOldMapping & more edge cases ----

console.log("\n===== F1: buildNewToOldMapping DIFF_ONLY_REMOVED =====");
{
  const change = makeChange(DIFF_ONLY_REMOVED);
  const reverse = buildNewToOldMapping(change);

  assertEqual(reverse[42], 42, "new=42 → old=42");
  assertEqual(reverse[43], 45, "new=43 → old=45 (context shifted by 2 dels)");
}

console.log("\n===== F2: buildPositionForGitLab DIFF_ONLY_REMOVED context =====");
{
  const change = makeChange(DIFF_ONLY_REMOVED);

  // old=45 context → new=43
  const pos = buildPositionForGitLab(45, "context", change);
  assertEqual(pos.old_line, 45, "context old=45");
  assertEqual(pos.new_line, 43, "context new=43 (shifted by 2 dels)");
}

console.log("\n=====================================");
if (failedTests > 0) {
  console.log("SOME TESTS FAILED: " + failedTests + "/" + totalTests);
} else {
  console.log("ALL TESTS PASSED ✓ (" + passedTests + "/" + totalTests + ")");
}
console.log("=====================================\n");

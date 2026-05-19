// 行号映射测试 - 直接 require 编译后的 utils.js

const {
	parseHunkHeader,
	getOldLineRanges,
	getAddedOnlyNewLineRanges,
	buildOldToNewMapping,
	correctLineNumber,
	buildPositionForGitLab,
} = require("../lib/utils");

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

function assertEqual(actual, expected, message) {
	totalTests++;
	if (JSON.stringify(actual) !== JSON.stringify(expected)) {
		console.error("FAIL: " + message);
		console.error("  Expected:", JSON.stringify(expected));
		console.error("  Actual:  ", JSON.stringify(actual));
		failedTests++;
	} else {
		console.log("PASS: " + message);
		passedTests++;
	}
}

function assertTrue(condition, message) {
	totalTests++;
	if (!condition) {
		console.error("FAIL: " + message);
		failedTests++;
	} else {
		console.log("PASS: " + message);
		passedTests++;
	}
}

function assertFalse(condition, message) {
	totalTests++;
	if (condition) {
		console.error("FAIL: " + message);
		failedTests++;
	} else {
		console.log("PASS: " + message);
		passedTests++;
	}
}

function assertUndefined(value, message) {
	totalTests++;
	if (value !== undefined) {
		console.error("FAIL: " + message);
		failedTests++;
	} else {
		console.log("PASS: " + message);
		passedTests++;
	}
}

function makeChange(diff) {
	return { new_path: "test/file.ts", diff };
}

// Diff example 1: simple case with context, added and removed lines
const DIFF_EXAMPLE_1 = `@@ -5,7 +5,9 @@
 line4        // context (old=5, new=5)
-line5        // removed (old=6)
+line5_new    // added (new=6)
+extra_line   // added (new=7)
 line6        // context (old=7, new=6)
 line7`; // context (old=8, new=7)

// Diff example 4: problematic case - AI marks old=70 as added but it is actually removed
const DIFF_EXAMPLE_4 = `@@ -68,3 +68,5 @@
 line66        // context (old=68, new=69)
 line67        // context (old=69, new=70) <-- AI confused this as added!
-line68       // removed (old=70)
+newLine1     // added (new=72)
+newLine2     // added (new=73)
 line69`; // context (old=71, new=74)

console.log("\n===== Test 1: buildOldToNewMapping =====\n");

{
	const change = makeChange(DIFF_EXAMPLE_1);
	const mapping = buildOldToNewMapping(change);

	console.log("Mapping for DIFF_EXAMPLE_1:", JSON.stringify(mapping, null, 2));

	// Expected: old=5 → new=5 (context before first change)
	assertEqual(mapping[5], 5, "old=5 should map to new=5");

	// Expected: old=6 is deleted (mapped to undefined)
	assertUndefined(mapping[6], "old=6 should be undefined (deleted row)");

	// Expected: old=7 → new=8 (context shifted by +2 added lines before it in diff)
	assertEqual(mapping[7], 8, "old=7 should map to new=8");

	// Expected: old=8 → new=9
	assertEqual(mapping[8], 9, "old=8 should map to new=9");
}

console.log("\n===== Test 2: getAddedOnlyNewLineRanges =====\n");

{
	const change = makeChange(DIFF_EXAMPLE_1);
	const addedRanges = getAddedOnlyNewLineRanges(change);

	console.log("Added ranges for DIFF_EXAMPLE_1:", JSON.stringify(addedRanges));

	const allAddedLines = [];
	for (const [s, e] of addedRanges) {
		for (let i = s; i <= e; i++) allAddedLines.push(i);
	}

	console.log("All added line numbers:", allAddedLines);

	// The + lines should be at new positions 6 and 7
	assertTrue(allAddedLines.includes(6), "+line5_new should be at new line 6");
	assertTrue(allAddedLines.includes(7), "+extra_line should be at new line 7");
}

console.log("\n===== Test 3: correctLineNumber for added type =====\n");

{
	const change = makeChange(DIFF_EXAMPLE_1);

	// Test valid added line number (6) - should stay as-is
	const resultValidNew = correctLineNumber(6, "added", change);
	assertEqual(resultValidNew.lineNumber, 6, "+6 (valid new line) should stay");
	assertFalse(resultValidNew.corrected, "+6 should NOT be corrected");

	// Test valid added line number (7) - should stay as-is
	const resultValidNew2 = correctLineNumber(7, "added", change);
	assertEqual(resultValidNew2.lineNumber, 7, "+7 (valid new line) should stay");

	// Test out-of-range (70) - should be corrected/snap to boundary
	const resultOutOfRange = correctLineNumber(70, "added", change);
	console.log(
		"Corrected +70 to:",
		resultOutOfRange.lineNumber,
		"(corrected:",
		resultOutOfRange.corrected,
		")",
	);

	if (!resultOutOfRange.corrected) {
		console.error("FAIL: +70 was NOT corrected!");
		failedTests++;
	} else {
		console.log("PASS: +70 was correctly handled");
		passedTests++;
	}
}

console.log(
	"\n===== Test 4: Reproduce bug - AI says +70 but line 70 is actually removed =====\n",
);

{
	const change = makeChange(DIFF_EXAMPLE_4);

	console.log("Diff content:");
	console.log(DIFF_EXAMPLE_4);
	console.log(
		"\nMapping:",
		JSON.stringify(buildOldToNewMapping(change), null, 2),
	);
	console.log(
		"Added ranges:",
		JSON.stringify(getAddedOnlyNewLineRanges(change)),
	);
	console.log("Old line ranges:", JSON.stringify(getOldLineRanges(change)));

	// AI says +70, but in this diff old=70 is actually a REMOVED line (-line68)
	const posAsAdded = buildPositionForGitLab(70, "added", change);

	console.log("\nResult when AI says +70 (but old=70 is actually removed):");
	console.log(" ", JSON.stringify(posAsAdded));

	// The key test: it should not crash and should return some value
	if (posAsAdded.new_line !== undefined && posAsAdded.new_line > 0) {
		console.log("PASS: +70 produces valid new_line=" + posAsAdded.new_line);
		passedTests++;
	} else {
		console.error("FAIL: +70 produced invalid result");
		failedTests++;
	}
}

console.log("\n===== Test 5: buildPositionForGitLab for context type =====\n");

{
	const change = makeChange(DIFF_EXAMPLE_1);

	// Old line 5 (context) should map to new line 5
	const pos5 = buildPositionForGitLab(5, "context", change);
	assertEqual(pos5.old_line, 5, "context old_line=5");
	assertEqual(pos5.new_line, 5, "context new_line for old=5 should be 5");

	// Old line 7 (context) should map to new line 8
	const pos7 = buildPositionForGitLab(7, "context", change);
	assertEqual(pos7.old_line, 7, "context old_line=7");
	assertEqual(
		pos7.new_line,
		8,
		"context new_line for old=7 should be 8 (shifted)",
	);

	// Old line that was deleted - fallback
	const posDeleted = buildPositionForGitLab(6, "context", change);
	console.log("Deleted row context fallback:", JSON.stringify(posDeleted));
}

console.log("\n===== Test 6: Simple replacement case =====\n");

{
	const DIFF_EXAMPLE_5 = `@@ -65,5 +65,5 @@
 line63
 line64
-line65_old
+line65_new
 line66
 line67`;

	const change = makeChange(DIFF_EXAMPLE_5);

	console.log(
		"Mapping:",
		JSON.stringify(buildOldToNewMapping(change), null, 2),
	);
	console.log(
		"Added ranges:",
		JSON.stringify(getAddedOnlyNewLineRanges(change)),
	);

	// The + line should be at position 68 (after context lines)
	const addedRanges = getAddedOnlyNewLineRanges(change);
	const allAdded = [];
	for (const [s, e] of addedRanges) {
		for (let i = s; i <= e; i++) allAdded.push(i);
	}

	console.log("All added lines:", allAdded);
	assertTrue(allAdded.includes(67), "+line65_new should be at new line 67");
}

console.log("\n=====================================");
if (failedTests > 0) {
	console.log("SOME TESTS FAILED: " + failedTests + "/" + totalTests);
	process.exitCode = 1;
	process.exit(1);
} else {
	console.log("ALL TESTS PASSED ✓ (" + passedTests + "/" + totalTests + ")");
}
console.log("=====================================\n");

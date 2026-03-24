import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const TEST_CASES_PATH = "test/test_cases.txt";
const CORPUS_BASE_DIR = "test/fuzz";

function ensureDir(dir: string) {
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
}

function writeToSubdirs(
	dir: string,
	subdirs: string[],
	filename: string,
	content: string,
) {
	for (const s of subdirs) {
		writeFileSync(join(dir, s, filename), content);
	}
}

function generateCorpus() {
	if (!existsSync(TEST_CASES_PATH)) {
		// biome-ignore lint/suspicious/noConsole: script console is appropriate
		console.error(`Source file ${TEST_CASES_PATH} not found.`);
		return;
	}

	const content = readFileSync(TEST_CASES_PATH, "utf-8");
	const cases = content.split("\n---\n");

	const myersSubdirs = [
		"Myers_Fuzzing/findCommonPrefix_and_findCommonSuffix_should_not_throw",
		"Myers_Fuzzing/MyersSequenceMatcher_should_handle_random_strings",
		"Myers_Fuzzing/InlineMyersSequenceMatcher_should_handle_random_strings",
		"Myers_Fuzzing/SyncPointMyersSequenceMatcher_should_handle_random_strings_and_sync_points",
	];
	for (const s of myersSubdirs) {
		ensureDir(join(CORPUS_BASE_DIR, "myers.fuzz", s));
	}

	const mergeSubdirs = [
		"Merger_Fuzzing/initialize_and_merge3Files_should_not_throw",
	];
	for (const s of mergeSubdirs) {
		ensureDir(join(CORPUS_BASE_DIR, "merge.fuzz", s));
	}

	const diffutilSubdirs = [
		"Differ_Fuzzing/setSequencesIter_and_changeSequence_should_not_throw",
	];
	for (const s of diffutilSubdirs) {
		ensureDir(join(CORPUS_BASE_DIR, "diffutil.fuzz", s));
	}

	for (const [index, caseContent] of cases.entries()) {
		const versions = caseContent.split("\n===\n");

		for (const [vIdx, v] of versions.entries()) {
			writeToSubdirs(
				join(CORPUS_BASE_DIR, "myers.fuzz"),
				myersSubdirs,
				`case_${index}_v${vIdx}`,
				v,
			);
		}

		if (versions.length >= 3) {
			const joined = versions.slice(0, 3).join("\0\0\0");
			writeToSubdirs(
				join(CORPUS_BASE_DIR, "merge.fuzz"),
				mergeSubdirs,
				`case_${index}`,
				joined,
			);
			writeToSubdirs(
				join(CORPUS_BASE_DIR, "diffutil.fuzz"),
				diffutilSubdirs,
				`case_${index}`,
				joined,
			);
		}
	}

	// biome-ignore lint/suspicious/noConsole: script console is appropriate
	console.log(`Generated corpus in ${CORPUS_BASE_DIR}`);
}

generateCorpus();

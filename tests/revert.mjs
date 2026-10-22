// Mutation check for the example's safeguards: applies each selected mutation
// to a scratch copy of the plugin, reruns check.mjs, and requires the named
// checks to fail (and, where listed, others to keep passing). A mutation that
// leaves every check green means a check is missing.
//
// Runs a second stack (project mcp-least-privilege-revert, port 8090) from a temporary
// copy, so the working example and its database are never touched.
//
// Usage: node revert.mjs [--keep]   (--keep leaves the scratch stack running,
// with the plugin restored to its unmutated state)

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRATCH = mkdtempSync(join(tmpdir(), 'mcp-least-privilege-revert-'));
const env = { ...process.env, COMPOSE_PROJECT_NAME: `${process.env.COMPOSE_PROJECT_NAME || 'mcp-least-privilege'}-revert`, WP_PORT: process.env.REVERT_PORT || '8090' };
const PLUGIN = join(SCRATCH, 'plugin/ilogr-draft-abilities/ilogr-draft-abilities.php');
const KEEP = process.argv.includes('--keep');

// Each mutation is a list of exact, single-match edits, or an appended line.
const reverts = [
	{
		name: 'write permission callback always returns true',
		edits: [["return $post_id > 0 && current_user_can( 'edit_post', $post_id );", 'return true;']],
		mustFail: ['S06', 'S09', 'H03'],
	},
	{
		name: 'object-level edit_post replaced by type-level edit_posts',
		edits: [["return $post_id > 0 && current_user_can( 'edit_post', $post_id );", "return current_user_can( 'edit_posts' );"]],
		mustFail: ['S09'],
	},
	{
		name: 'read-only ability gated on read instead of edit_posts',
		edits: [[
			"return current_user_can( 'edit_posts' );\n\t\t\t},\n\t\t\t'execute_callback'    => 'ilogr_list_draft_titles',",
			"return current_user_can( 'read' );\n\t\t\t},\n\t\t\t'execute_callback'    => 'ilogr_list_draft_titles',",
		]],
		mustFail: ['S07'],
	},
	{
		name: 'unexposed ability given meta.mcp.public',
		edits: [[
			"'destructive' => true,\n\t\t\t\t),\n\t\t\t),",
			"'destructive' => true,\n\t\t\t\t),\n\t\t\t\t'mcp'         => array( 'public' => true ),\n\t\t\t),",
		]],
		mustFail: ['S03', 'S14', 'S15', 'S28', 'H06'],
	},
	{
		name: 'MCP-only exposure widened to meta.public',
		edits: [[
			"'readonly'   => true,\n\t\t\t\t\t'idempotent' => true,\n\t\t\t\t),\n\t\t\t\t'mcp'         => array( 'public' => true ),",
			"'readonly'   => true,\n\t\t\t\t\t'idempotent' => true,\n\t\t\t\t),\n\t\t\t\t'public'      => true,",
		]],
		mustFail: ['R01'],
	},
	{
		name: 'excerpt maxLength removed',
		edits: [["'maxLength' => 300,", '']],
		mustFail: ['S17'],
	},
	{
		name: 'additionalProperties false removed from the write ability',
		edits: [[
			"'required'             => array( 'post_id', 'excerpt' ),\n\t\t\t\t'additionalProperties' => false,",
			"'required'             => array( 'post_id', 'excerpt' ),",
		]],
		mustFail: ['S19'],
	},
	{
		name: 'draft-only check removed from the execute callback',
		edits: [[" || 'draft' !== $post->post_status ) {\n\t\treturn new WP_Error( 'ilogr_not_a_draft'", " ) {\n\t\treturn new WP_Error( 'ilogr_not_a_draft'"]],
		mustFail: ['S12'],
	},
	{
		name: 'post-type check removed from the execute callback',
		edits: [["if ( ! $post || 'post' !== $post->post_type || 'draft' !== $post->post_status ) {\n\t\treturn new WP_Error( 'ilogr_not_a_draft'",
			"if ( ! $post || 'draft' !== $post->post_status ) {\n\t\treturn new WP_Error( 'ilogr_not_a_draft'"]],
		mustFail: ['S26'],
	},
	{
		name: 'per-post filter removed from the draft list',
		edits: [["if ( current_user_can( 'edit_post', $id ) ) {\n\t\t\t\t$drafts[]", "if ( true ) {\n\t\t\t\t$drafts[]"]],
		mustFail: ['S13'],
	},
	{
		name: 'limit applied in the query, before the per-post filter',
		edits: [
			["'posts_per_page' => 100,", "'posts_per_page' => $limit,"],
			['} while ( 100 === count( $ids ) );', '} while ( false );'],
		],
		mustFail: ['S23'],
	},
	{
		name: 'excerpt stored without sanitize_textarea_field',
		edits: [["$excerpt = sanitize_textarea_field( $input['excerpt'] );", "$excerpt = $input['excerpt'];"]],
		mustFail: ['S24'],
	},
	{
		name: 'empty-excerpt refusal removed',
		edits: [["if ( 1 === preg_match( '/\\A[\\s\\p{Z}\\p{Cf}\\p{Cc}\\x{034F}\\x{115F}\\x{1160}\\x{2800}\\x{3164}\\x{FE00}-\\x{FE0F}\\x{FFA0}]*\\z/u', $excerpt ) ) {", 'if ( false ) {']],
		mustFail: ['S25'],
	},
	{
		name: 'empty-excerpt refusal narrowed to ASCII whitespace',
		edits: [["if ( 1 === preg_match( '/\\A[\\s\\p{Z}\\p{Cf}\\p{Cc}\\x{034F}\\x{115F}\\x{1160}\\x{2800}\\x{3164}\\x{FE00}-\\x{FE0F}\\x{FFA0}]*\\z/u', $excerpt ) ) {", "if ( '' === trim( $excerpt ) ) {"]],
		mustFail: ['S25'],
	},
	{
		name: 'object check removed from the write execute callback',
		edits: [["if ( ! current_user_can( 'edit_post', $post->ID ) ) {", 'if ( false ) {']],
		mustFail: ['A02'],
	},
	{
		name: 'wp_slash removed before wp_update_post',
		edits: [
			['wp_update_post(\n\t\twp_slash(\n\t\t\tarray(', 'wp_update_post(\n\t\t(\n\t\t\tarray('],
		],
		mustFail: ['S27'],
	},
	{
		name: 'delete ability permission callback always returns true',
		edits: [["return current_user_can( 'delete_others_posts' );", 'return true;']],
		mustFail: ['P03'],
	},
	{
		name: 'per-post delete_post check removed',
		edits: [["if ( ! current_user_can( 'delete_post', $id ) ) {\n\t\t\tcontinue;\n\t\t}\n", '']],
		mustFail: ['P02', 'A02'],
	},
	{
		name: 'age filter on the zero-dated GMT column, without the per-post recheck',
		edits: [
			["'column' => 'post_modified',", "'column' => 'post_modified_gmt',"],
			[" || $post->post_modified >= $cutoff ) {", ' ) {'],
		],
		mustFail: ['P01'],
	},
	{
		name: 'older_than_days maximum removed',
		edits: [["'minimum' => 30,\n\t\t\t\t\t\t'maximum' => 3650,", "'minimum' => 30,"]],
		mustFail: ['P05'],
	},
	{
		name: 'bin-disabled refusal removed from the delete ability',
		edits: [['if ( ! EMPTY_TRASH_DAYS ) {', 'if ( false ) {']],
		mustFail: ['P04'],
	},
	{
		name: 'another plugin grants every ability through wp_ability_permission_result',
		append: "\nadd_filter( 'wp_ability_permission_result', '__return_true' );\n",
		mustFail: ['S06', 'S09', 'S28', 'S29', 'H03', 'H06', 'R02', 'A01'],
		// The MCP transport's own authentication is not an ability check, so it must hold, and so
		// must the object checks inside the execute callbacks.
		mustPass: ['H01', 'H02', 'A02'],
	},
];

let pristine = null;
let cleanedUp = false;
let teardownFailed = false;

function run(cmd, args, options = {}) {
	const result = spawnSync(cmd, args, { cwd: SCRATCH, env, encoding: 'utf8', ...options });
	// Ctrl+C in a terminal signals the whole process group, so the child usually dies first. A node
	// child reports the signal; docker compose and bash report exit status 130 (SIGINT) or 143 (SIGTERM).
	if (result.signal === 'SIGINT' || result.signal === 'SIGTERM' || result.status === 130 || result.status === 143) {
		console.error(`\n${result.signal || `exit ${result.status}`} received; restoring the plugin and cleaning up.`);
		cleanup();
		process.exit(teardownFailed ? 2 : 130);
	}
	if (result.signal) throw new Error(`${cmd} ended by ${result.signal}`);
	return result;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// Idempotent: restores the unmutated plugin first, then tears down unless --keep.
function cleanup() {
	if (cleanedUp) return;
	cleanedUp = true;
	if (pristine !== null && existsSync(PLUGIN)) writeFileSync(PLUGIN, pristine);
	if (KEEP) {
		console.log(`Scratch stack kept at ${SCRATCH} (plugin restored).`);
		return;
	}
	const down = spawnSync('docker', ['compose', 'down', '-v', '--remove-orphans'], { cwd: SCRATCH, env, encoding: 'utf8' });
	if (down.status !== 0) {
		teardownFailed = true;
		console.error(`Teardown failed; leaving ${SCRATCH} in place so the stack can be removed by hand:\n${down.stderr}`);
		return;
	}
	rmSync(SCRATCH, { recursive: true, force: true });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
	process.on(signal, () => {
		console.error(`\n${signal} received; restoring the plugin and cleaning up.`);
		cleanup();
		process.exit(teardownFailed ? 2 : 130);
	});
}

function mutate(revert) {
	if (revert.append) return pristine + revert.append;
	let edited = pristine;
	for (const [find, replace] of revert.edits) {
		const count = edited.split(find).length - 1;
		if (count !== 1) throw new Error(`revert "${revert.name}": expected 1 match, found ${count} for ${JSON.stringify(find.slice(0, 60))}`);
		edited = edited.replace(find, () => replace);
	}
	return edited;
}

async function main() {
	cpSync(SOURCE, SCRATCH, { recursive: true, filter: (src) => !src.startsWith(join(SOURCE, '.state')) && !src.startsWith(join(SOURCE, '.git')) });
	pristine = readFileSync(PLUGIN, 'utf8');

	const setup = run('bash', ['bin/setup.sh'], { stdio: ['ignore', 'pipe', 'inherit'] });
	if (setup.status !== 0) throw new Error(`setup failed:\n${setup.stdout}`);

	const baseline = run('node', ['tests/check.mjs', '--json', join(SCRATCH, 'baseline.json')]);
	if (baseline.status !== 0) throw new Error(`baseline did not pass on the scratch stack:\n${baseline.stdout}`);
	console.log(`Baseline on scratch stack: ${JSON.parse(readFileSync(join(SCRATCH, 'baseline.json'), 'utf8')).passed} checks passed.`);

	let exitCode = 0;
	for (const revert of reverts) {
		writeFileSync(PLUGIN, mutate(revert));
		const lint = run('docker', ['compose', 'exec', '-T', 'cli', 'php', '-l', '/var/www/html/wp-content/plugins/ilogr-draft-abilities/ilogr-draft-abilities.php']);
		if (lint.status !== 0) throw new Error(`revert "${revert.name}" produced invalid PHP:\n${lint.stdout}${lint.stderr}`);
		await sleep(3000); // Let the web container's opcache revalidate the file.

		const out = join(SCRATCH, 'revert.json');
		rmSync(out, { force: true });
		const result = run('node', ['tests/check.mjs', '--json', out]);
		let failed = [];
		try {
			failed = JSON.parse(readFileSync(out, 'utf8')).failed;
		} catch {
			failed = [`harness exit ${result.status}`];
		}
		const missed = revert.mustFail.filter((id) => !failed.includes(id));
		const broke = (revert.mustPass ?? []).filter((id) => failed.includes(id));
		const caught = result.status === 1 && missed.length === 0 && broke.length === 0;
		let line = `${caught ? 'CAUGHT' : 'MISSED'} ${revert.name}: failed [${failed.join(', ')}]`;
		if (revert.mustPass) line += `; still passing [${revert.mustPass.filter((id) => !failed.includes(id)).join(', ')}]`;
		if (missed.length) line += `; expected also [${missed.join(', ')}]`;
		if (broke.length) line += `; should have passed [${broke.join(', ')}]`;
		console.log(line);
		if (!caught) exitCode = 1;

		writeFileSync(PLUGIN, pristine);
		await sleep(10); // Yield so a pending signal is handled with the plugin restored.
	}

	await sleep(3000);
	const after = run('node', ['tests/check.mjs']);
	console.log(after.status === 0 ? 'Restored plugin passes again.' : `Restored plugin FAILS:\n${after.stdout}`);
	return after.status === 0 ? exitCode : 1;
}

let exitCode = 2;
try {
	exitCode = await main();
} catch (error) {
	console.error(`Harness error: ${error.message}`);
	exitCode = 2;
} finally {
	cleanup();
}
process.exit(teardownFailed ? 2 : exitCode);

// Deterministic checks for the least-privilege abilities example.
//
// Every check talks to WordPress the way an AI client would: through
// `wp mcp-adapter serve` over STDIO, or through the HTTP endpoint with an
// application password. No model is called. Post state is read back with
// WP-CLI after each write, so a check cannot pass on the response text alone.
//
// Usage: node check.mjs [--json <file>]
// Exit codes: 0 all passed, 1 at least one check failed, 2 harness error.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STATE = resolve(ROOT, '.state');
const SERVER = 'mcp-adapter-default-server';
const EXPOSED = ['ilogr/list-draft-titles', 'ilogr/set-draft-excerpt'];
const HIDDEN = 'ilogr/delete-stale-drafts';
const ORIGINAL = 'Original excerpt';
const LAB_TITLE = 'MCP least privilege'; // the site title bin/setup.sh gives the test bed
// MCP Adapter 0.6.x says "is not exposed via MCP"; 0.7.1 answers an unexposed ability with the
// same "not found" reply as an unknown name. Either way the call must be refused.
const NOT_EXPOSED = /is not exposed via MCP|not found on this WordPress site/;

const jsonOut = process.argv.includes('--json') ? process.argv[process.argv.indexOf('--json') + 1] : null;
const results = [];

const state = (name) => {
	try {
		return readFileSync(resolve(STATE, name), 'utf8').trim();
	} catch {
		console.error(`Harness error: ${name} is missing from .state/. Run ./bin/setup.sh first.`);
		process.exit(2);
	}
};
const ids = {
	otherAuthorDraft: Number(state('draft-other-author.id')),
	agentAuthorDraft: Number(state('draft-agent-author.id')),
	adminDraft: Number(state('draft-admin.id')),
	published: Number(state('published.id')),
	draftPage: Number(state('draft-page.id')),
};
const siteUrl = state('site-url');

function wp(...args) {
	return execFileSync('docker', ['compose', 'exec', '-T', 'cli', 'wp', ...args], {
		cwd: ROOT,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
	}).trim();
}

// Exact stored value, JSON-encoded by PHP, so whitespace is never trimmed away.
const excerptOf = (id) => JSON.parse(wp('eval', `echo json_encode( get_post_field( 'post_excerpt', ${Number(id)}, 'raw' ) );`));

// Runs PHP inside WordPress as the given user. `exec` runs before WordPress loads.
function php(code, { user = null, exec = null } = {}) {
	const args = ['compose', 'exec', '-T', 'cli', 'wp'];
	if (user) args.push(`--user=${user}`);
	if (exec) args.push(`--exec=${exec}`);
	args.push('eval-file', '-');
	return execFileSync('docker', args, { cwd: ROOT, encoding: 'utf8', input: `<?php\n${code}`, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

// Creates one draft untouched since 2020 and one brand-new draft that has never
// been edited (WordPress gives it a zero post_modified_gmt), runs the hidden
// ability through WP_Ability::execute() (the site-code path), reports, then
// removes both.
function runStaleDraftDeletion({ user, exec = null, denyThisPost = false }) {
	const out = php(
		`
		$id = wp_insert_post( array( 'post_type' => 'post', 'post_status' => 'draft', 'post_title' => 'Stale fixture', 'post_author' => 1 ) );
		global $wpdb;
		$wpdb->update( $wpdb->posts, array( 'post_modified' => '2020-01-01 00:00:00', 'post_modified_gmt' => '2020-01-01 00:00:00' ), array( 'ID' => $id ) );
		clean_post_cache( $id );
		$new = wp_insert_post( array( 'post_type' => 'post', 'post_status' => 'draft', 'post_title' => 'Never edited', 'post_author' => 1 ) );
		if ( ${denyThisPost ? 'true' : 'false'} ) {
			add_filter( 'map_meta_cap', function ( $caps, $cap, $uid, $args ) use ( $id ) {
				return ( 'delete_post' === $cap && (int) ( $args[0] ?? 0 ) === $id ) ? array( 'do_not_allow' ) : $caps;
			}, 10, 4 );
		}
		$result = wp_get_ability( '${HIDDEN}' )->execute( array( 'older_than_days' => 30 ) );
		$report = array(
			'result' => is_wp_error( $result ) ? array( 'error' => $result->get_error_code() ) : $result,
			'stale'  => get_post_status( $id ),
			'fresh'  => array_map( 'get_post_status', array( ${ids.otherAuthorDraft}, ${ids.agentAuthorDraft}, ${ids.adminDraft}, $new ) ),
			'new_gmt' => get_post_field( 'post_modified_gmt', $new ),
		);
		wp_delete_post( $id, true );
		wp_delete_post( $new, true );
		echo json_encode( $report );
		`,
		{ user, exec },
	);
	resetFixtures();
	return JSON.parse(out);
}
const statusOf = (id) => wp('post', 'get', String(id), '--field=post_status');

function resetFixtures() {
	for (const id of [ids.otherAuthorDraft, ids.agentAuthorDraft, ids.adminDraft]) {
		wp('post', 'update', String(id), `--post_excerpt=${ORIGINAL}`, '--post_status=draft', '--quiet');
	}
	wp('post', 'update', String(ids.published), '--post_excerpt=Published excerpt', '--quiet');
	wp('post', 'update', String(ids.draftPage), '--post_excerpt=Page excerpt', '--post_status=draft', '--quiet');
}

async function stdioClient(user) {
	const args = ['compose', 'exec', '-T', 'cli', 'wp', 'mcp-adapter', 'serve', `--server=${SERVER}`];
	if (user) args.push(`--user=${user}`);
	// The SDK passes only a short allow-list of variables to the child process by
	// default, which would drop COMPOSE_PROJECT_NAME and silently reach another stack.
	const env = Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined));
	const transport = new StdioClientTransport({ command: 'docker', args, cwd: ROOT, env, stderr: 'ignore' });
	const client = new Client({ name: 'least-privilege-check', version: '1.0.0' });
	await client.connect(transport);
	return client;
}

async function httpClient(user, password) {
	const url = new URL(`${siteUrl}/wp-json/mcp/${SERVER}`);
	const auth = 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64');
	const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: auth } } });
	const client = new Client({ name: 'least-privilege-check', version: '1.0.0' });
	await client.connect(transport);
	client.__transport = transport;
	return client;
}

async function closeClient(client) {
	if (!client) return;
	if (client.__transport) await client.__transport.terminateSession().catch(() => {});
	await client.close().catch(() => {});
}

// Plain HTTP requests retry once on a network error (Node can reuse a keep-alive socket that
// Apache has just closed). An HTTP status is never retried: it is the result under test.
async function httpFetch(url, options) {
	try {
		return await fetch(url, options);
	} catch (error) {
		if (!(error instanceof TypeError)) throw error;
		return fetch(url, options);
	}
}

const execute = (client, ability, parameters) =>
	client.callTool({ name: 'mcp-adapter-execute-ability', arguments: { ability_name: ability, parameters } });

const textOf = (result) => (result.content ?? []).map((c) => c.text ?? '').join(' ');

async function discovered(client) {
	const result = await client.callTool({ name: 'mcp-adapter-discover-abilities', arguments: {} });
	return (result.structuredContent?.abilities ?? []).map((a) => a.name);
}

async function check(id, description, fn) {
	try {
		const detail = await fn();
		results.push({ id, ok: true, description });
		console.log(`PASS ${id} ${description}${detail ? ` (${detail})` : ''}`);
	} catch (error) {
		results.push({ id, ok: false, description, error: String(error?.message ?? error) });
		console.log(`FAIL ${id} ${description}: ${error?.message ?? error}`);
	}
}

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

function assertDenied(result, expectedText) {
	assert(result.isError === true, `expected an error result, got ${JSON.stringify(result).slice(0, 200)}`);
	const matches = expectedText instanceof RegExp ? expectedText.test(textOf(result)) : textOf(result).includes(expectedText);
	assert(matches, `expected "${expectedText}", got "${textOf(result)}"`);
}

async function main() {
	// The checks write posts and install a temporary filter, so refuse to run against anything
	// but the test bed that bin/setup.sh builds.
	let title = '';
	try {
		title = wp('option', 'get', 'blogname');
	} catch (error) {
		console.error(`Harness error: the test bed is not running. Run ./bin/setup.sh first. ${error.message.split('\n')[0]}`);
		process.exit(2);
	}
	if (title !== LAB_TITLE) {
		console.error(`Harness error: the WordPress reached from here is titled "${title}", not the test bed built by bin/setup.sh. Nothing was changed.`);
		process.exit(2);
	}

	resetFixtures();

	const clients = {};
	try {
		clients.editor = await stdioClient('agent-editor');
		clients.author = await stdioClient('agent-author');
		clients.subscriber = await stdioClient('agent-subscriber');
		clients.admin = await stdioClient('admin');
		clients.anonymous = await stdioClient(null);
	} catch (error) {
		console.error(`Harness error: could not start an MCP session over STDIO: ${error.message}`);
		await Promise.all(Object.values(clients).map(closeClient));
		process.exit(2);
	}

	try {
		// Guard: STDIO and HTTP must reach the same site, or every result below is meaningless.
		const info = await execute(clients.admin, 'core/get-site-info', { fields: ['url'] });
		const stdioUrl = info.structuredContent?.data?.url;
		if (stdioUrl !== siteUrl) {
			throw new Error(`STDIO session reached ${stdioUrl}, expected ${siteUrl}`);
		}

		// What a client can see.
		await check('S01', 'default server lists only the three adapter meta-tools', async () => {
			const names = (await clients.editor.listTools()).tools.map((t) => t.name).sort();
			const expected = ['mcp-adapter-discover-abilities', 'mcp-adapter-execute-ability', 'mcp-adapter-get-ability-info'];
			assert(JSON.stringify(names) === JSON.stringify(expected), `tools were ${names.join(', ')}`);
		});

		await check('S02', 'both exposed abilities are discoverable', async () => {
			const names = await discovered(clients.editor);
			for (const name of EXPOSED) assert(names.includes(name), `${name} missing from discovery`);
		});

		await check('S03', 'unexposed ability is not listed, even for an administrator', async () => {
			for (const role of ['editor', 'admin']) {
				const names = await discovered(clients[role]);
				assert(!names.includes(HIDDEN), `${HIDDEN} listed for ${role}`);
			}
		});

		await check('S04', 'a Subscriber can see the write ability it cannot use', async () => {
			const names = await discovered(clients.subscriber);
			assert(names.includes('ilogr/set-draft-excerpt'), 'write ability not visible to Subscriber');
		});

		await check('S05', 'WordPress 7.1 core abilities are exposed by meta.public alone', async () => {
			const names = await discovered(clients.subscriber);
			for (const core of ['core/get-site-info', 'core/get-user-info', 'core/get-environment-info']) {
				assert(names.includes(core), `${core} not exposed`);
			}
			return 'all three listed for a Subscriber';
		});

		// What a client may do.
		await check('S06', 'Subscriber is denied the write ability and the post is unchanged', async () => {
			const result = await execute(clients.subscriber, 'ilogr/set-draft-excerpt', {
				post_id: ids.otherAuthorDraft,
				excerpt: 'Written by a Subscriber',
			});
			assertDenied(result, 'Permission denied');
			assert(excerptOf(ids.otherAuthorDraft) === ORIGINAL, 'excerpt changed');
		});

		await check('S07', 'Subscriber is denied the read-only ability', async () => {
			assertDenied(await execute(clients.subscriber, 'ilogr/list-draft-titles', {}), 'Permission denied');
		});

		await check('S08', 'Subscriber is denied a core ability that needs manage_options', async () => {
			assertDenied(await execute(clients.subscriber, 'core/get-environment-info', {}), 'Permission denied');
		});

		await check('S09', "Author is denied another author's draft and the post is unchanged", async () => {
			const result = await execute(clients.author, 'ilogr/set-draft-excerpt', {
				post_id: ids.otherAuthorDraft,
				excerpt: 'Written by the wrong author',
			});
			assertDenied(result, 'Permission denied');
			assert(excerptOf(ids.otherAuthorDraft) === ORIGINAL, 'excerpt changed');
		});

		await check('S10', 'Author may change the excerpt of their own draft', async () => {
			const result = await execute(clients.author, 'ilogr/set-draft-excerpt', {
				post_id: ids.agentAuthorDraft,
				excerpt: 'Author edit',
			});
			assert(result.isError !== true, textOf(result));
			assert(excerptOf(ids.agentAuthorDraft) === 'Author edit', 'excerpt not written');
		});

		await check('S11', "Editor may change another author's draft, confirmed with WP-CLI", async () => {
			const result = await execute(clients.editor, 'ilogr/set-draft-excerpt', {
				post_id: ids.otherAuthorDraft,
				excerpt: 'Editor edit',
			});
			assert(result.isError !== true, textOf(result));
			assert(result.structuredContent?.data?.excerpt === 'Editor edit', 'response did not echo the excerpt');
			assert(excerptOf(ids.otherAuthorDraft) === 'Editor edit', 'excerpt not written');
		});

		await check('S12', 'Editor is refused a published post by the execute callback', async () => {
			const result = await execute(clients.editor, 'ilogr/set-draft-excerpt', {
				post_id: ids.published,
				excerpt: 'Should not land',
			});
			assertDenied(result, 'Only draft posts');
			assert(excerptOf(ids.published) === 'Published excerpt', 'published excerpt changed');
		});

		await check('S13', 'draft list is filtered per post: Editor sees 3, Author sees only their own', async () => {
			const editor = await execute(clients.editor, 'ilogr/list-draft-titles', {});
			const author = await execute(clients.author, 'ilogr/list-draft-titles', {});
			const editorIds = (editor.structuredContent?.data ?? []).map((d) => d.id).sort();
			const authorIds = (author.structuredContent?.data ?? []).map((d) => d.id);
			assert(editorIds.length === 3, `Editor saw ${editorIds.length} drafts`);
			assert(authorIds.length === 1 && authorIds[0] === ids.agentAuthorDraft, `Author saw ${JSON.stringify(authorIds)}`);
		});

		await check('S23', 'the limit applies after the per-post filter: an Author asking for 1 gets their own draft', async () => {
			const result = await execute(clients.author, 'ilogr/list-draft-titles', { limit: 1 });
			const got = (result.structuredContent?.data ?? []).map((d) => d.id);
			assert(got.length === 1 && got[0] === ids.agentAuthorDraft, `Author got ${JSON.stringify(got)}`);
		});

		await check('S24', 'markup is stripped from the excerpt before it is stored', async () => {
			resetFixtures();
			const result = await execute(clients.editor, 'ilogr/set-draft-excerpt', {
				post_id: ids.adminDraft,
				excerpt: '<script>alert(1)</script><b>Bold</b> text',
			});
			assert(result.isError !== true, textOf(result));
			assert(excerptOf(ids.adminDraft) === 'Bold text', `stored ${JSON.stringify(excerptOf(ids.adminDraft))}`);
			resetFixtures();
		});

		await check('S25', 'an excerpt that sanitises to nothing is refused, not written', async () => {
			// Markup, ASCII spaces, NBSP, EM SPACE, ideographic space, a zero-width space, and blank-looking fillers.
			for (const excerpt of ['<b></b><script>x</script>', '   ', '\u00a0\u00a0', '\u2003', '\u3000', '\u200b', '\u3164', '\u2800', '\u0001']) {
				assertDenied(await execute(clients.editor, 'ilogr/set-draft-excerpt', { post_id: ids.adminDraft, excerpt }), 'The excerpt is empty');
				assert(excerptOf(ids.adminDraft) === ORIGINAL, `excerpt became ${JSON.stringify(excerptOf(ids.adminDraft))}`);
			}
		});

		await check('S26', 'a draft page is refused by the post-only execute callback', async () => {
			resetFixtures();
			const result = await execute(clients.editor, 'ilogr/set-draft-excerpt', { post_id: ids.draftPage, excerpt: 'Page edit' });
			assertDenied(result, 'Only draft posts');
			assert(excerptOf(ids.draftPage) === 'Page excerpt', 'page excerpt changed');
		});

		await check('S27', 'backslashes survive the round trip to the database', async () => {
			const value = 'C:\\temp\\new and a \\n escape';
			const result = await execute(clients.editor, 'ilogr/set-draft-excerpt', { post_id: ids.adminDraft, excerpt: value });
			assert(result.isError !== true, textOf(result));
			assert(excerptOf(ids.adminDraft) === value, `stored ${JSON.stringify(excerptOf(ids.adminDraft))}`);
			resetFixtures();
		});

		await check('S28', 'a Subscriber cannot execute the unexposed ability over STDIO', async () => {
			assertDenied(await execute(clients.subscriber, HIDDEN, { older_than_days: 30 }), NOT_EXPOSED);
		});

		await check('S29', 'a STDIO session with no user cannot execute the unexposed ability', async () => {
			assertDenied(await execute(clients.anonymous, HIDDEN, { older_than_days: 30 }), 'User must be authenticated');
		});

		await check('S14', 'unexposed ability cannot be executed, even by an administrator', async () => {
			assertDenied(await execute(clients.admin, HIDDEN, { older_than_days: 30 }), NOT_EXPOSED);
			assert(statusOf(ids.adminDraft) === 'draft', 'a draft was trashed');
		});

		await check('S15', 'unexposed ability details cannot be fetched', async () => {
			const result = await clients.admin.callTool({ name: 'mcp-adapter-get-ability-info', arguments: { ability_name: HIDDEN } });
			assertDenied(result, NOT_EXPOSED);
		});

		await check('S16', 'a STDIO session without --user is denied', async () => {
			assertDenied(await execute(clients.anonymous, 'ilogr/list-draft-titles', {}), 'User must be authenticated');
		});

		// Input schema.
		const invalid = [
			['S17', 'excerpt longer than 300 characters', { post_id: ids.adminDraft, excerpt: 'x'.repeat(301) }],
			['S18', 'a post_id that is not an integer', { post_id: ids.adminDraft + 0.5, excerpt: 'Fraction' }],
			['S19', 'unexpected extra property', { post_id: ids.adminDraft, excerpt: 'Extra', post_status: 'publish' }],
			['S20', 'missing required excerpt', { post_id: ids.adminDraft }],
		];
		for (const [id, label, parameters] of invalid) {
			await check(id, `input schema rejects ${label}`, async () => {
				resetFixtures(); // A failed earlier check must not leave this one a dirty post.
				const result = await execute(clients.editor, 'ilogr/set-draft-excerpt', parameters);
				assertDenied(result, 'has invalid input');
				assert(excerptOf(ids.adminDraft) === ORIGINAL, 'excerpt changed');
				assert(statusOf(ids.adminDraft) === 'draft', 'status changed');
			});
		}

		// Behaviour pins for MCP Adapter 0.6.x on WordPress 7.1. If an upgrade changes
		// either, these fail and the permission callback deserves a second look.
		await check('S21', 'the permission callback runs on raw input, before the schema', async () => {
			assertDenied(await execute(clients.editor, 'ilogr/set-draft-excerpt', { post_id: 'abc', excerpt: 'x' }), 'Permission denied');
			assertDenied(await execute(clients.editor, 'ilogr/set-draft-excerpt', 'not an object'), 'Permission denied');
		});

		await check('S22', 'a numeric string passes the integer schema, so callbacks must cast', async () => {
			const result = await execute(clients.editor, 'ilogr/set-draft-excerpt', { post_id: String(ids.adminDraft), excerpt: 'String id' });
			assert(result.isError !== true, textOf(result));
			assert(excerptOf(ids.adminDraft) === 'String id', 'excerpt not written');
			resetFixtures();
		});
	} finally {
		await Promise.all(Object.values(clients).map(closeClient));
	}

	// HTTP transport with application passwords.
	await check('H01', 'HTTP endpoint refuses an anonymous initialize', async () => {
		const response = await httpFetch(`${siteUrl}/wp-json/mcp/${SERVER}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				method: 'initialize',
				params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'anon', version: '1' } },
			}),
		});
		assert(response.status === 401, `status ${response.status}`);
	});

	await check('H02', 'HTTP endpoint refuses a wrong application password', async () => {
		let refused = false;
		try {
			await closeClient(await httpClient('agent-editor', 'wrong password'));
		} catch (error) {
			refused = /401|rest_forbidden|incorrect_password/.test(String(error.message));
		}
		assert(refused, 'connection was accepted');
	});

	await check('H03', 'Subscriber is denied over HTTP and the post is unchanged', async () => {
		resetFixtures();
		const client = await httpClient('agent-subscriber', state('agent-subscriber.app-password'));
		try {
			const result = await execute(client, 'ilogr/set-draft-excerpt', { post_id: ids.otherAuthorDraft, excerpt: 'HTTP Subscriber' });
			assertDenied(result, 'Permission denied');
			assert(excerptOf(ids.otherAuthorDraft) === ORIGINAL, 'excerpt changed');
		} finally {
			await closeClient(client);
		}
	});

	await check('H04', 'Editor is allowed over HTTP, confirmed with WP-CLI', async () => {
		const client = await httpClient('agent-editor', state('agent-editor.app-password'));
		try {
			const result = await execute(client, 'ilogr/set-draft-excerpt', { post_id: ids.otherAuthorDraft, excerpt: 'HTTP Editor' });
			assert(result.isError !== true, textOf(result));
			assert(excerptOf(ids.otherAuthorDraft) === 'HTTP Editor', 'excerpt not written');
		} finally {
			await closeClient(client);
		}
	});

	await check('H06', 'a Subscriber cannot execute the unexposed ability over HTTP', async () => {
		const client = await httpClient('agent-subscriber', state('agent-subscriber.app-password'));
		try {
			assertDenied(await execute(client, HIDDEN, { older_than_days: 30 }), NOT_EXPOSED);
		} finally {
			await closeClient(client);
		}
	});

	await check('H05', "one user's HTTP session ID is refused with another user's credentials", async () => {
		const endpoint = `${siteUrl}/wp-json/mcp/${SERVER}`;
		const basic = (user) => 'Basic ' + Buffer.from(`${user}:${state(`${user}.app-password`)}`).toString('base64');
		const post = (auth, body, session) =>
			httpFetch(endpoint, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Accept: 'application/json, text/event-stream',
					Authorization: auth,
					'MCP-Protocol-Version': '2025-06-18',
					...(session ? { 'Mcp-Session-Id': session } : {}),
				},
				body: JSON.stringify(body),
			});
		const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'check', version: '1' } } };
		const editorSession = (await post(basic('agent-editor'), init)).headers.get('mcp-session-id');
		assert(editorSession, 'no session ID issued to the Editor');
		const call = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'mcp-adapter-execute-ability', arguments: { ability_name: 'ilogr/set-draft-excerpt', parameters: { post_id: ids.otherAuthorDraft, excerpt: 'Borrowed session' } } } };
		const response = await post(basic('agent-subscriber'), call, editorSession);
		const body = await response.text();
		assert(response.status === 404 && body.includes('Session not found'), `status ${response.status}: ${body.slice(0, 120)}`);
		assert(excerptOf(ids.otherAuthorDraft) !== 'Borrowed session', 'excerpt changed');
	});

	// Channel scoping: MCP-only exposure must not leak into the REST abilities endpoints.
	await check('R01', 'example abilities are absent from the REST abilities endpoint', async () => {
		const auth = 'Basic ' + Buffer.from(`agent-editor:${state('agent-editor.app-password')}`).toString('base64');
		const response = await httpFetch(`${siteUrl}/wp-json/wp-abilities/v1/abilities?per_page=100`, { headers: { Authorization: auth } });
		assert(response.ok, `status ${response.status}`);
		const names = (await response.json()).map((a) => a.name);
		const leaked = names.filter((n) => n.startsWith('ilogr/'));
		assert(leaked.length === 0, `REST lists ${leaked.join(', ')}`);
	});

	// The unexposed ability, called the way site code would call it.
	await check('P01', 'site code: only the stale draft is trashed, fresh drafts stay', async () => {
		const r = runStaleDraftDeletion({ user: 'agent-editor' });
		assert(r.result?.trashed === 1, `result ${JSON.stringify(r.result)}`);
		assert(r.stale === 'trash', `stale draft is ${r.stale}`);
		assert(r.new_gmt === '0000-00-00 00:00:00', `fixture invalid: never-edited draft has GMT ${r.new_gmt}`);
		assert(r.fresh.every((s) => s === 'draft'), `fresh drafts are ${r.fresh.join(', ')}`);
	});

	await check('P02', 'site code: a draft the user may not delete is skipped', async () => {
		const r = runStaleDraftDeletion({ user: 'agent-editor', denyThisPost: true });
		assert(r.result?.trashed === 0 && r.stale === 'draft', JSON.stringify(r));
	});

	await check('P03', 'site code: a Subscriber is refused by the permission callback', async () => {
		const r = runStaleDraftDeletion({ user: 'agent-subscriber' });
		assert(r.result?.error === 'ability_invalid_permissions' && r.stale === 'draft', JSON.stringify(r));
	});

	await check('P04', 'site code: refused when the bin is disabled, rather than deleting permanently', async () => {
		const r = runStaleDraftDeletion({ user: 'agent-editor', exec: "define( 'EMPTY_TRASH_DAYS', 0 );" });
		assert(r.result?.error === 'ilogr_trash_disabled' && r.stale === 'draft', JSON.stringify(r));
	});

	await check('R02', 'core abilities refuse an anonymous REST request', async () => {
		const response = await httpFetch(`${siteUrl}/wp-json/wp-abilities/v1/abilities/core/get-environment-info/run`);
		assert(response.status === 401, `status ${response.status}: ${(await response.text()).slice(0, 120)}`);
	});

	// Defence in depth: install a filter that approves every permission check, then require the
	// object checks inside the execute callbacks to refuse anyway. The filter is always removed.
	await check('A02', 'with a rogue permission filter, the execute callbacks still refuse a Subscriber', async () => {
		const MU = 'wp-content/mu-plugins/check-rogue-permission-filter.php';
		execFileSync('docker', ['compose', 'exec', '-T', 'cli', 'sh', '-c',
			`mkdir -p wp-content/mu-plugins && printf '%s\\n' '<?php' "add_filter( 'wp_ability_permission_result', '__return_true' );" > ${MU}`],
			{ cwd: ROOT, stdio: 'ignore' });
		let client;
		try {
			resetFixtures();
			client = await stdioClient('agent-subscriber');
			const write = await execute(client, 'ilogr/set-draft-excerpt', { post_id: ids.otherAuthorDraft, excerpt: 'Rogue write' });
			assertDenied(write, 'not allowed to edit this post');
			assert(excerptOf(ids.otherAuthorDraft) === ORIGINAL, 'excerpt changed');
			const r = runStaleDraftDeletion({ user: 'agent-subscriber' });
			assert(r.result?.trashed === 0 && r.stale === 'draft', `delete: ${JSON.stringify(r)}`);
			return 'filter installed for this check only';
		} finally {
			await closeClient(client);
			execFileSync('docker', ['compose', 'exec', '-T', 'cli', 'rm', '-f', MU], { cwd: ROOT, stdio: 'ignore' });
		}
	});

	await check('P05', 'site code: older_than_days above 3650 is rejected by the schema', async () => {
		const out = php(`$r = wp_get_ability( '${HIDDEN}' )->execute( array( 'older_than_days' => 3651 ) ); echo is_wp_error( $r ) ? $r->get_error_code() : 'ran';`, { user: 'agent-editor' });
		assert(out === 'ability_invalid_input', `got ${out}`);
	});

	// Nothing else on the site may override the permission decision.
	await check('A01', 'no callbacks on the 7.1 permission and short-circuit filters', async () => {
		const hooked = wp('eval', 'global $wp_filter; $out = array(); foreach ( array( "wp_ability_permission_result", "wp_pre_execute_ability" ) as $h ) { if ( isset( $wp_filter[ $h ] ) ) { foreach ( $wp_filter[ $h ]->callbacks as $p => $cbs ) { foreach ( $cbs as $id => $cb ) { $out[] = "$h@$p:$id"; } } } } echo json_encode( $out );');
		assert(hooked === '[]', `hooked: ${hooked}`);
	});

	resetFixtures();

	const failed = results.filter((r) => !r.ok);
	console.log(`\n${results.length - failed.length} of ${results.length} checks passed.`);
	if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ passed: results.length - failed.length, failed: failed.map((f) => f.id), results }, null, 2));
	process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
	console.error(`Harness error: ${error?.stack ?? error}`);
	process.exit(2);
});

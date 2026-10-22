<?php
/**
 * Plugin Name:       Draft Abilities Example
 * Description:       Three narrow abilities for testing least privilege over the MCP Adapter. Two are exposed to MCP, one is not.
 * Version:           1.0.0
 * Requires at least: 7.1
 * Requires PHP:      7.4
 * License:           GPL-2.0-or-later
 *
 * Exposure decides what an MCP client can see. The permission callbacks below
 * decide what the connected WordPress user may do. They are separate on purpose.
 */

defined( 'ABSPATH' ) || exit;

add_action( 'wp_abilities_api_categories_init', 'ilogr_register_ability_category' );

function ilogr_register_ability_category(): void {
	wp_register_ability_category(
		'ilogr-drafts',
		array(
			'label'       => __( 'Draft housekeeping', 'ilogr' ),
			'description' => __( 'Small editorial tasks on draft posts.', 'ilogr' ),
		)
	);
}

add_action( 'wp_abilities_api_init', 'ilogr_register_draft_abilities' );

function ilogr_register_draft_abilities(): void {

	// 1. Read-only. Exposed to MCP only, not to the REST abilities endpoints.
	wp_register_ability(
		'ilogr/list-draft-titles',
		array(
			'label'               => __( 'List draft titles', 'ilogr' ),
			'description'         => __( 'Lists the IDs and titles of draft posts the current user is allowed to edit.', 'ilogr' ),
			'category'            => 'ilogr-drafts',
			'input_schema'        => array(
				'type'                 => 'object',
				'properties'           => array(
					'limit' => array(
						'type'    => 'integer',
						'minimum' => 1,
						'maximum' => 50,
						'default' => 20,
					),
				),
				'additionalProperties' => false,
			),
			'output_schema'       => array(
				'type'  => 'array',
				'items' => array(
					'type'       => 'object',
					'properties' => array(
						'id'    => array( 'type' => 'integer' ),
						'title' => array( 'type' => 'string' ),
					),
				),
			),
			'permission_callback' => static function (): bool {
				return current_user_can( 'edit_posts' );
			},
			'execute_callback'    => 'ilogr_list_draft_titles',
			'meta'                => array(
				'annotations' => array(
					'readonly'   => true,
					'idempotent' => true,
				),
				'mcp'         => array( 'public' => true ),
			),
		)
	);

	// 2. Write. Exposed to MCP only. Allowed only for a user who may edit this post.
	wp_register_ability(
		'ilogr/set-draft-excerpt',
		array(
			'label'               => __( 'Set draft excerpt', 'ilogr' ),
			'description'         => __( 'Replaces the excerpt of one draft post. Refuses posts that are not drafts.', 'ilogr' ),
			'category'            => 'ilogr-drafts',
			'input_schema'        => array(
				'type'                 => 'object',
				'properties'           => array(
					'post_id' => array(
						'type'    => 'integer',
						'minimum' => 1,
					),
					'excerpt' => array(
						'type'      => 'string',
						'minLength' => 1,
						'maxLength' => 300,
					),
				),
				'required'             => array( 'post_id', 'excerpt' ),
				'additionalProperties' => false,
			),
			'output_schema'       => array(
				'type'       => 'object',
				'properties' => array(
					'id'      => array( 'type' => 'integer' ),
					'excerpt' => array( 'type' => 'string' ),
				),
			),
			'permission_callback' => static function ( $input ): bool {
				$post_id = is_array( $input ) ? (int) ( $input['post_id'] ?? 0 ) : 0;
				// edit_post is a meta capability: WordPress maps it to edit_posts,
				// edit_others_posts or edit_published_posts for this specific post.
				return $post_id > 0 && current_user_can( 'edit_post', $post_id );
			},
			'execute_callback'    => 'ilogr_set_draft_excerpt',
			'meta'                => array(
				'annotations' => array(
					'readonly'    => false,
					'destructive' => false,
					'idempotent'  => true,
				),
				'mcp'         => array( 'public' => true ),
			),
		)
	);

	// 3. Registered for site code only. No exposure metadata, so no MCP client sees it.
	wp_register_ability(
		'ilogr/delete-stale-drafts',
		array(
			'label'               => __( 'Delete stale drafts', 'ilogr' ),
			'description'         => __( 'Moves drafts untouched for the given number of days to the bin.', 'ilogr' ),
			'category'            => 'ilogr-drafts',
			'input_schema'        => array(
				'type'                 => 'object',
				'properties'           => array(
					'older_than_days' => array(
						'type'    => 'integer',
						'minimum' => 30,
						'maximum' => 3650,
					),
				),
				'required'             => array( 'older_than_days' ),
				'additionalProperties' => false,
			),
			'output_schema'       => array(
				'type'       => 'object',
				'properties' => array(
					'trashed' => array( 'type' => 'integer' ),
				),
			),
			'permission_callback' => static function (): bool {
				return current_user_can( 'delete_others_posts' );
			},
			'execute_callback'    => 'ilogr_delete_stale_drafts',
			'meta'                => array(
				'annotations' => array(
					'readonly'    => false,
					'destructive' => true,
				),
			),
		)
	);
}

function ilogr_list_draft_titles( $input ): array {
	$limit  = is_array( $input ) ? (int) ( $input['limit'] ?? 20 ) : 20;
	$drafts = array();
	$page   = 1;

	// Filter each draft by permission first and stop once enough are found.
	// Limiting the query instead would let other people's drafts use up an
	// Author's slots. The scan still grows with the number of drafts a user
	// may not edit, which is fine for this example but not for a large site.
	do {
		$ids = get_posts(
			array(
				'post_type'      => 'post',
				'post_status'    => 'draft',
				'posts_per_page' => 100,
				'paged'          => $page,
				'orderby'        => 'ID',
				'order'          => 'ASC',
				'fields'         => 'ids',
				'no_found_rows'  => true,
			)
		);
		foreach ( $ids as $id ) {
			if ( current_user_can( 'edit_post', $id ) ) {
				$drafts[] = array(
					'id'    => (int) $id,
					'title' => get_the_title( $id ),
				);
				if ( count( $drafts ) >= $limit ) {
					return $drafts;
				}
			}
		}
		++$page;
	} while ( 100 === count( $ids ) );

	return $drafts;
}

/**
 * @return array|WP_Error
 */
function ilogr_set_draft_excerpt( $input ) {
	$post = get_post( (int) $input['post_id'] );
	if ( ! $post || 'post' !== $post->post_type || 'draft' !== $post->post_status ) {
		return new WP_Error( 'ilogr_not_a_draft', __( 'Only draft posts can be changed by this ability.', 'ilogr' ) );
	}
	// Ask again here. A wp_ability_permission_result filter can override the permission
	// callback's answer, but not this check. Capability filters such as map_meta_cap still apply.
	if ( ! current_user_can( 'edit_post', $post->ID ) ) {
		return new WP_Error( 'ilogr_cannot_edit', __( 'You are not allowed to edit this post.', 'ilogr' ) );
	}

	// The schema's minLength counts raw characters, so markup, whitespace, control or
	// format characters, or blank-looking fillers alone would pass it. Refuse rather than overwrite.
	$excerpt = sanitize_textarea_field( $input['excerpt'] );
	if ( 1 === preg_match( '/\A[\s\p{Z}\p{Cf}\p{Cc}\x{034F}\x{115F}\x{1160}\x{2800}\x{3164}\x{FE00}-\x{FE0F}\x{FFA0}]*\z/u', $excerpt ) ) {
		return new WP_Error( 'ilogr_empty_excerpt', __( 'The excerpt is empty once markup and whitespace are removed.', 'ilogr' ) );
	}

	// wp_update_post() unslashes its array, so slash it first or backslashes are lost.
	$result = wp_update_post(
		wp_slash(
			array(
				'ID'           => $post->ID,
				'post_excerpt' => $excerpt,
			)
		),
		true
	);
	if ( is_wp_error( $result ) ) {
		return $result;
	}

	return array(
		'id'      => (int) $post->ID,
		'excerpt' => get_post_field( 'post_excerpt', $post->ID, 'raw' ),
	);
}

/**
 * @return array|WP_Error
 */
function ilogr_delete_stale_drafts( $input ) {
	// With the bin disabled, wp_trash_post() deletes permanently. Refuse instead.
	if ( ! EMPTY_TRASH_DAYS ) {
		return new WP_Error( 'ilogr_trash_disabled', __( 'The bin is disabled on this site, so drafts would be deleted permanently.', 'ilogr' ) );
	}

	// post_modified, not post_modified_gmt: WordPress stores a zero GMT date
	// for undated drafts, which would make every draft look stale.
	$cutoff = wp_date( 'Y-m-d H:i:s', time() - (int) $input['older_than_days'] * DAY_IN_SECONDS );
	$ids    = get_posts(
		array(
			'post_type'      => 'post',
			'post_status'    => 'draft',
			'posts_per_page' => -1,
			'fields'         => 'ids',
			'date_query'     => array(
				array(
					'column' => 'post_modified',
					'before' => $cutoff,
				),
			),
		)
	);

	$trashed = 0;
	foreach ( $ids as $id ) {
		$post = get_post( $id );
		// Recheck each post, and ask about this post, not just the role. This check sits in the
		// execute callback, so a wp_ability_permission_result filter cannot skip it.
		if ( ! $post || 'post' !== $post->post_type || 'draft' !== $post->post_status || $post->post_modified >= $cutoff ) {
			continue;
		}
		if ( ! current_user_can( 'delete_post', $id ) ) {
			continue;
		}
		if ( wp_trash_post( $id ) ) {
			++$trashed;
		}
	}
	return array( 'trashed' => $trashed );
}

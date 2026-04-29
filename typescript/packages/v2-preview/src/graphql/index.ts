/**
 * `@atlasent/sdk-v2-preview/graphql` — GraphQL sub-export.
 *
 * At v2 GA this surface migrates to `@atlasent/sdk/graphql` per
 * PR #77. Until then, import from the preview package and pin the
 * exact version.
 */

export {
  buildGraphQLRequest,
  GraphQLClient,
  GraphQLClientError,
} from "./client.js";
export type {
  GraphQLClientOptions,
  GraphQLError,
  GraphQLRequest,
  GraphQLResponse,
} from "./types.js";

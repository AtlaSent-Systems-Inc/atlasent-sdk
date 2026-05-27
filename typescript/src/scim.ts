/**
 * SCIM 2.0 provisioning client — user and group lifecycle management.
 *
 * Wire surface: /scim/v2/* endpoints in atlasent-api (RFC 7643/7644).
 *
 * Usage:
 *
 * ```ts
 * import { AtlaSentClient } from "@atlasent/sdk";
 *
 * const client = new AtlaSentClient({ apiKey: "..." });
 *
 * const page = await client.scim.users.list({ orgId: "org_abc" });
 * for (const user of page.Resources) {
 *   console.log(user.userName);
 * }
 *
 * const newUser = await client.scim.users.create("org_abc", {
 *   userName: "alice@example.com",
 *   displayName: "Alice Example",
 *   active: true,
 *   emails: [{ value: "alice@example.com", primary: true }],
 * });
 * ```
 */

// ─── SCIM schema URNs ─────────────────────────────────────────────────────────

export const SCIM_USER_SCHEMA =
  "urn:ietf:params:scim:schemas:core:2.0:User" as const;
export const SCIM_GROUP_SCHEMA =
  "urn:ietf:params:scim:schemas:core:2.0:Group" as const;
export const SCIM_PATCH_OP_SCHEMA =
  "urn:ietf:params:scim:api:messages:2.0:PatchOp" as const;

// ─── SCIM resource types ──────────────────────────────────────────────────────

/** SCIM email value. */
export interface ScimEmail {
  value: string;
  type?: string;
  primary?: boolean;
}

/** SCIM name component. */
export interface ScimName {
  formatted?: string;
  givenName?: string;
  familyName?: string;
}

/** Group reference embedded on a user. */
export interface ScimGroupRef {
  value: string;
  display?: string;
}

/** SCIM metadata block. */
export interface ScimMeta {
  resourceType?: string;
  created?: string;
  lastModified?: string;
  location?: string;
  version?: string;
}

/** SCIM 2.0 User resource. */
export interface ScimUser {
  schemas?: string[];
  id?: string;
  userName: string;
  displayName?: string;
  active?: boolean;
  emails?: ScimEmail[];
  name?: ScimName;
  groups?: ScimGroupRef[];
  meta?: ScimMeta;
  [k: string]: unknown;
}

/** Create payload for a new SCIM user. `schemas` is injected automatically. */
export type ScimUserCreate = Omit<ScimUser, "id" | "meta">;

/** Update payload for an existing SCIM user. */
export type ScimUserUpdate = ScimUser;

/** RFC 7644 PatchOp operation. */
export interface ScimPatchOp {
  op: "add" | "remove" | "replace";
  path?: string;
  value?: unknown;
}

/** SCIM 2.0 ListResponse envelope (generic). */
export interface ScimListResponse<T = unknown> {
  schemas: string[];
  totalResults: number;
  startIndex: number;
  itemsPerPage: number;
  Resources: T[];
}

/** Query parameters for SCIM list operations. */
export interface ScimListParams {
  /** Organisation ID (required). */
  orgId: string;
  /** SCIM filter expression, e.g. `userName eq "alice@example.com"`. */
  filter?: string;
  /** 1-based pagination offset. Defaults to 1 on the server. */
  startIndex?: number;
  /** Maximum results per page. Defaults to 100 on the server. */
  count?: number;
}

// ─── Sub-client interfaces ───────────────────────────────────────────────────

/** Sub-client for /scim/v2/{orgId}/Users operations. */
export interface ScimUsersSubClient {
  /**
   * `GET /scim/v2/{orgId}/Users` — list provisioned users.
   *
   * ```ts
   * const page = await client.scim.users.list({ orgId: "org_abc" });
   * ```
   */
  list(params: ScimListParams): Promise<ScimListResponse<ScimUser>>;

  /**
   * `POST /scim/v2/{orgId}/Users` — provision a new user.
   *
   * ```ts
   * const user = await client.scim.users.create("org_abc", {
   *   userName: "alice@example.com",
   *   active: true,
   *   emails: [{ value: "alice@example.com", primary: true }],
   * });
   * ```
   */
  create(orgId: string, user: ScimUserCreate): Promise<ScimUser>;

  /**
   * `PUT /scim/v2/{orgId}/Users/{id}` — full replacement.
   *
   * ```ts
   * const updated = await client.scim.users.update("org_abc", "usr_123", user);
   * ```
   */
  update(
    orgId: string,
    id: string,
    user: ScimUserUpdate,
  ): Promise<ScimUser>;

  /**
   * `DELETE /scim/v2/{orgId}/Users/{id}` — deprovision a user.
   *
   * ```ts
   * await client.scim.users.delete("org_abc", "usr_123");
   * ```
   */
  delete(orgId: string, id: string): Promise<void>;
}

/** Sub-client for /scim/v2/{orgId}/Groups operations. */
export interface ScimGroupsSubClient {
  /** `GET /scim/v2/{orgId}/Groups` — list groups. */
  list(params: ScimListParams): Promise<ScimListResponse<Record<string, unknown>>>;
  /** `POST /scim/v2/{orgId}/Groups` — create a group. */
  create(orgId: string, group: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** `DELETE /scim/v2/{orgId}/Groups/{id}` — delete a group. */
  delete(orgId: string, id: string): Promise<void>;
}

/** Top-level SCIM sub-client exposed as `client.scim`. */
export interface ScimSubClient {
  users: ScimUsersSubClient;
  groups: ScimGroupsSubClient;
}

// ─── Factory ─────────────────────────────────────────────────────────────────

type PostFn = <T>(
  path: string,
  body: unknown,
  query?: URLSearchParams,
) => Promise<{ body: T }>;

type GetFn = <T>(
  path: string,
  query?: URLSearchParams,
) => Promise<{ body: T }>;

type PutFn = <T>(
  path: string,
  body: unknown,
) => Promise<{ body: T }>;

type DeleteFn = (path: string) => Promise<void>;

function scimUsersPath(orgId: string): string {
  return `/scim/v2/${encodeURIComponent(orgId)}/Users`;
}

function scimGroupsPath(orgId: string): string {
  return `/scim/v2/${encodeURIComponent(orgId)}/Groups`;
}

function buildScimQuery(
  filter?: string,
  startIndex?: number,
  count?: number,
): URLSearchParams | undefined {
  const params = new URLSearchParams();
  if (filter !== undefined) params.set("filter", filter);
  if (startIndex !== undefined) params.set("startIndex", String(startIndex));
  if (count !== undefined) params.set("count", String(count));
  return params.size > 0 ? params : undefined;
}

/**
 * Factory that returns the SCIM sub-client bound to a host client.
 * Called internally by AtlaSentClient; not part of the public constructor API.
 */
export function makeScimClient(
  postFn: PostFn,
  getFn: GetFn,
  putFn: PutFn,
  deleteFn: DeleteFn,
): ScimSubClient {
  const users: ScimUsersSubClient = {
    async list(params: ScimListParams): Promise<ScimListResponse<ScimUser>> {
      const qs = buildScimQuery(
        params.filter,
        params.startIndex,
        params.count,
      );
      const { body } = await getFn<ScimListResponse<ScimUser>>(
        scimUsersPath(params.orgId),
        qs,
      );
      return body;
    },

    async create(orgId: string, user: ScimUserCreate): Promise<ScimUser> {
      const payload = user.schemas
        ? user
        : { ...user, schemas: [SCIM_USER_SCHEMA] };
      const { body } = await postFn<ScimUser>(scimUsersPath(orgId), payload);
      return body;
    },

    async update(
      orgId: string,
      id: string,
      user: ScimUserUpdate,
    ): Promise<ScimUser> {
      const payload = user.schemas
        ? user
        : { ...user, schemas: [SCIM_USER_SCHEMA] };
      const { body } = await putFn<ScimUser>(
        `${scimUsersPath(orgId)}/${encodeURIComponent(id)}`,
        payload,
      );
      return body;
    },

    async delete(orgId: string, id: string): Promise<void> {
      return deleteFn(
        `${scimUsersPath(orgId)}/${encodeURIComponent(id)}`,
      );
    },
  };

  const groups: ScimGroupsSubClient = {
    async list(
      params: ScimListParams,
    ): Promise<ScimListResponse<Record<string, unknown>>> {
      const qs = buildScimQuery(
        params.filter,
        params.startIndex,
        params.count,
      );
      const { body } = await getFn<ScimListResponse<Record<string, unknown>>>(
        scimGroupsPath(params.orgId),
        qs,
      );
      return body;
    },

    async create(
      orgId: string,
      group: Record<string, unknown>,
    ): Promise<Record<string, unknown>> {
      const payload =
        group["schemas"] ? group : { ...group, schemas: [SCIM_GROUP_SCHEMA] };
      const { body } = await postFn<Record<string, unknown>>(
        scimGroupsPath(orgId),
        payload,
      );
      return body;
    },

    async delete(orgId: string, id: string): Promise<void> {
      return deleteFn(
        `${scimGroupsPath(orgId)}/${encodeURIComponent(id)}`,
      );
    },
  };

  return { users, groups };
}

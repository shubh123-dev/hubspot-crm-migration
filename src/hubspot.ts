import axios, { AxiosError, AxiosRequestConfig } from "axios";
import { config } from "./config";

// Read-only HubSpot client. This project never writes to HubSpot.

const http = axios.create({
  baseURL: config.hubspotBaseUrl,
  timeout: 60_000,
  headers: { Authorization: `Bearer ${config.hubspotToken}` },
});

const MAX_ATTEMPTS = 7;
let lastRequestAt = 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isRetryable(err: AxiosError): boolean {
  if (!err.response) return true; // network error / timeout
  const s = err.response.status;
  return s === 429 || s >= 500;
}

/** Throttled request with exponential backoff on 429 / 5xx / network errors. */
async function request<T>(cfg: AxiosRequestConfig): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const wait = lastRequestAt + config.hubspotMinInterval - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();

    try {
      const res = await http.request<T>(cfg);
      return res.data;
    } catch (e) {
      const err = e as AxiosError;
      if (!isRetryable(err) || attempt >= MAX_ATTEMPTS) {
        const status = err.response?.status;
        const body = err.response?.data ? JSON.stringify(err.response.data).slice(0, 500) : err.message;
        throw new HubSpotError(`${cfg.method?.toUpperCase() || "GET"} ${cfg.url} failed (${status ?? "network"}): ${body}`, status);
      }
      const retryAfter = Number(err.response?.headers?.["retry-after"]);
      const backoff = retryAfter > 0 ? retryAfter * 1000 : Math.min(2 ** attempt * 1000, 60_000);
      console.warn(`  HubSpot ${err.response?.status ?? err.code} on ${cfg.url}, retry ${attempt}/${MAX_ATTEMPTS - 1} in ${backoff}ms`);
      await sleep(backoff);
    }
  }
}

export class HubSpotError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
  }
}

export interface HsObject {
  id: string;
  properties: Record<string, string | null>;
  createdAt?: string;
  updatedAt?: string;
  archived?: boolean;
}

export interface HsAssociationType {
  category: string;
  typeId: number;
  label: string | null;
}

export interface HsPropertyDefinition {
  name: string;
  label: string;
  type: string;
  fieldType: string;
  groupName: string;
  options?: unknown[];
  hubspotDefined?: boolean;
}

export interface HsOwner {
  id: string;
  userId?: number;
  email?: string;
  firstName?: string;
  lastName?: string;
  teams?: unknown[];
  archived: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export async function getPropertyDefinitions(objectType: string): Promise<HsPropertyDefinition[]> {
  const data = await request<{ results: HsPropertyDefinition[] }>({ url: `/crm/v3/properties/${objectType}` });
  return data.results;
}

export async function* listOwners(archived: boolean): AsyncGenerator<HsOwner[]> {
  let after: string | undefined;
  do {
    const data = await request<{ results: HsOwner[]; paging?: { next?: { after: string } } }>({
      url: "/crm/v3/owners",
      params: { limit: 100, after, archived },
    });
    yield data.results;
    after = data.paging?.next?.after;
  } while (after);
}

/**
 * Pages through every object of a type, returning each page with ALL the given
 * properties. Listing returns IDs; full properties come from batch/read (POST)
 * because hundreds of property names don't fit in a GET query string.
 */
export async function* listObjects(objectType: string, properties: string[]): AsyncGenerator<HsObject[]> {
  let after: string | undefined;
  do {
    const page = await request<{ results: { id: string }[]; paging?: { next?: { after: string } } }>({
      url: `/crm/v3/objects/${objectType}`,
      params: { limit: 100, after, archived: false },
    });
    if (page.results.length > 0) {
      yield await readObjects(objectType, page.results.map((r) => r.id), properties);
    }
    after = page.paging?.next?.after;
  } while (after);
}

export async function readObjects(objectType: string, ids: string[], properties: string[]): Promise<HsObject[]> {
  const data = await request<{ results: HsObject[] }>({
    method: "POST",
    url: `/crm/v3/objects/${objectType}/batch/read`,
    data: { properties, inputs: ids.map((id) => ({ id })) },
  });
  return data.results;
}

export async function countObjects(objectType: string): Promise<number> {
  const data = await request<{ total: number }>({
    method: "POST",
    url: `/crm/v3/objects/${objectType}/search`,
    data: { limit: 1, properties: ["hs_object_id"] },
  });
  return data.total;
}

/**
 * Association lookup for up to 1000 source IDs. Returns fromId -> list of
 * { toId, types }. Follows per-object paging for objects with >500 links.
 */
export async function getAssociations(
  fromType: string,
  toType: string,
  fromIds: string[],
): Promise<Map<string, { toId: string; types: HsAssociationType[] }[]>> {
  const out = new Map<string, { toId: string; types: HsAssociationType[] }[]>();
  for (let i = 0; i < fromIds.length; i += 1000) {
    const chunk = fromIds.slice(i, i + 1000);
    const data = await request<{
      results: {
        from: { id: string };
        to: { toObjectId: number | string; associationTypes: HsAssociationType[] }[];
        paging?: { next?: { after: string } };
      }[];
    }>({
      method: "POST",
      url: `/crm/v4/associations/${fromType}/${toType}/batch/read`,
      data: { inputs: chunk.map((id) => ({ id })) },
    });

    for (const r of data.results) {
      const links = r.to.map((t) => ({ toId: String(t.toObjectId), types: t.associationTypes }));
      let after = r.paging?.next?.after;
      while (after) {
        const more = await request<{
          results: { toObjectId: number | string; associationTypes: HsAssociationType[] }[];
          paging?: { next?: { after: string } };
        }>({
          url: `/crm/v4/objects/${fromType}/${r.from.id}/associations/${toType}`,
          params: { limit: 500, after },
        });
        links.push(...more.results.map((t) => ({ toId: String(t.toObjectId), types: t.associationTypes })));
        after = more.paging?.next?.after;
      }
      out.set(String(r.from.id), links);
    }
  }
  return out;
}

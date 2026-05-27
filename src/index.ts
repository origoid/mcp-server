#!/usr/bin/env node
/**
 * OrigoID MCP server.
 *
 * Exposes the OrigoID API surface as a Model Context Protocol toolkit for
 * any MCP-compatible client (Claude Code / Desktop, Cursor, Windsurf,
 * ChatGPT Desktop, Codex CLI, Gemini, etc.).
 *
 * Two tool families:
 *
 *   1. API tools (require ORIGOID_API_KEY) — one per endpoint, billable.
 *      The host LLM calls these to actually validate a CURP, search OFAC,
 *      etc. Proxied through `@origoid/sdk` to `https://api.origoid.com`.
 *
 *   2. Docs tools (no API key needed) — coding helpers that read from the
 *      bundled OpenAPI spec. Useful when the host LLM is integrating
 *      OrigoID into a codebase: list endpoints, fetch the schema for one,
 *      pull copy-paste SDK snippets, validate an envelope shape, etc.
 *      Free and instant — no API call, no credits, no rate limit.
 *
 * Auth: reads `ORIGOID_API_KEY` from the process environment. Optional —
 * the server boots without it but the API tools will return an error
 * envelope until the key is configured.
 */
import {McpServer} from "@modelcontextprotocol/sdk/server/mcp.js";
import {StdioServerTransport} from "@modelcontextprotocol/sdk/server/stdio.js";
import pkg from "@origoid/sdk";
import {z} from "zod";
import openapi from "./spec/openapi.json" with {type: "json"};
import {generateTypescriptTypes} from "./codegen/typescript.js";
import {generatePydanticModel} from "./codegen/python.js";
import {getStarter, listStarters, STARTER_KEYS, type StarterKey} from "./codegen/starters.js";

const {OrigoidApiClient} = pkg;

const apiKey = process.env.ORIGOID_API_KEY;
const sdkClient = apiKey ? new OrigoidApiClient({apiKey}) : null;
if (!apiKey) {
  process.stderr.write(
    "[origoid-mcp] ORIGOID_API_KEY not set — docs tools available, API tools disabled. " +
      "Set ORIGOID_API_KEY in your MCP client configuration (e.g. claude_desktop_config.json " +
      'mcpServers.origoid.env.ORIGOID_API_KEY = "...") to enable the API tools.\n',
  );
}

function client() {
  if (!sdkClient) {
    throw new Error(
      "ORIGOID_API_KEY is not configured. Set it in your MCP client config and restart.",
    );
  }
  return sdkClient;
}

const server = new McpServer({
  name: "@origoid/mcp-server",
  version: "0.3.0",
});

/**
 * Helper: every OrigoID method returns an Envelope. We JSON-serialize the
 * full envelope so the host LLM has access to `status`, `type`, `data`,
 * `errors[]`, and the `transactionId` (useful for support tickets).
 */
function envelopeToText(envelope: unknown): {
  content: [{type: "text"; text: string}];
} {
  return {
    content: [{type: "text", text: JSON.stringify(envelope, null, 2)}],
  };
}

function wrap<T>(fn: () => Promise<T>) {
  return async () => {
    try {
      const env = await fn();
      return envelopeToText(env);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({status: "ERROR", type: "MCP_TOOL_ERROR", message}),
          },
        ],
        isError: true,
      };
    }
  };
}

/**
 * Drop keys whose value is `undefined`. The MCP host always destructures
 * every property of the input schema, so optional args show up as
 * `undefined` even when the user did not provide them. The SDK forwards
 * `undefined` as `null` over the wire, which the API rejects with
 * `INVALID_TYPE`. Strip undefineds before handing the body to the SDK.
 */
function clean<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  // Required fields are guaranteed present by the Zod input schema, so the
  // wider `T` cast is safe — we only strip optional/undefined keys here.
  return out as T;
}

// =====================================================================
// Tool registrations — one per OrigoID endpoint.
// =====================================================================

server.registerTool(
  "issue_token",
  {
    title: "Issue Bearer JWT",
    description:
      "Exchange the API key for a short-lived Bearer JWT. Useful when handing access to a downstream subsystem. Most workflows do NOT need this — the SDK already authenticates every call directly with the API key.",
    inputSchema: {
      expireAfter: z
        .number()
        .int()
        .min(1)
        .max(3600)
        .optional()
        .describe("Token lifetime in seconds (default 1800, max 3600)."),
    },
  },
  ({expireAfter}) =>
    wrap(() => client().authentication.issueToken(clean({expireAfter})))(),
);

server.registerTool(
  "validate_curp",
  {
    title: "Validate a CURP",
    description:
      "Validate a Mexican CURP (Clave Única de Registro de Población) against RENAPO. Returns the personal record on success, or a stable `type` code (CURP_DECEASED, CURP_NOT_FOUND, INVALID_REQUEST, etc.). Billable: 1 credit on a real result.",
    inputSchema: {
      curp: z.string().describe("18-character CURP, e.g. PELJ900101HDFRRN09"),
      generateRfc: z
        .boolean()
        .optional()
        .describe("Deterministically derive the 13-char RFC from the CURP. Free, no extra SAT call."),
    },
  },
  ({curp, generateRfc}) =>
    wrap(() => client().renapo.validateCurp(clean({curp, generateRfc})))(),
);

server.registerTool(
  "lookup_curp",
  {
    title: "Look up a CURP by demographics",
    description:
      "Reconstruct a person's CURP from their given names, surnames, date of birth, gender, and birth-state code. Returns the CURP and full RENAPO record on a match.",
    inputSchema: {
      givenNames: z.string(),
      firstSurname: z.string(),
      dateOfBirth: z.string().describe("YYYY-MM-DD"),
      gender: z.enum(["H", "M", "X"]),
      birthStateCode: z.string().describe("Two-letter state code (e.g. DF, SR, MC)."),
      secondSurname: z.string().optional(),
    },
  },
  (args) => wrap(() => client().renapo.lookupCurp(clean(args)))(),
);

server.registerTool(
  "validate_rfc",
  {
    title: "Validate an RFC against SAT",
    description:
      "Validate a Mexican RFC (Registro Federal de Contribuyentes) against SAT's taxpayer registry. Returns taxpayer type, status, and risk level.",
    inputSchema: {
      rfc: z.string().describe("12 or 13-char RFC, e.g. PEZJ811011KI1"),
    },
  },
  ({rfc}) => wrap(() => client().sat.validateRfc(clean({rfc})))(),
);

server.registerTool(
  "extract_csf",
  {
    title: "Extract Constancia de Situación Fiscal (CSF)",
    description:
      "Extract structured data from a Mexican CSF document. Two modes: (a) direct identifiers `rfc` + `cif`, or (b) Base64-encoded PDF in the `document` field. The schema is a oneOf — send exactly one mode.",
    inputSchema: {
      rfc: z.string().optional(),
      cif: z.string().optional().describe("CSF folio number (the CIF code printed on the document)."),
      document: z
        .string()
        .optional()
        .describe("Base64-encoded CSF PDF. Use INSTEAD OF rfc+cif."),
    },
  },
  (args) => wrap(() => client().sat.extractCsf(clean(args)))(),
);

server.registerTool(
  "validate_cfdi",
  {
    title: "Validate a CFDI (Mexican electronic invoice)",
    description:
      "Validate a CFDI's current SAT status (active or canceled), cancellation status, and fiscal effect. Two modes: (a) direct identifiers `uuid` + `rfcEmisor` + `rfcReceptor` + `total`, or (b) the full CFDI as Base64 in the `document` field (XML, PDF, or PNG/JPG of the QR).",
    inputSchema: {
      uuid: z.string().optional(),
      rfcEmisor: z.string().optional(),
      rfcReceptor: z.string().optional(),
      total: z
        .string()
        .optional()
        .describe('Total amount as a decimal STRING (no currency symbol, e.g. "999999.99").'),
      document: z.string().optional(),
    },
  },
  (args) => wrap(() => client().sat.validateCfdi(clean(args)))(),
);

server.registerTool(
  "lookup_nss",
  {
    title: "Look up a NSS by CURP",
    description:
      "Find the IMSS Número de Seguridad Social (NSS) associated with a CURP. Returns SUCCESS with the NSS or PERSON_WITHOUT_NSS / IMSS_INCONSISTENT_DATA / CURP_NOT_FOUND.",
    inputSchema: {
      curp: z.string(),
    },
  },
  ({curp}) => wrap(() => client().imss.lookupNss(clean({curp})))(),
);

server.registerTool(
  "get_employment_status",
  {
    title: "Get current employment status from IMSS",
    description:
      "Returns the person's current employment information from IMSS (active employers, modality, salary base) given a CURP + NSS pair. Possible types: SUCCESS, INACTIVE_EMPLOYMENT, MISMATCH_CURP_NSS, CURP_NOT_FOUND.",
    inputSchema: {
      curp: z.string(),
      nss: z.string().describe("11-digit NSS."),
    },
  },
  (args) => wrap(() => client().imss.getEmploymentStatus(clean(args)))(),
);

server.registerTool(
  "validate_voter_list",
  {
    title: "Validate an INE/IFE voter ID against the Lista Nominal",
    description:
      "Confirm a voter credential exists in INE's Lista Nominal (the official voter roll). Pass any combination of cic, citizenIdentifier, ocr, electorKey, depending on the credential model.",
    inputSchema: {
      cic: z.string().optional(),
      citizenIdentifier: z.string().optional(),
      ocr: z.string().optional(),
      electorKey: z.string().optional(),
    },
  },
  // INE list backend can take 60-90s on cold start — bump per-call SDK timeout.
  (args) =>
    wrap(() =>
      client().ine.validateVoterList(clean(args), {timeoutInSeconds: 120}),
    )(),
);

server.registerTool(
  "extract_voter_id_data",
  {
    title: "OCR an INE/IFE voter credential",
    description:
      "Extract structured data (personal info, address with geocoding, electoral geography, MRZ + QR validation, face crop) from an INE credential image. Pass `front` as Base64 (PNG or JPG); optionally pass `back` for MRZ/QR cross-validation.",
    inputSchema: {
      front: z.string().describe("Base64 image of the credential front."),
      back: z.string().optional().describe("Base64 image of the credential back (recommended)."),
    },
  },
  (args) => wrap(() => client().ine.extractVoterIdData(clean(args)))(),
);

server.registerTool(
  "extract_qr_data",
  {
    title: "Decrypt the QR on the back of an INE credential",
    description:
      "Decode the RSA-signed QR code on the back of a Mexican voter credential. Returns the embedded fields plus signature validation.",
    inputSchema: {
      back: z.string().describe("Base64 image of the credential back."),
    },
  },
  ({back}) => wrap(() => client().ine.extractQrData(clean({back})))(),
);

server.registerTool(
  "search_sat_69",
  {
    title: "Search SAT Article 69 lists (delinquent taxpayers)",
    description:
      "Search SAT's Article 69 publication lists (Firmes, Cancelados, Exigibles, No Localizados, Sentencias, etc.). Returns matches with the originating sub-list and a stable risk level. Pass exactly one of `name` or `rfc`.",
    inputSchema: {
      name: z.string().optional(),
      rfc: z.string().optional(),
    },
  },
  (args) => wrap(() => client().compliance.searchSat69(clean(args)))(),
);

server.registerTool(
  "search_sat_69b",
  {
    title: "Search SAT Article 69-B (EFOS — shell companies)",
    description:
      "Search SAT's Article 69-B publication (shell companies / EFOS). Returns matches with status PRESUNTO, DEFINITIVO, DESVIRTUADO, or SENTENCIA_FAVORABLE. Pass exactly one of `name` or `rfc`.",
    inputSchema: {
      name: z.string().optional(),
      rfc: z.string().optional(),
    },
  },
  (args) => wrap(() => client().compliance.searchSat69B(clean(args)))(),
);

server.registerTool(
  "search_ofac",
  {
    title: "Search OFAC sanctions lists",
    description:
      "Search the official US OFAC sanctions lists (SDN, Non-SDN, FSE, NS-ISA, SSI, CAPTA, NS-PLC) for a name. Fuzzy matching with a configurable minimum similarity score.",
    inputSchema: {
      name: z.string(),
      minSimilarityScore: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("1-100. Higher = stricter. Default 85."),
    },
  },
  (args) => wrap(() => client().compliance.searchOfac(clean(args)))(),
);

server.registerTool(
  "search_peps",
  {
    title: "Search Mexican PEPs (Politically Exposed Persons)",
    description:
      "Search the consolidated Mexican PEP database (active PEPs, former PEPs, family and close associates).",
    inputSchema: {
      givenNames: z.string().optional(),
      firstSurname: z.string().optional(),
      secondSurname: z.string().optional(),
      curp: z.string().optional(),
      rfc: z.string().optional(),
      minSimilarityScore: z.number().int().min(1).max(100).optional(),
    },
  },
  (args) => wrap(() => client().compliance.searchPeps(clean(args)))(),
);

server.registerTool(
  "match_faces",
  {
    title: "1:1 face match (selfie vs ID document)",
    description:
      "Compare a selfie with the photo on an ID document and return a similarity score plus a SUCCESS/NO_MATCH decision against the configured threshold.",
    inputSchema: {
      face: z.string().describe("Base64 selfie image (PNG or JPG)."),
      front: z.string().describe("Base64 image of the ID document front."),
      threshold: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Acceptance threshold (default 80)."),
      documentType: z
        .enum(["IFE", "INE", "MEX_PASSPORT", "MEX_RESIDENCE_CARD", "MEX_PROFESSIONAL_ID", "ANY"])
        .optional(),
    },
  },
  (args) => wrap(() => client().biometrics.matchFaces(clean(args)))(),
);

server.registerTool(
  "check_liveness",
  {
    title: "Liveness detection on a selfie",
    description:
      "Anti-spoof liveness check. Returns LIVE / NOT_LIVE with a confidence score.",
    inputSchema: {
      selfie: z.string().describe("Base64 selfie image (PNG or JPG)."),
    },
  },
  ({selfie}) => wrap(() => client().biometrics.checkLiveness(clean({selfie})))(),
);

server.registerTool(
  "validate_email",
  {
    title: "Validate email deliverability and risk",
    description:
      "Returns deliverability state, risk level, toxicity score, and infrastructure metadata (provider, MX record, disposable/role-account/catch-all flags).",
    inputSchema: {
      email: z.string(),
    },
  },
  ({email}) => wrap(() => client().email.validateEmail(clean({email})))(),
);

server.registerTool(
  "extract_proof_of_address",
  {
    title: "OCR a Mexican proof-of-address document",
    description:
      "Extract structured data (provider, holder, address, billing period) from a Mexican proof-of-address document (CFE, TELMEX, IZZI, TOTALPLAY, MEGACABLE, TELCEL, etc.). Accepts PNG, JPG, or PDF as Base64.",
    inputSchema: {
      file: z.string().describe("Base64-encoded image or PDF of the bill."),
    },
  },
  ({file}) => wrap(() => client().proofOfAddress.extractProofOfAddress(clean({file})))(),
);

// =====================================================================
// Docs tools — read the bundled OpenAPI spec. No API call, no API key,
// no billing. Useful when the host LLM is writing integration code and
// wants to look up an endpoint's schema, response types, or SDK snippet
// without burning credits.
// =====================================================================

type Spec = {
  info: {title: string; description?: string; version: string};
  paths: Record<string, Record<string, OperationObject | unknown>>;
  components?: {schemas?: Record<string, unknown>};
};

type OperationObject = {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  requestBody?: unknown;
  responses?: Record<string, ResponseObject>;
  "x-codeSamples"?: Array<{lang: string; source: string}>;
};

type ResponseObject = {
  description?: string;
  content?: {
    "application/json"?: {
      schema?: unknown;
      examples?: Record<string, {summary?: string; value?: Record<string, unknown>}>;
    };
  };
};

const SPEC = openapi as unknown as Spec;

/** Build a flat index of operations keyed by operationId. */
function indexOperations(): Map<
  string,
  {method: string; path: string; op: OperationObject}
> {
  const out = new Map<string, {method: string; path: string; op: OperationObject}>();
  for (const [path, methods] of Object.entries(SPEC.paths)) {
    for (const [method, opRaw] of Object.entries(methods)) {
      if (typeof opRaw !== "object" || opRaw === null) continue;
      const op = opRaw as OperationObject;
      if (op.operationId) {
        out.set(op.operationId, {method: method.toUpperCase(), path, op});
      }
    }
  }
  return out;
}

const OPS = indexOperations();
const ALL_OPERATION_IDS = [...OPS.keys()].sort();

/** Infer the regulatory "domain" from a path like /mex/renapo/v1/... */
function domainOf(path: string): string {
  const parts = path.split("/").filter(Boolean);
  // /mex/renapo/...  → renapo
  // /global/compliance/...  → compliance
  // /auth/token  → auth
  return parts[1] ?? parts[0] ?? "other";
}

function textTool(value: unknown): {content: [{type: "text"; text: string}]} {
  const text =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return {content: [{type: "text", text}]};
}

server.registerTool(
  "list_endpoints",
  {
    title: "List every OrigoID API endpoint",
    description:
      "Return the catalog of every endpoint exposed by the OrigoID API: operationId, method, path, summary, and inferred domain. Optionally filter by domain (renapo, sat, imss, ine, compliance, biometrics, email, documents, auth). No API call, no credits.",
    inputSchema: {
      domain: z
        .string()
        .optional()
        .describe("Filter by domain (renapo / sat / imss / ine / compliance / biometrics / email / documents / auth)."),
    },
  },
  async ({domain}) => {
    const filter = domain?.toLowerCase();
    const rows = [...OPS.entries()]
      .map(([operationId, {method, path, op}]) => ({
        operationId,
        method,
        path,
        domain: domainOf(path),
        summary: op.summary ?? null,
        tags: op.tags ?? [],
      }))
      .filter((r) => !filter || r.domain === filter);
    return textTool({count: rows.length, endpoints: rows});
  },
);

server.registerTool(
  "get_endpoint",
  {
    title: "Get full metadata for one endpoint",
    description:
      "Return the full OpenAPI operation object for a given operationId: summary, description, request schema, response schema, response examples, and the credit cost. Use this when writing integration code to know exactly what to send and what to expect.",
    inputSchema: {
      operationId: z
        .string()
        .describe(`One of: ${ALL_OPERATION_IDS.join(", ")}`),
    },
  },
  async ({operationId}) => {
    const entry = OPS.get(operationId);
    if (!entry) {
      return textTool({
        error: `Unknown operationId: ${operationId}`,
        availableOperationIds: ALL_OPERATION_IDS,
      });
    }
    return textTool({
      operationId,
      method: entry.method,
      path: entry.path,
      domain: domainOf(entry.path),
      ...entry.op,
    });
  },
);

server.registerTool(
  "get_sdk_example",
  {
    title: "Get a copy-paste SDK snippet for an endpoint",
    description:
      "Return a ready-to-paste code snippet for an endpoint in the requested language. Sourced from the OpenAPI `x-codeSamples`. Languages available: curl, JavaScript, Python, PHP, Go, Java, Ruby, C#. No API call.",
    inputSchema: {
      operationId: z
        .string()
        .describe(`One of: ${ALL_OPERATION_IDS.join(", ")}`),
      language: z
        .string()
        .describe(
          "Language label. Accepts: curl, javascript (Node), typescript, python, php, go, java, ruby, csharp, dotnet.",
        ),
    },
  },
  async ({operationId, language}) => {
    const entry = OPS.get(operationId);
    if (!entry) {
      return textTool({error: `Unknown operationId: ${operationId}`});
    }
    const samples = entry.op["x-codeSamples"] ?? [];
    const want = language.toLowerCase();
    const map: Record<string, string[]> = {
      curl: ["curl", "bash"],
      javascript: ["javascript", "js", "node", "node.js"],
      typescript: ["typescript", "ts"],
      python: ["python", "py"],
      php: ["php"],
      go: ["go", "golang"],
      java: ["java"],
      ruby: ["ruby"],
      csharp: ["csharp", "c#", "dotnet", ".net"],
    };
    const wantAliases = Object.values(map).find((aliases) => aliases.includes(want)) ?? [want];
    const match = samples.find((s) => wantAliases.includes(s.lang.toLowerCase()));
    if (!match) {
      return textTool({
        error: `No sample for language "${language}".`,
        availableLanguages: samples.map((s) => s.lang),
      });
    }
    return textTool({
      operationId,
      language: match.lang,
      method: entry.method,
      path: entry.path,
      source: match.source,
    });
  },
);

server.registerTool(
  "get_response_types",
  {
    title: "List every possible result type code for an endpoint",
    description:
      "Return the distinct `type` codes the endpoint can emit (SUCCESS, CURP_DECEASED, CURP_NOT_FOUND, INVALID_REQUEST, etc.) with the example envelope for each. Use this to drive your switch/match logic when wiring up the integration.",
    inputSchema: {
      operationId: z
        .string()
        .describe(`One of: ${ALL_OPERATION_IDS.join(", ")}`),
    },
  },
  async ({operationId}) => {
    const entry = OPS.get(operationId);
    if (!entry) {
      return textTool({error: `Unknown operationId: ${operationId}`});
    }
    const seen = new Map<
      string,
      {status?: string; billable?: boolean; message?: string; sampleEnvelope: unknown}
    >();
    const responses = entry.op.responses ?? {};
    for (const [_httpCode, resp] of Object.entries(responses)) {
      const examples = resp?.content?.["application/json"]?.examples ?? {};
      for (const ex of Object.values(examples)) {
        const value = ex.value ?? {};
        const t = typeof value.type === "string" ? value.type : "?";
        if (!seen.has(t)) {
          seen.set(t, {
            status: typeof value.status === "string" ? value.status : undefined,
            billable: typeof value.billable === "boolean" ? value.billable : undefined,
            message: typeof value.message === "string" ? value.message : undefined,
            sampleEnvelope: value,
          });
        }
      }
    }
    return textTool({
      operationId,
      method: entry.method,
      path: entry.path,
      responseTypes: [...seen.entries()].map(([type, info]) => ({type, ...info})),
    });
  },
);

server.registerTool(
  "get_api_overview",
  {
    title: "Get the OrigoID API overview markdown",
    description:
      "Return the human-readable API overview as published in the OpenAPI `info.description`. Contains authentication modes, the standard envelope contract, rate-limit headers, language and date conventions, the image-processing policy, and the full catalogs (CURP status codes, IMSS modalities, SAT lists, OFAC lists, CFDI effects, etc.). Use when you need the long-form spec.",
    inputSchema: {},
  },
  async () => {
    return textTool({
      title: SPEC.info.title,
      version: SPEC.info.version,
      description: SPEC.info.description ?? "(no description in openapi.json)",
    });
  },
);

server.registerTool(
  "search_docs",
  {
    title: "Free-text search across the OpenAPI spec",
    description:
      "Search endpoint summaries, descriptions, and examples for a query string. Returns matching operations with the snippet around the match. Useful when the operationId isn't obvious from the user's wording.",
    inputSchema: {
      query: z.string().min(2).describe("Free-text query (case-insensitive)."),
    },
  },
  async ({query}) => {
    const q = query.toLowerCase();
    const hits: Array<{
      operationId: string;
      method: string;
      path: string;
      snippet: string;
    }> = [];
    for (const [operationId, {method, path, op}] of OPS.entries()) {
      const blob = JSON.stringify({
        summary: op.summary,
        description: op.description,
        tags: op.tags,
        responses: op.responses,
      }).toLowerCase();
      const idx = blob.indexOf(q);
      if (idx >= 0) {
        hits.push({
          operationId,
          method,
          path,
          snippet: blob.slice(Math.max(0, idx - 60), idx + q.length + 60),
        });
      }
    }
    return textTool({query, count: hits.length, hits});
  },
);

server.registerTool(
  "get_typescript_types",
  {
    title: "Generate self-contained TypeScript types for an endpoint",
    description:
      "Produce a single .ts file with `Request`, `Type` (union of every possible result code), `Data` (shape of envelope.data on SUCCESS, inferred from the OpenAPI example), and `Envelope` interfaces. Self-contained — no SDK import required. Paste into your project and import.",
    inputSchema: {
      operationId: z
        .string()
        .describe(`One of: ${ALL_OPERATION_IDS.join(", ")}`),
    },
  },
  async ({operationId}) => {
    const entry = OPS.get(operationId);
    if (!entry) {
      return textTool({error: `Unknown operationId: ${operationId}`});
    }
    const code = generateTypescriptTypes(operationId, entry.op as Parameters<typeof generateTypescriptTypes>[1]);
    return textTool({
      operationId,
      language: "typescript",
      filename: `${operationId}.types.ts`,
      source: code,
    });
  },
);

server.registerTool(
  "get_pydantic_model",
  {
    title: "Generate self-contained Pydantic v2 models for an endpoint",
    description:
      "Produce a single .py file with `Request`, `Type` (Literal of every possible result code), `Data` (shape of envelope.data on SUCCESS), `ErrorDetail`, and `Envelope` Pydantic v2 classes. Only runtime dep is `pydantic>=2`.",
    inputSchema: {
      operationId: z
        .string()
        .describe(`One of: ${ALL_OPERATION_IDS.join(", ")}`),
    },
  },
  async ({operationId}) => {
    const entry = OPS.get(operationId);
    if (!entry) {
      return textTool({error: `Unknown operationId: ${operationId}`});
    }
    const code = generatePydanticModel(operationId, entry.op as Parameters<typeof generatePydanticModel>[1]);
    return textTool({
      operationId,
      language: "python",
      filename: `${operationId}_models.py`,
      source: code,
    });
  },
);

server.registerTool(
  "get_full_integration_starter",
  {
    title: "Get a complete runnable integration starter project",
    description:
      "Return a full multi-file project the user can drop into a folder and run. Each file comes with `path` + `contents`. Includes setup commands and the run command. Available scenarios: " +
      STARTER_KEYS.join(", ") +
      ". Use this when the user asks for a working integration, not just a snippet.",
    inputSchema: {
      scenario: z
        .string()
        .describe(`One of: ${STARTER_KEYS.join(", ")}.`),
    },
  },
  async ({scenario}) => {
    const starter = getStarter(scenario as StarterKey);
    if (!starter) {
      return textTool({
        error: `Unknown scenario: ${scenario}`,
        available: listStarters(),
      });
    }
    return textTool({
      scenario: starter.id,
      description: starter.description,
      setupCommands: starter.setupCommands,
      runCommand: starter.runCommand,
      files: starter.files,
    });
  },
);

server.registerTool(
  "validate_envelope_shape",
  {
    title: "Offline check whether a JSON value matches the OrigoID envelope contract",
    description:
      "Parse the supplied JSON and verify it has the canonical envelope fields (`status` in OK/ERROR, `type`, `message`, `data`, `transactionId`, `processedAt`, `billable`). Returns `valid` plus a list of issues. No API call, no credits — pure local validation. Use when integrating to be sure you've parsed our response correctly.",
    inputSchema: {
      envelopeJson: z
        .string()
        .describe("JSON-encoded envelope to validate."),
    },
  },
  async ({envelopeJson}) => {
    let parsed: Record<string, unknown>;
    try {
      const raw = JSON.parse(envelopeJson);
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        return textTool({valid: false, issues: ["root must be a JSON object"]});
      }
      parsed = raw as Record<string, unknown>;
    } catch (e) {
      return textTool({
        valid: false,
        issues: [`malformed JSON: ${(e as Error).message}`],
      });
    }
    const issues: string[] = [];
    const need = (k: string, type: string, allowNull = false) => {
      if (!(k in parsed)) {
        issues.push(`missing required field "${k}"`);
        return;
      }
      const v = parsed[k];
      if (v === null) {
        if (!allowNull) issues.push(`field "${k}" must not be null`);
        return;
      }
      if (typeof v !== type) {
        issues.push(`field "${k}" must be ${type}, got ${typeof v}`);
      }
    };
    need("status", "string");
    if (parsed.status !== "OK" && parsed.status !== "ERROR") {
      issues.push(`status must be "OK" or "ERROR", got ${JSON.stringify(parsed.status)}`);
    }
    need("type", "string");
    need("message", "string");
    if (!("data" in parsed)) issues.push('missing required field "data" (may be null)');
    need("transactionId", "string");
    need("processedAt", "string");
    need("billable", "boolean");
    if ("errors" in parsed && parsed.errors !== undefined) {
      if (!Array.isArray(parsed.errors)) {
        issues.push('field "errors" must be an array when present');
      } else {
        parsed.errors.forEach((e, i) => {
          if (!e || typeof e !== "object" || Array.isArray(e)) {
            issues.push(`errors[${i}] must be an object`);
            return;
          }
          const err = e as Record<string, unknown>;
          for (const k of ["field", "code", "message"]) {
            if (typeof err[k] !== "string") {
              issues.push(`errors[${i}].${k} must be a string`);
            }
          }
        });
      }
    }
    return textTool({valid: issues.length === 0, issues});
  },
);

// =====================================================================
// Connect over stdio.
// =====================================================================
const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(
  `[origoid-mcp] connected — ${OPS.size} API tools + 10 docs tools` +
    (sdkClient ? "" : " (API tools disabled: ORIGOID_API_KEY missing)") +
    "\n",
);

#!/usr/bin/env node
/**
 * OrigoID MCP server.
 *
 * Exposes every OrigoID API endpoint as a Model Context Protocol tool so any
 * MCP-compatible client (Claude Code / Desktop, Cursor, Windsurf, ChatGPT
 * Desktop, Codex CLI, Gemini, etc.) can call OrigoID directly.
 *
 * The server speaks MCP over stdio. The host LLM client launches it, lists
 * the available tools, and forwards user-driven tool calls. Each call is
 * proxied to `@origoid/sdk` which in turn hits `https://api.origoid.com`.
 *
 * Auth: reads `ORIGOID_API_KEY` from the process environment. The host
 * client is responsible for injecting it (e.g. via the `env` field in its
 * MCP configuration file).
 */
import {McpServer} from "@modelcontextprotocol/sdk/server/mcp.js";
import {StdioServerTransport} from "@modelcontextprotocol/sdk/server/stdio.js";
import pkg from "@origoid/sdk";
import {z} from "zod";

const {OrigoidApiClient} = pkg;

const apiKey = process.env.ORIGOID_API_KEY;
if (!apiKey) {
  process.stderr.write(
    "[origoid-mcp] ORIGOID_API_KEY env var is required. " +
      "Set it in your MCP client configuration (e.g. claude_desktop_config.json " +
      'mcpServers.origoid.env.ORIGOID_API_KEY = "..."), then restart the client.\n',
  );
  process.exit(1);
}

const client = new OrigoidApiClient({apiKey});

const server = new McpServer({
  name: "@origoid/mcp-server",
  version: "0.1.0",
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
    wrap(() => client.authentication.issueToken({expireAfter}))(),
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
    wrap(() => client.renapo.validateCurp({curp, generateRfc}))(),
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
  (args) => wrap(() => client.renapo.lookupCurp(args))(),
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
  ({rfc}) => wrap(() => client.sat.validateRfc({rfc}))(),
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
  (args) => wrap(() => client.sat.extractCsf(args))(),
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
  (args) => wrap(() => client.sat.validateCfdi(args))(),
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
  ({curp}) => wrap(() => client.imss.lookupNss({curp}))(),
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
  (args) => wrap(() => client.imss.getEmploymentStatus(args))(),
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
  (args) => wrap(() => client.ine.validateVoterList(args))(),
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
  (args) => wrap(() => client.ine.extractVoterIdData(args))(),
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
  ({back}) => wrap(() => client.ine.extractQrData({back}))(),
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
  (args) => wrap(() => client.compliance.searchSat69(args))(),
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
  (args) => wrap(() => client.compliance.searchSat69B(args))(),
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
  (args) => wrap(() => client.compliance.searchOfac(args))(),
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
  (args) => wrap(() => client.compliance.searchPeps(args))(),
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
  (args) => wrap(() => client.biometrics.matchFaces(args))(),
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
  ({selfie}) => wrap(() => client.biometrics.checkLiveness({selfie}))(),
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
  ({email}) => wrap(() => client.email.validateEmail({email}))(),
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
  ({file}) => wrap(() => client.proofOfAddress.extractProofOfAddress({file}))(),
);

// =====================================================================
// Connect over stdio.
// =====================================================================
const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write("[origoid-mcp] connected\n");

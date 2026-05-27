/**
 * Generate TypeScript interfaces + a result-type union from an OrigoID
 * OpenAPI operation. The request shape is derived from `requestBody.schema`;
 * the response data shape is derived from the FIRST successful example
 * (`status: "OK", type: "SUCCESS"`) because the openapi `data` property is
 * declared as a generic `object` — the example carries the real shape.
 *
 * Output is a single self-contained .ts string the user can paste into
 * their project. No imports, no SDK dependency.
 */

type Op = {
  operationId?: string;
  description?: string;
  requestBody?: {
    content?: {
      "application/json"?: {
        schema?: Schema;
      };
    };
  };
  responses?: Record<
    string,
    {
      content?: {
        "application/json"?: {
          examples?: Record<string, {value?: {type?: string; data?: unknown}}>;
        };
      };
    }
  >;
};

type Schema = {
  type?: string;
  description?: string;
  enum?: Array<string | number>;
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  nullable?: boolean;
  example?: unknown;
  oneOf?: Schema[];
  allOf?: Schema[];
  anyOf?: Schema[];
};

/** Build a PascalCase prefix from operationId. e.g. validateCurp → ValidateCurp. */
function pascalCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Indent every line of a block by N spaces. */
function indent(block: string, n: number): string {
  const pad = " ".repeat(n);
  return block
    .split("\n")
    .map((l) => (l.length ? pad + l : l))
    .join("\n");
}

/** Map a JSON-Schema-ish type to a TypeScript type literal. Recursive. */
function tsTypeFromSchema(schema: Schema | undefined): string {
  if (!schema) return "unknown";

  // Enum first — works regardless of base type
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    const parts = schema.enum.map((v) =>
      typeof v === "string" ? `"${v}"` : String(v),
    );
    return parts.join(" | ");
  }

  // oneOf / anyOf → union
  const union = schema.oneOf ?? schema.anyOf;
  if (Array.isArray(union) && union.length > 0) {
    return union.map((s) => tsTypeFromSchema(s)).join(" | ");
  }

  // allOf → flatten and treat as the merged object
  if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    return schema.allOf.map((s) => tsTypeFromSchema(s)).join(" & ");
  }

  switch (schema.type) {
    case "string":
      return "string";
    case "integer":
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "array":
      return `${tsTypeFromSchema(schema.items)}[]`;
    case "object": {
      if (!schema.properties) return "Record<string, unknown>";
      const required = new Set(schema.required ?? []);
      const lines = Object.entries(schema.properties).map(([prop, sub]) => {
        const opt = required.has(prop) ? "" : "?";
        const desc = sub.description ? `/** ${sub.description} */\n` : "";
        return `${desc}${prop}${opt}: ${tsTypeFromSchema(sub)};`;
      });
      return `{\n${indent(lines.join("\n"), 2)}\n}`;
    }
    default:
      return "unknown";
  }
}

/**
 * Infer a TypeScript type from a runtime JS value.
 * Used to derive the response `data` shape from a captured example.
 */
function tsTypeFromValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    if (value.length === 0) return "unknown[]";
    return `${tsTypeFromValue(value[0])}[]`;
  }
  switch (typeof value) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "object": {
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj);
      if (keys.length === 0) return "Record<string, unknown>";
      const lines = keys.map((k) => {
        const v = obj[k];
        const nullable = v === null ? " | null" : "";
        const safeKey = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(k) ? k : `"${k}"`;
        return `${safeKey}: ${tsTypeFromValue(v)}${nullable};`;
      });
      return `{\n${indent(lines.join("\n"), 2)}\n}`;
    }
    default:
      return "unknown";
  }
}

/** Collect distinct `type` codes from all 2xx response examples. */
function collectResponseTypes(op: Op): string[] {
  const out = new Set<string>();
  for (const resp of Object.values(op.responses ?? {})) {
    const examples = resp.content?.["application/json"]?.examples ?? {};
    for (const ex of Object.values(examples)) {
      const t = ex.value?.type;
      if (typeof t === "string") out.add(t);
    }
  }
  return [...out].sort();
}

/** Find the SUCCESS example to use as the canonical data shape source. */
function findSuccessData(op: Op): unknown | undefined {
  for (const resp of Object.values(op.responses ?? {})) {
    const examples = resp.content?.["application/json"]?.examples ?? {};
    for (const ex of Object.values(examples)) {
      if (ex.value?.type === "SUCCESS" && ex.value && "data" in ex.value) {
        const data = (ex.value as Record<string, unknown>).data;
        if (data !== null) return data;
      }
    }
  }
  return undefined;
}

export function generateTypescriptTypes(operationId: string, op: Op): string {
  const Base = pascalCase(operationId);
  const reqSchema = op.requestBody?.content?.["application/json"]?.schema;

  const parts: string[] = [];
  parts.push(`// Auto-generated TypeScript types for OrigoID operation: ${operationId}`);
  parts.push(`// Self-contained — no SDK import required.`);
  if (op.description) {
    // 1-line summary if description is multi-line
    const firstLine = op.description.split("\n")[0].slice(0, 200);
    parts.push(`// ${firstLine}`);
  }
  parts.push("");

  // Request
  const reqType = reqSchema ? tsTypeFromSchema(reqSchema) : "Record<string, unknown>";
  parts.push(`export interface ${Base}Request ${reqType}`);
  parts.push("");

  // Response type union
  const types = collectResponseTypes(op);
  if (types.length > 0) {
    parts.push(`export type ${Base}Type =`);
    parts.push(types.map((t) => `  | "${t}"`).join("\n") + ";");
    parts.push("");
  }

  // Response data shape (from SUCCESS example)
  const successData = findSuccessData(op);
  if (successData !== undefined && typeof successData === "object") {
    parts.push(`/** Shape of \`envelope.data\` when \`envelope.type === "SUCCESS"\`. */`);
    parts.push(`export interface ${Base}Data ${tsTypeFromValue(successData)}`);
    parts.push("");
  }

  // Generic envelope (always the same)
  parts.push(`/** OrigoID standard envelope returned by every endpoint. */`);
  parts.push(`export interface ${Base}Envelope {`);
  parts.push(`  status: "OK" | "ERROR";`);
  parts.push(`  type: ${types.length > 0 ? `${Base}Type` : "string"};`);
  parts.push(`  message: string;`);
  parts.push(`  data: ${successData !== undefined ? `${Base}Data | null` : "unknown"};`);
  parts.push(`  transactionId: string;`);
  parts.push(`  processedAt: string;`);
  parts.push(`  billable: boolean;`);
  parts.push(`  errors?: Array<{field: string; code: string; message: string}>;`);
  parts.push(`}`);

  return parts.join("\n") + "\n";
}

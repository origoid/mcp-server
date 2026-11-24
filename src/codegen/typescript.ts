/**
 * Generate TypeScript interfaces + a result-type union from an OrigoID
 * OpenAPI operation. The request shape is derived from `requestBody.schema`;
 * the response data shape is derived from EVERY example that carries `data`,
 * merged, because the openapi `data` property is declared as a generic
 * `object` — the examples carry the real shape, and a field that is null in
 * one example is typed from the others.
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

/**
 * For an object schema whose oneOf/anyOf entries only list `required` fields,
 * return those alternatives (e.g. [["rfc"], ["name"]]). Otherwise undefined.
 */
export function requiredAlternatives(schema: Schema | undefined): string[][] | undefined {
  const union = schema?.oneOf ?? schema?.anyOf;
  if (!schema?.properties || !Array.isArray(union) || union.length === 0) return undefined;
  const onlyRequired = union.every(
    (s) => !s.type && !s.properties && !s.enum && Array.isArray(s.required) && s.required.length > 0,
  );
  return onlyRequired ? union.map((s) => s.required as string[]) : undefined;
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

  // oneOf / anyOf → union. The exception is an object whose alternatives only
  // say which fields are required ("send rfc or name"): that is still one
  // object, with those fields optional.
  const union = schema.oneOf ?? schema.anyOf;
  if (Array.isArray(union) && union.length > 0 && requiredAlternatives(schema) === undefined) {
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
 * Infer a TypeScript type from the values a field takes across examples.
 * Used to derive the response `data` shape from the captured examples.
 * A field that is null in one example and a string in another becomes
 * `string | null`; a field that is null in every example becomes `unknown`.
 */
function tsTypeFromValues(values: unknown[]): string {
  const present = values.filter((v) => v !== undefined);
  const nullable = present.some((v) => v === null);
  const nonNull = present.filter((v) => v !== null);
  const withNull = (t: string): string => (nullable ? `${t} | null` : t);

  if (nonNull.length === 0) return "unknown";

  if (nonNull.every((v) => Array.isArray(v))) {
    const items = (nonNull as unknown[][]).flat();
    if (items.length === 0) return withNull("unknown[]");
    const item = tsTypeFromValues(items);
    const needsParens = item.includes(" | ") && !item.startsWith("{");
    return withNull(needsParens ? `(${item})[]` : `${item}[]`);
  }

  if (nonNull.every((v) => typeof v === "object" && !Array.isArray(v))) {
    const objs = nonNull as Array<Record<string, unknown>>;
    const keys: string[] = [];
    for (const o of objs) for (const k of Object.keys(o)) if (!keys.includes(k)) keys.push(k);
    if (keys.length === 0) return withNull("Record<string, unknown>");
    const lines = keys.map((k) => {
      const vals = objs.map((o) => (k in o ? o[k] : undefined));
      const optional = vals.some((v) => v === undefined) ? "?" : "";
      const safeKey = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(k) ? k : `"${k}"`;
      return `${safeKey}${optional}: ${tsTypeFromValues(vals)};`;
    });
    return withNull(`{\n${indent(lines.join("\n"), 2)}\n}`);
  }

  const kinds = [...new Set(nonNull.map((v) => typeof v))];
  if (kinds.every((k) => k === "string" || k === "number" || k === "boolean")) {
    return withNull(kinds.join(" | "));
  }
  return "unknown";
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

/** Collect the `data` of every example that carries one: together they give the data shape. */
function findDataSamples(op: Op): unknown[] {
  const out: unknown[] = [];
  for (const resp of Object.values(op.responses ?? {})) {
    const examples = resp.content?.["application/json"]?.examples ?? {};
    for (const ex of Object.values(examples)) {
      if (ex.value && "data" in ex.value) {
        const data = (ex.value as Record<string, unknown>).data;
        if (data !== null && data !== undefined) out.push(data);
      }
    }
  }
  return out;
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
  const alternatives = requiredAlternatives(reqSchema);
  if (alternatives) {
    const options = alternatives.map((fields) => fields.map((f) => `\`${f}\``).join(" + "));
    parts.push(`/** Send one of: ${options.join(" | ")}. */`);
  }
  parts.push(
    reqType.startsWith("{")
      ? `export interface ${Base}Request ${reqType}`
      : `export type ${Base}Request = ${reqType};`,
  );
  parts.push("");

  // Response type union
  const types = collectResponseTypes(op);
  if (types.length > 0) {
    parts.push(`export type ${Base}Type =`);
    parts.push(types.map((t) => `  | "${t}"`).join("\n") + ";");
    parts.push("");
  }

  // Response data shape (merged from every example that carries data)
  const dataSamples = findDataSamples(op);
  const hasData = dataSamples.length > 0;
  if (hasData) {
    const shape = tsTypeFromValues(dataSamples);
    const allObjects = dataSamples.every((v) => typeof v === "object" && !Array.isArray(v));
    parts.push(`/** Shape of \`envelope.data\`, merged from every documented example. A field typed \`| null\` is null in at least one of them. */`);
    parts.push(
      allObjects && shape.startsWith("{")
        ? `export interface ${Base}Data ${shape}`
        : `export type ${Base}Data = ${shape};`,
    );
    parts.push("");
  }

  // Generic envelope (always the same)
  parts.push(`/** OrigoID standard envelope returned by every endpoint. */`);
  parts.push(`export interface ${Base}Envelope {`);
  parts.push(`  status: "OK" | "ERROR";`);
  parts.push(`  type: ${types.length > 0 ? `${Base}Type` : "string"};`);
  parts.push(`  message: string;`);
  parts.push(`  data: ${hasData ? `${Base}Data | null` : "unknown"};`);
  parts.push(`  transactionId: string;`);
  parts.push(`  processedAt: string;`);
  parts.push(`  billable: boolean;`);
  parts.push(`  errors?: Array<{field: string; code: string; message: string}>;`);
  parts.push(`}`);

  return parts.join("\n") + "\n";
}

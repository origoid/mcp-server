/**
 * Generate Python (Pydantic v2) models from an OrigoID OpenAPI operation.
 * Mirror of typescript.ts. Returns a single .py string the user can paste
 * straight into their project. The only runtime dependency the snippet
 * carries is `pydantic`.
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
  oneOf?: Schema[];
  allOf?: Schema[];
  anyOf?: Schema[];
};

const PY_KEYWORDS = new Set([
  "False", "None", "True", "and", "as", "assert", "async", "await", "break",
  "class", "continue", "def", "del", "elif", "else", "except", "finally",
  "for", "from", "global", "if", "import", "in", "is", "lambda", "nonlocal",
  "not", "or", "pass", "raise", "return", "try", "while", "with", "yield",
]);

function pascalCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function snakeCase(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

function indent(block: string, n: number): string {
  const pad = " ".repeat(n);
  return block.split("\n").map((l) => (l.length ? pad + l : l)).join("\n");
}

function requiredAlternatives(schema: Schema | undefined): string[][] | undefined {
  const union = schema?.oneOf ?? schema?.anyOf;
  if (!schema?.properties || !Array.isArray(union) || union.length === 0) return undefined;
  const onlyRequired = union.every(
    (s) => !s.type && !s.properties && !s.enum && Array.isArray(s.required) && s.required.length > 0,
  );
  return onlyRequired ? union.map((s) => s.required as string[]) : undefined;
}

function pyTypeFromSchema(schema: Schema | undefined, classes: string[], nameHint: string): string {
  if (!schema) return "Any";

  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    const parts = schema.enum.map((v) =>
      typeof v === "string" ? `"${v}"` : String(v),
    );
    return `Literal[${parts.join(", ")}]`;
  }

  // An object whose alternatives only say which fields are required ("send
  // rfc or name") is still one model, with those fields optional.
  const union = schema.oneOf ?? schema.anyOf;
  if (Array.isArray(union) && union.length > 0 && requiredAlternatives(schema) === undefined) {
    return `Union[${union.map((s, i) => pyTypeFromSchema(s, classes, `${nameHint}Variant${i + 1}`)).join(", ")}]`;
  }

  if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    // Best effort: treat as the first object schema (Pydantic can't merge structurally)
    return pyTypeFromSchema(schema.allOf[0], classes, nameHint);
  }

  switch (schema.type) {
    case "string":
      return "str";
    case "integer":
      return "int";
    case "number":
      return "float";
    case "boolean":
      return "bool";
    case "array":
      return `List[${pyTypeFromSchema(schema.items, classes, `${nameHint}Item`)}]`;
    case "object": {
      if (!schema.properties) return "Dict[str, Any]";
      // Promote to a named class
      const className = pascalCase(nameHint);
      const required = new Set(schema.required ?? []);
      const fieldLines = Object.entries(schema.properties).map(([prop, sub]) => {
        const safe = PY_KEYWORDS.has(prop) ? `${prop}_` : prop;
        const t = pyTypeFromSchema(sub, classes, pascalCase(prop));
        const optional = required.has(prop) ? t : `Optional[${t}] = None`;
        const desc = sub.description ? ` # ${sub.description.slice(0, 120)}` : "";
        return `${safe}: ${optional}${desc}`;
      });
      const cls = `class ${className}(BaseModel):\n${indent(fieldLines.join("\n"), 4)}\n`;
      classes.push(cls);
      return className;
    }
    default:
      return "Any";
  }
}

/**
 * Infer a Python type from the values a field takes across examples. A field
 * that is null in one example and a string in another becomes `Optional[str]`;
 * a field that is null in every example stays `Optional[Any]`.
 */
function pyTypeFromValues(values: unknown[], classes: string[], nameHint: string): string {
  const present = values.filter((v) => v !== undefined);
  const nonNull = present.filter((v) => v !== null);
  if (nonNull.length === 0) return "Any";

  if (nonNull.every((v) => Array.isArray(v))) {
    const items = (nonNull as unknown[][]).flat();
    if (items.length === 0) return "List[Any]";
    return `List[${pyFieldType(items, classes, `${nameHint}Item`).type}]`;
  }

  if (nonNull.every((v) => typeof v === "object" && !Array.isArray(v))) {
    const objs = nonNull as Array<Record<string, unknown>>;
    const keys: string[] = [];
    for (const o of objs) for (const k of Object.keys(o)) if (!keys.includes(k)) keys.push(k);
    if (keys.length === 0) return "Dict[str, Any]";
    const className = pascalCase(nameHint);
    const fieldLines = keys.map((k) => {
      const safe = PY_KEYWORDS.has(k) ? `${k}_` : k;
      const vals = objs.map((o) => (k in o ? o[k] : undefined));
      const field = pyFieldType(vals, classes, pascalCase(k));
      return `${safe}: ${field.optional ? `Optional[${field.type}] = None` : field.type}`;
    });
    const cls = `class ${className}(BaseModel):\n${indent(fieldLines.join("\n"), 4)}\n`;
    classes.push(cls);
    return className;
  }

  const kinds = [...new Set(nonNull.map((v) => typeof v))];
  if (kinds.length === 1) {
    if (kinds[0] === "string") return "str";
    if (kinds[0] === "boolean") return "bool";
    if (kinds[0] === "number") {
      return nonNull.every((v) => Number.isInteger(v)) ? "int" : "float";
    }
  }
  return "Any";
}

/** Type of a field plus whether it can be absent or null in the examples. */
function pyFieldType(
  values: unknown[],
  classes: string[],
  nameHint: string,
): {type: string; optional: boolean} {
  const optional = values.some((v) => v === null || v === undefined);
  return {type: pyTypeFromValues(values, classes, nameHint), optional};
}

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

export function generatePydanticModel(operationId: string, op: Op): string {
  const Base = pascalCase(operationId);
  const classes: string[] = [];

  const header: string[] = [];
  header.push(`# Auto-generated Pydantic v2 models for OrigoID operation: ${operationId}`);
  header.push(`# Requires: pip install pydantic>=2`);
  if (op.description) {
    const firstLine = op.description.split("\n")[0].slice(0, 200);
    header.push(`# ${firstLine}`);
  }
  header.push("");
  header.push(`from typing import Any, Dict, List, Literal, Optional, Union`);
  header.push(`from pydantic import BaseModel`);
  header.push("");

  // Request
  const reqSchema = op.requestBody?.content?.["application/json"]?.schema;
  if (reqSchema && reqSchema.type === "object" && reqSchema.properties) {
    pyTypeFromSchema(reqSchema, classes, `${Base}Request`);
  } else {
    classes.push(`class ${Base}Request(BaseModel):\n    # Free-form request body; refer to /sdks/mcp or /en/sdks/${snakeCase(operationId)}\n    pass\n`);
  }

  // Type literal
  const types = collectResponseTypes(op);
  let typeAnnotation = "str";
  if (types.length > 0) {
    const literals = types.map((t) => `"${t}"`).join(", ");
    header.push(`${Base}Type = Literal[${literals}]`);
    typeAnnotation = `${Base}Type`;
    header.push("");
  }

  // Data shape, merged from every example that carries data
  const dataSamples = findDataSamples(op);
  let dataType = "Optional[Any] = None";
  if (
    dataSamples.length > 0 &&
    dataSamples.every((v) => typeof v === "object" && !Array.isArray(v))
  ) {
    pyTypeFromValues(dataSamples, classes, `${Base}Data`);
    dataType = `Optional["${Base}Data"] = None`;
  }

  // ErrorDetail (shared shape)
  classes.push(`class ErrorDetail(BaseModel):\n    field: str\n    code: str\n    message: str\n`);

  // Envelope
  classes.push(
    `class ${Base}Envelope(BaseModel):\n` +
    `    status: Literal["OK", "ERROR"]\n` +
    `    type: ${typeAnnotation}\n` +
    `    message: str\n` +
    `    data: ${dataType}\n` +
    `    transactionId: str\n` +
    `    processedAt: str\n` +
    `    billable: bool\n` +
    `    errors: Optional[List[ErrorDetail]] = None\n`,
  );

  return header.join("\n") + "\n" + classes.join("\n");
}

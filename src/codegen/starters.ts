/**
 * Pre-cooked integration starters. Each starter returns a map of
 * `{ filename: contents }` representing a complete, runnable project the
 * user (or their AI agent) can drop into a directory and start hacking
 * on. No placeholders to fill in beyond ORIGOID_API_KEY.
 *
 * Starters cover the most common KYC starting points: validating a CURP
 * inside a web framework (Express / FastAPI) and validating from a CLI
 * (Go). Add more as customer demand surfaces — keep each starter to a
 * handful of files so the LLM consuming the response stays readable.
 */

export interface StarterFile {
  path: string;
  contents: string;
}

export interface Starter {
  id: string;
  description: string;
  files: StarterFile[];
  setupCommands: string[];
  runCommand: string;
}

export type StarterKey = "express-curp" | "fastapi-curp" | "go-cli-curp";

export const STARTER_KEYS: StarterKey[] = [
  "express-curp",
  "fastapi-curp",
  "go-cli-curp",
];

// ─────────────────────────────────────────────────────────────────────────
// express-curp — Node 20+, TypeScript, Express 5, @origoid/sdk
// ─────────────────────────────────────────────────────────────────────────

const EXPRESS_PACKAGE_JSON = `{
  "name": "origoid-express-curp",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc",
    "start": "node dist/server.js",
    "dev": "tsx watch src/server.ts"
  },
  "dependencies": {
    "@origoid/sdk": "^0.1.0",
    "dotenv": "^16.4.5",
    "express": "^5.1.0"
  },
  "devDependencies": {
    "@types/express": "^5.0.0",
    "@types/node": "^22.0.0",
    "tsx": "^4.20.0",
    "typescript": "^5.5.0"
  }
}
`;

const EXPRESS_TSCONFIG = `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*"]
}
`;

const EXPRESS_ENV_EXAMPLE = `# Copy to .env. .env is gitignored.
ORIGOID_API_KEY=your_api_key_here
PORT=3000
`;

const EXPRESS_GITIGNORE = `node_modules/
dist/
.env
*.log
`;

const EXPRESS_SERVER_TS = `import "dotenv/config";
import express from "express";
import pkg from "@origoid/sdk";

const { OrigoidApiClient } = pkg;

if (!process.env.ORIGOID_API_KEY) {
  throw new Error("ORIGOID_API_KEY env var is required");
}

const origoid = new OrigoidApiClient({
  apiKey: process.env.ORIGOID_API_KEY,
});

const app = express();
app.use(express.json({ limit: "1mb" }));

app.post("/curp/validate", async (req, res) => {
  const curp = String(req.body?.curp ?? "").trim().toUpperCase();
  if (curp.length !== 18) {
    return res.status(400).json({ ok: false, reason: "curp_must_be_18_chars" });
  }

  try {
    const env = await origoid.renapo.validateCurp({ curp });

    if (env.status === "OK" && env.type === "SUCCESS") {
      return res.status(200).json({ ok: true, person: env.data });
    }

    switch (env.type) {
      case "CURP_DECEASED":
      case "CURP_APOCRYPHAL":
      case "CURP_JUDICIAL_SUSPENSION":
        return res.status(409).json({ ok: false, reason: env.type, person: env.data });
      case "CURP_HOMONYMY":
        return res.status(200).json({ ok: true, person: env.data, warning: "homonymy" });
      case "CURP_NOT_FOUND":
        return res.status(404).json({ ok: false, reason: "curp_not_found" });
      case "INVALID_REQUEST":
        return res.status(400).json({ ok: false, errors: env.errors ?? [] });
      case "SERVICE_UNAVAILABLE":
      case "INTERNAL_ERROR":
        return res.status(502).json({ ok: false, reason: "upstream" });
      default:
        return res.status(500).json({ ok: false, reason: "unhandled_type", type: env.type });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return res.status(502).json({ ok: false, reason: "sdk_error", message });
  }
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(\`listening on http://localhost:\${port}\`));
`;

const EXPRESS_README = `# OrigoID Express + CURP validator

Minimal Express 5 + TypeScript starter that validates a CURP via the
official \`@origoid/sdk\`. Handles every documented \`type\` code
(SUCCESS, CURP_DECEASED, CURP_NOT_FOUND, INVALID_REQUEST, etc).

## Run

\`\`\`bash
cp .env.example .env
# edit .env, set ORIGOID_API_KEY
npm install
npm run dev
\`\`\`

## Test

\`\`\`bash
curl -X POST http://localhost:3000/curp/validate \\
  -H "content-type: application/json" \\
  -d '{"curp": "PELJ900101HDFRRN09"}'
\`\`\`

The example CURP is synthetic; replace with a real one to get a real
RENAPO response.

## Docs

- https://docs.origoid.com/en/sdks/node
- https://docs.origoid.com/en/sdks/mcp (AI integration via MCP)
`;

const expressCurp: Starter = {
  id: "express-curp",
  description:
    "Express 5 + TypeScript + @origoid/sdk. POST /curp/validate handler covering every CURP result type with idiomatic HTTP status codes.",
  files: [
    { path: "package.json", contents: EXPRESS_PACKAGE_JSON },
    { path: "tsconfig.json", contents: EXPRESS_TSCONFIG },
    { path: ".env.example", contents: EXPRESS_ENV_EXAMPLE },
    { path: ".gitignore", contents: EXPRESS_GITIGNORE },
    { path: "src/server.ts", contents: EXPRESS_SERVER_TS },
    { path: "README.md", contents: EXPRESS_README },
  ],
  setupCommands: [
    "cp .env.example .env  # edit ORIGOID_API_KEY",
    "npm install",
  ],
  runCommand: "npm run dev",
};

// ─────────────────────────────────────────────────────────────────────────
// fastapi-curp — Python 3.10+, FastAPI, origoid (async)
// ─────────────────────────────────────────────────────────────────────────

const FASTAPI_PYPROJECT = `[project]
name = "origoid-fastapi-curp"
version = "0.1.0"
description = "FastAPI + OrigoID CURP validator starter"
requires-python = ">=3.10"
dependencies = [
  "fastapi>=0.115",
  "origoid>=0.1.0",
  "python-dotenv>=1.0.0",
  "uvicorn[standard]>=0.32",
]
`;

const FASTAPI_ENV_EXAMPLE = `ORIGOID_API_KEY=your_api_key_here
`;

const FASTAPI_GITIGNORE = `__pycache__/
*.pyc
.venv/
.env
*.log
`;

const FASTAPI_MAIN_PY = `"""FastAPI + OrigoID CURP validator.

Uses AsyncOrigoID so the FastAPI event loop is never blocked while waiting
on the upstream API.
"""

import os
from contextlib import asynccontextmanager
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from origoid import AsyncOrigoID

load_dotenv()

api_key = os.environ.get("ORIGOID_API_KEY")
if not api_key:
    raise RuntimeError("ORIGOID_API_KEY env var is required")


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.origoid = AsyncOrigoID(api_key=api_key)
    yield


app = FastAPI(lifespan=lifespan)


class ValidateBody(BaseModel):
    curp: str = Field(min_length=18, max_length=18)


@app.post("/curp/validate")
async def validate_curp(body: ValidateBody):
    env = await app.state.origoid.renapo.validate_curp(curp=body.curp.upper())

    if env.status == "OK" and env.type == "SUCCESS":
        return {"ok": True, "person": env.data}

    match env.type:
        case "CURP_DECEASED" | "CURP_APOCRYPHAL" | "CURP_JUDICIAL_SUSPENSION":
            raise HTTPException(status_code=409, detail={
                "reason": env.type,
                "person": env.data,
            })
        case "CURP_HOMONYMY":
            return {"ok": True, "person": env.data, "warning": "homonymy"}
        case "CURP_NOT_FOUND":
            raise HTTPException(status_code=404, detail="curp_not_found")
        case "INVALID_REQUEST":
            raise HTTPException(status_code=400, detail={
                "errors": [e.dict() for e in (env.errors or [])],
            })
        case "SERVICE_UNAVAILABLE" | "INTERNAL_ERROR":
            raise HTTPException(status_code=502, detail="upstream")
        case _:
            raise HTTPException(status_code=500, detail={
                "reason": "unhandled_type",
                "type": env.type,
            })
`;

const FASTAPI_README = `# OrigoID FastAPI + CURP validator

Minimal FastAPI starter using \`origoid\`'s async client. Handles every
documented CURP result type.

## Run

\`\`\`bash
python3 -m venv .venv && source .venv/bin/activate
pip install -e .
cp .env.example .env  # edit ORIGOID_API_KEY
uvicorn main:app --reload
\`\`\`

## Test

\`\`\`bash
curl -X POST http://localhost:8000/curp/validate \\
  -H "content-type: application/json" \\
  -d '{"curp": "PELJ900101HDFRRN09"}'
\`\`\`

The example CURP is synthetic.

## Docs

- https://docs.origoid.com/en/sdks/python
- https://docs.origoid.com/en/sdks/mcp
`;

const fastapiCurp: Starter = {
  id: "fastapi-curp",
  description:
    "FastAPI + AsyncOrigoID + Pydantic. Async POST /curp/validate covering every CURP result type. Non-blocking under load.",
  files: [
    { path: "pyproject.toml", contents: FASTAPI_PYPROJECT },
    { path: ".env.example", contents: FASTAPI_ENV_EXAMPLE },
    { path: ".gitignore", contents: FASTAPI_GITIGNORE },
    { path: "main.py", contents: FASTAPI_MAIN_PY },
    { path: "README.md", contents: FASTAPI_README },
  ],
  setupCommands: [
    "python3 -m venv .venv && source .venv/bin/activate",
    "pip install -e .",
    "cp .env.example .env  # edit ORIGOID_API_KEY",
  ],
  runCommand: "uvicorn main:app --reload",
};

// ─────────────────────────────────────────────────────────────────────────
// go-cli-curp — Go 1.21+, sdk-go, single-binary CLI
// ─────────────────────────────────────────────────────────────────────────

const GO_MOD = `module example.com/origoid-cli-curp

go 1.21

require github.com/origoid/sdk-go v0.1.0
`;

const GO_MAIN = `// origoid-cli-curp validates a single CURP from the command line.
//
//   ORIGOID_API_KEY=... go run . PELJ900101HDFRRN09
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"

	origoid "github.com/origoid/sdk-go"
	"github.com/origoid/sdk-go/client"
	"github.com/origoid/sdk-go/option"
)

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: origoid-cli-curp <CURP>")
		os.Exit(2)
	}

	apiKey := os.Getenv("ORIGOID_API_KEY")
	if apiKey == "" {
		fmt.Fprintln(os.Stderr, "ORIGOID_API_KEY env var is required")
		os.Exit(2)
	}

	c := client.NewClient(option.WithAPIKey(apiKey))
	env, err := c.Renapo.ValidateCurp(context.Background(), &origoid.ValidateCurpRequest{
		Curp: os.Args[1],
	})
	if err != nil {
		fmt.Fprintln(os.Stderr, "transport error:", err)
		os.Exit(1)
	}

	switch env.Type {
	case "SUCCESS":
		printJSON(env.Data)
	case "CURP_DECEASED", "CURP_APOCRYPHAL", "CURP_JUDICIAL_SUSPENSION":
		fmt.Fprintf(os.Stderr, "blocked: %s\\n", env.Type)
		printJSON(env.Data)
		os.Exit(3)
	case "CURP_NOT_FOUND":
		fmt.Fprintln(os.Stderr, "no match")
		os.Exit(4)
	case "INVALID_REQUEST":
		fmt.Fprintln(os.Stderr, "invalid request:")
		for _, e := range env.Errors {
			fmt.Fprintf(os.Stderr, "  %s: %s\\n", e.Field, e.Message)
		}
		os.Exit(2)
	default:
		fmt.Fprintf(os.Stderr, "unhandled type %q: %s\\n", env.Type, env.Message)
		os.Exit(1)
	}
}

func printJSON(v any) {
	b, _ := json.MarshalIndent(v, "", "  ")
	fmt.Println(string(b))
}
`;

const GO_README = `# origoid-cli-curp

Single-command Go CLI that validates a CURP through the OrigoID API.
Exits non-zero on any non-success result so it composes well with shell
scripts.

## Build

\`\`\`bash
go mod tidy
go build -o origoid-cli-curp
\`\`\`

## Run

\`\`\`bash
ORIGOID_API_KEY=your_api_key ./origoid-cli-curp PELJ900101HDFRRN09
\`\`\`

Exit codes: \`0\` success, \`2\` bad input, \`3\` blocked CURP, \`4\` not
found, \`1\` everything else.

## Docs

- https://docs.origoid.com/en/sdks/go
- https://docs.origoid.com/en/sdks/mcp
`;

const goCliCurp: Starter = {
  id: "go-cli-curp",
  description:
    "Standalone Go CLI that validates one CURP. Idiomatic exit codes per result type — composes with shell scripts.",
  files: [
    { path: "go.mod", contents: GO_MOD },
    { path: "main.go", contents: GO_MAIN },
    { path: "README.md", contents: GO_README },
  ],
  setupCommands: ["go mod tidy"],
  runCommand: "ORIGOID_API_KEY=... go run . PELJ900101HDFRRN09",
};

const STARTERS: Record<StarterKey, Starter> = {
  "express-curp": expressCurp,
  "fastapi-curp": fastapiCurp,
  "go-cli-curp": goCliCurp,
};

export function getStarter(key: StarterKey): Starter | undefined {
  return STARTERS[key];
}

export function listStarters(): Array<{id: StarterKey; description: string}> {
  return STARTER_KEYS.map((id) => ({id, description: STARTERS[id].description}));
}

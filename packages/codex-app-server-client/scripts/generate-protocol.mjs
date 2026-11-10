import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const methodMetadata = JSON.parse(readFileSync(join(root, "protocol-methods.json"), "utf8"));
const expectedVersion = packageJson.dependencies?.["@openai/codex"];
const wireOptionalGeneratedFields = {
  "v2/ApplicationRequirements.ts": ["network"],
  "v2/AccountLoginCompletedNotification.ts": ["onboardingEntrypoint"],
  "v2/AppsConfig.ts": ["links"],
  "v2/AppToolSummary.ts": [
    "title",
    "isEnabled",
    "disabledReason",
    "isReadOnly",
  ],
  "v2/BrowserUseRequirements.ts": ["disableAutoReview", "allowWebmcp"],
  "v2/ConfigRequirements.ts": [
    "application",
    "browserUse",
    "sqliteHome",
    "logDir",
    "modelCatalogJson",
    "checkForUpdateOnStartup",
    "allowLoginShell",
    "feedback",
    "windowsSandboxPrivateDesktop",
  ],
  "v2/ConnectorMetadata.ts": [
    "description",
    "distributionChannel",
    "iconUrl",
    "iconUrlDark",
    "installUrl",
    "pluginDisplayNames",
    "toolSummaries",
  ],
  "v2/ExternalAgentConfigImportItemTypeFailure.ts": ["subErrorType"],
  "v2/ExternalAgentConfigDetectResponse.ts": ["connectors"],
  "v2/ExternalAgentConfigImportHistory.ts": ["providerId"],
  "v2/ExternalAgentConfigImportHistoriesReadResponse.ts": ["connectors"],
  "v2/ExternalAgentConfigImportItemTypeSuccess.ts": ["title"],
  "v2/FeedbackRequirements.ts": ["enabled"],
  "v2/GetAccountRateLimitsResponse.ts": ["accountId", "rateLimitUpsell", "ordinaryUsageAllowed"],
  "v2/HookMetadata.ts": ["additionalContextLimit"],
  "v2/InstalledApp.ts": ["runtimeName"],
  "v2/ManagedHooksRequirements.ts": ["SessionEnd"],
  "v2/McpServerStatus.ts": ["toolsError"],
  "v2/Model.ts": ["modelSpecialty"],
  // Present in 0.154.0, absent from the verified 0.164.0 wire response.
  "v2/ModelProviderCapabilitiesReadResponse.ts": ["namespaceTools"],
  "v2/PluginDetail.ts": ["scheduledTasks"],
  "v2/PluginShareContext.ts": ["canPublishToWorkspace"],
  "v2/PluginShareSaveResponse.ts": ["canPublishToWorkspace"],
  "v2/PluginSummary.ts": [
    "mustShowInstallationInterstitial",
    "installedAt",
    "disabledReason",
    "eligiblePlanTypes",
  ],
  "v2/Project.ts": ["recencyAt"],
  "v2/RateLimitSnapshot.ts": ["spendControlReached", "normalModelSlug"],
  "v2/RawResponseCompletedNotification.ts": ["usage", "usageMetadata"],
  "v2/ResponseUsageMetadata.ts": ["metadata"],
  "v2/SkillInterface.ts": ["iconSmallUrl", "iconLargeUrl"],
  "v2/Thread.ts": [
    "environments",
    "originator",
    "daybreakEnabled",
    "canAcceptDirectInput",
    "section",
    "sectionEnteredAt",
    "model",
    "reasoningEffort",
  ],
  "v2/ThreadItem.ts": ["questions"],
  "v2/ThreadResumeResponse.ts": ["itemsBackwardsCursor", "turnsBackwardsCursor"],
  "v2/ThreadSearchOccurrencesResponse.ts": ["nextCursor"],
  "v2/TokenUsageBreakdown.ts": ["cacheWriteInputTokens"],
  "v2/ToolRequestUserInputParams.ts": ["isBlocking"],
  "v2/TurnError.ts": ["misalignment"],
  "v2/UserVerificationStatusResponse.ts": ["credentialId", "unavailableReason", "unavailableMessage"],
};
const compatibilityOptionalSchemaFields = {
  base: {
    ToolRequestUserInputParams: ["isBlocking"],
  },
  v2: {
    ExternalAgentConfigImportHistoriesReadResponse: ["connectors"],
    ModelProviderCapabilitiesReadResponse: ["namespaceTools"],
  },
};
const compatibilityArrayItemDefinitions = {
  base: {},
  v2: {
    ThreadItemsListResponse: {
      data: ["ThreadItemEntry", "ThreadItem"],
    },
  },
};
const compatibilityGeneratedTypeReplacements = {
  // Its Schema declares int64 despite the upstream TypeScript number override.
  // Let the normal lossless-integer pass below produce number | bigint.
  "v2/UserVerificationRpcError.ts": [["code: number,", "code: bigint,"]],
  "v2/Thread.ts": [
    [
      "ephemeral: boolean,\n/**\n * The independently persisted section selected for this thread, if any.",
      [
        "ephemeral: boolean,",
        "/**",
        " * Whether the thread was pinned by the user in Codex 0.146.x.",
        " *",
        " * @deprecated Codex 0.147.0 replaced pinning with thread sections.",
        " */",
        "isPinned?: boolean,",
        "/**",
        " * The independently persisted section selected for this thread, if any.",
      ].join("\n"),
    ],
  ],
  "v2/ThreadItem.ts": [
    [
      "pluginId: string | null,\n/**\n * Safe plugin-relative path",
      "pluginId?: string | null,\n/**\n * Safe plugin-relative path",
    ],
    [
      "scriptPath: string | null,\n/**\n * The command to be executed.",
      "scriptPath?: string | null,\n/**\n * The command to be executed.",
    ],
  ],
  "v2/ThreadItemsListResponse.ts": [
    [
      'import type { ThreadItemEntry } from "./ThreadItemEntry";',
      [
        'import type { ThreadItem } from "./ThreadItem";',
        'import type { ThreadItemEntry } from "./ThreadItemEntry";',
      ].join("\n"),
    ],
    [
      "data: Array<ThreadItemEntry>",
      "data: Array<ThreadItemEntry> | Array<ThreadItem>",
    ],
  ],
};

if (typeof expectedVersion !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(expectedVersion)) {
  throw new Error("@openai/codex must be an exact dependency version.");
}

const codexPackageJson = require.resolve("@openai/codex/package.json");
const codexEntry = join(dirname(codexPackageJson), "bin", "codex.js");
const codexVersion = execFileSync(process.execPath, [codexEntry, "--version"], {
  cwd: root,
  encoding: "utf8",
}).trim();

if (codexVersion !== `codex-cli ${expectedVersion}`) {
  throw new Error(
    `Protocol generator version mismatch: expected codex-cli ${expectedVersion}, received ${codexVersion}.`,
  );
}
if (methodMetadata.codexCliVersion !== expectedVersion) {
  throw new Error(
    `protocol-methods.json targets ${methodMetadata.codexCliVersion}, expected ${expectedVersion}.`,
  );
}

const temporaryRoot = mkdtempSync(join(tmpdir(), "codex-app-server-protocol-"));
const generatedTypes = join(temporaryRoot, "types");
const generatedSchemas = join(temporaryRoot, "schemas");
const generatedMetadata = join(temporaryRoot, "protocol-metadata.ts");
const generatedMethodMap = join(temporaryRoot, "app-server-methods.ts");
const generatedServerRequestMap = join(temporaryRoot, "server-request-methods.ts");
const generatedProtocolMethodSets = join(temporaryRoot, "protocol-method-sets.ts");
const targetTypes = join(root, "src", "generated", "protocol");
const targetSchemas = join(root, "schemas");
const targetMetadata = join(root, "src", "protocol-metadata.ts");
const targetMethodMap = join(root, "src", "generated", "app-server-methods.ts");
const targetServerRequestMap = join(root, "src", "generated", "server-request-methods.ts");
const targetProtocolMethodSets = join(root, "src", "generated", "protocol-method-sets.ts");
const checkOnly = process.argv.includes("--check");

try {
  runCodex(["app-server", "generate-ts", "--experimental", "--out", generatedTypes]);
  runCodex([
    "app-server",
    "generate-json-schema",
    "--experimental",
    "--out",
    generatedSchemas,
  ]);
  normalizeGeneratedTypeTree(generatedTypes);
  normalizeJsonTree(generatedSchemas);
  generateRuntimeValidationSchemas(generatedSchemas, methodMetadata);
  generateMethodMap(generatedTypes, generatedMethodMap, methodMetadata);
  generateServerRequestMap(generatedTypes, generatedServerRequestMap, methodMetadata);
  generateProtocolMethodSets(generatedTypes, generatedSchemas, generatedProtocolMethodSets);
  writeFileSync(
    generatedMetadata,
    [
      "// Generated by scripts/generate-protocol.mjs. Do not edit by hand.",
      "",
      "export const protocolMetadata = {",
      `  codexCliVersion: ${JSON.stringify(expectedVersion)},`,
      '  transport: "jsonl" as const,',
      "  includesExperimentalApi: true,",
      '} as const;',
      "",
    ].join("\n"),
  );

  if (checkOnly) {
    const differences = [
      ...compareTrees(generatedTypes, targetTypes, "src/generated/protocol"),
      ...compareTrees(generatedSchemas, targetSchemas, "schemas"),
      ...compareTrees(generatedMetadata, targetMetadata, "src/protocol-metadata.ts"),
      ...compareTrees(
        generatedMethodMap,
        targetMethodMap,
        "src/generated/app-server-methods.ts",
      ),
      ...compareTrees(
        generatedServerRequestMap,
        targetServerRequestMap,
        "src/generated/server-request-methods.ts",
      ),
      ...compareTrees(
        generatedProtocolMethodSets,
        targetProtocolMethodSets,
        "src/generated/protocol-method-sets.ts",
      ),
    ];
    if (differences.length > 0) {
      throw new Error(
        `Generated protocol artifacts are stale:\n${differences.map((item) => `- ${item}`).join("\n")}\nRun pnpm protocol:generate.`,
      );
    }
    console.log(`Protocol artifacts match codex-cli ${expectedVersion}.`);
  } else {
    replacePath(generatedTypes, targetTypes);
    replacePath(generatedSchemas, targetSchemas);
    replacePath(generatedMetadata, targetMetadata);
    replacePath(generatedMethodMap, targetMethodMap);
    replacePath(generatedServerRequestMap, targetServerRequestMap);
    replacePath(generatedProtocolMethodSets, targetProtocolMethodSets);
    console.log(`Generated protocol artifacts from codex-cli ${expectedVersion}.`);
  }
} finally {
  rmSync(temporaryRoot, { force: true, recursive: true });
}

function runCodex(args) {
  execFileSync(process.execPath, [codexEntry, ...args], {
    cwd: root,
    stdio: "inherit",
  });
}

function replacePath(source, destination) {
  mkdirSync(dirname(destination), { recursive: true });
  const staging = `${destination}.next`;
  rmSync(staging, { force: true, recursive: true });
  cpSync(source, staging, { recursive: true });
  rmSync(destination, { force: true, recursive: true });
  renameSync(staging, destination);
}

function compareTrees(expected, actual, label) {
  if (!existsSync(actual)) return [`${label} is missing`];

  const expectedFiles = listFiles(expected);
  const actualFiles = listFiles(actual);
  const paths = new Set([...expectedFiles.keys(), ...actualFiles.keys()]);
  const differences = [];

  for (const path of [...paths].sort()) {
    if (!expectedFiles.has(path)) {
      differences.push(`${label}/${path} is unexpected`);
    } else if (!actualFiles.has(path)) {
      differences.push(`${label}/${path} is missing`);
    } else if (!expectedFiles.get(path).equals(actualFiles.get(path))) {
      differences.push(`${label}/${path} differs`);
    }
  }

  return differences;
}

function listFiles(path) {
  if (!existsSync(path)) return new Map();
  if (!readdirSafe(path)) return new Map([["", readFileSync(path)]]);

  const files = new Map();
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = join(directory, entry.name);
      if (entry.isDirectory()) visit(entryPath);
      else if (entry.isFile()) {
        files.set(relative(path, entryPath).replaceAll("\\", "/"), readFileSync(entryPath));
      }
    }
  };
  visit(path);
  return files;
}

function readdirSafe(path) {
  try {
    readdirSync(path);
    return true;
  } catch {
    return false;
  }
}

function normalizeJsonTree(directory) {
  for (const [path, contents] of listFiles(directory)) {
    if (!path.endsWith(".json")) continue;
    const value = JSON.parse(contents.toString("utf8"));
    writeFileSync(join(directory, path), `${JSON.stringify(sortJson(value), null, 2)}\n`);
  }
}

function normalizeGeneratedTypeTree(directory) {
  const v2NamespaceExport = 'export * as v2 from "./v2";';
  if (!readFileSync(join(directory, "index.ts"), "utf8").includes(v2NamespaceExport)) {
    throw new Error("Generated protocol index does not export the v2 namespace.");
  }
  const v2Namespace = generateV2TypeNamespace(directory);
  for (const [path, contents] of listFiles(directory)) {
    if (!path.endsWith(".ts")) continue;
    const source = contents.toString("utf8");
    let normalized = source.replace(v2NamespaceExport, v2Namespace);
    for (const field of wireOptionalGeneratedFields[path] ?? []) {
      const requiredField = `${field}:`;
      if (normalized.split(requiredField).length !== 2) {
        throw new Error(
          `Generated ${path} no longer has the expected required ${field} field.`,
        );
      }
      // The JSONL wire contract permits these fields to be absent in the current Schema, in a
      // supported older app-server version, or both. Do not promise a value that can be absent.
      normalized = normalized.replace(requiredField, `${field}?:`);
    }
    for (const [current, compatible] of compatibilityGeneratedTypeReplacements[path] ?? []) {
      if (normalized.split(current).length !== 2) {
        throw new Error(`Generated ${path} no longer has the expected compatibility shape.`);
      }
      normalized = normalized.replace(current, compatible);
    }
    if (/\bbigint\b/.test(normalized)) {
      normalized = normalized
        .replace(
          "// GENERATED CODE! DO NOT MODIFY BY HAND!",
          [
            "// GENERATED CODE! DO NOT MODIFY BY HAND!",
            "// JSONL normalization: 64-bit integers are numbers when safe and bigints otherwise.",
          ].join("\n"),
        )
        .replace(/\bbigint\b/g, "number | bigint");
    }
    if (normalized !== source) writeFileSync(join(directory, path), normalized);
  }
}

function generateV2TypeNamespace(directory) {
  // Declaration bundlers treat a namespace re-export of type-only modules as runtime values.
  // Materialize aliases so the packed declaration preserves `v2.Thread` type syntax.
  const source = readFileSync(join(directory, "v2", "index.ts"), "utf8");
  const exports = [
    ...source.matchAll(/^export type \{ ([A-Za-z_$][\w$]*) \} from "\.\/([^"]+)";$/gm),
  ].map((match) => ({ name: match[1], path: match[2] }));
  const typeExportCount = source.match(/^export type /gm)?.length ?? 0;
  if (exports.length === 0 || exports.length !== typeExportCount) {
    throw new Error("Generated v2 protocol index contains unsupported type exports.");
  }

  return [
    ...exports.map(
      ({ name, path }) => `type CodexV2${name}Type = import("./v2/${path}").${name};`,
    ),
    "",
    "declare namespace v2 {",
    ...exports.map(({ name }) => `  export type ${name} = CodexV2${name}Type;`),
    "}",
    "",
    "export type { v2 };",
  ].join("\n");
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortJson(value[key])]),
  );
}

function generateMethodMap(generatedTypes, outputPath, metadata) {
  const clientRequestSource = readFileSync(join(generatedTypes, "ClientRequest.ts"), "utf8");
  const generatedMethods = new Set(
    [...clientRequestSource.matchAll(/\{ "method": "([^"]+)"/g)].map((match) => match[1]),
  );
  const metadataMethods = new Set(metadata.methods.map((entry) => entry.method));
  const missing = [...generatedMethods].filter((method) => !metadataMethods.has(method));
  const extra = [...metadataMethods].filter((method) => !generatedMethods.has(method));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `Method metadata does not match generated ClientRequest. Missing: ${missing.join(", ") || "none"}. Extra: ${extra.join(", ") || "none"}.`,
    );
  }

  const uniqueResponses = new Map();
  for (const entry of metadata.methods) {
    const modulePath = entry.response.module;
    if (!existsSync(join(generatedTypes, `${modulePath}.ts`))) {
      throw new Error(`Missing generated response type ${modulePath}.ts for ${entry.method}.`);
    }
    if (!uniqueResponses.has(modulePath)) {
      uniqueResponses.set(modulePath, `Response${uniqueResponses.size}`);
    }
  }

  const lines = [
    "// Generated by scripts/generate-protocol.mjs. Do not edit by hand.",
    "",
    'import type { ClientRequest } from "./protocol/ClientRequest";',
    ...[...uniqueResponses].map(
      ([modulePath, alias]) =>
        `import type { ${metadata.methods.find((entry) => entry.response.module === modulePath).response.name} as ${alias} } from "./protocol/${modulePath}";`,
    ),
    "",
    "export interface AppServerResponseMap {",
    ...metadata.methods.map(
      (entry) => `  ${JSON.stringify(entry.method)}: ${uniqueResponses.get(entry.response.module)};`,
    ),
    "}",
    "",
    "export type AppServerMethod = keyof AppServerResponseMap;",
    "export type AppServerRequest<M extends AppServerMethod> = Extract<ClientRequest, { method: M }> ;",
    'export type AppServerParams<M extends AppServerMethod> = AppServerRequest<M>["params"];',
    "",
    "export const appServerResponseSchemaRefs = {",
    ...metadata.methods.map(
      (entry) =>
        `  ${JSON.stringify(entry.method)}: { bundle: ${JSON.stringify(schemaBundle(entry.response.module))}, definition: ${JSON.stringify(entry.response.name)} },`,
    ),
    "} as const;",
    "",
  ];
  writeFileSync(outputPath, lines.join("\n"));
}

function generateServerRequestMap(generatedTypes, outputPath, metadata) {
  if (metadata.schemaVersion !== 2 || !Array.isArray(metadata.serverRequests)) {
    throw new Error("protocol-methods.json must use schemaVersion 2 with serverRequests.");
  }
  const serverRequestSource = readFileSync(join(generatedTypes, "ServerRequest.ts"), "utf8");
  const generatedMethods = methodsFromGeneratedUnion(serverRequestSource);
  const metadataMethods = new Set(metadata.serverRequests.map((entry) => entry.method));
  assertMethodSetsMatch("server request", generatedMethods, metadataMethods);

  const uniqueResponses = new Map();
  for (const entry of metadata.serverRequests) {
    const modulePath = entry.response.module;
    if (!existsSync(join(generatedTypes, `${modulePath}.ts`))) {
      throw new Error(`Missing generated server response type ${modulePath}.ts for ${entry.method}.`);
    }
    if (!uniqueResponses.has(modulePath)) {
      uniqueResponses.set(modulePath, `Response${uniqueResponses.size}`);
    }
  }

  const lines = [
    "// Generated by scripts/generate-protocol.mjs. Do not edit by hand.",
    "",
    'import type { ServerRequest } from "./protocol/ServerRequest";',
    ...[...uniqueResponses].map(([modulePath, alias]) => {
      const response = metadata.serverRequests.find(
        (entry) => entry.response.module === modulePath,
      ).response;
      return `import type { ${response.name} as ${alias} } from "./protocol/${modulePath}";`;
    }),
    "",
    "export interface ServerRequestResponseMap {",
    ...metadata.serverRequests.map(
      (entry) => `  ${JSON.stringify(entry.method)}: ${uniqueResponses.get(entry.response.module)};`,
    ),
    "}",
    "",
    "export type ServerRequestMethod = keyof ServerRequestResponseMap;",
    "export type ServerRequestFor<M extends ServerRequestMethod> = Extract<",
    "  ServerRequest,",
    "  { method: M }",
    ">;",
    "export type TypedServerRequestHandler<M extends ServerRequestMethod> = (",
    '  params: ServerRequestFor<M>["params"],',
    "  request: ServerRequestFor<M>,",
    ") => ServerRequestResponseMap[M] | Promise<ServerRequestResponseMap[M]>;",
    "",
    "export const serverRequestResponseSchemaRefs = {",
    ...metadata.serverRequests.map(
      (entry) =>
        `  ${JSON.stringify(entry.method)}: { bundle: ${JSON.stringify(schemaBundle(entry.response.module))}, definition: ${JSON.stringify(entry.response.name)} },`,
    ),
    "} as const;",
    "",
  ];
  writeFileSync(outputPath, lines.join("\n"));
}

function generateProtocolMethodSets(generatedTypes, generatedSchemas, outputPath) {
  const clientNotificationSource = readFileSync(
    join(generatedTypes, "ClientNotification.ts"),
    "utf8",
  );
  const serverNotificationSource = readFileSync(
    join(generatedTypes, "ServerNotification.ts"),
    "utf8",
  );
  const clientNotifications = methodsFromGeneratedUnion(clientNotificationSource);
  const serverNotifications = methodsFromGeneratedUnion(serverNotificationSource);
  const serverNotificationParams = methodParamsFromGeneratedUnion(serverNotificationSource);
  const schemaBundles = {
    base: JSON.parse(
      readFileSync(join(generatedSchemas, "codex_app_server_protocol.schemas.json"), "utf8"),
    ),
    v2: JSON.parse(
      readFileSync(
        join(generatedSchemas, "codex_app_server_protocol.v2.schemas.json"),
        "utf8",
      ),
    ),
  };
  const aggregateServerNotifications = notificationMethodsFromSchema(
    schemaBundles.v2.definitions?.ServerNotification,
  );
  const standaloneServerNotifications = [...serverNotificationParams]
    .filter(([method]) => !aggregateServerNotifications.has(method))
    .map(([method, definition]) => ({
      bundle: definitionSchemaBundle(schemaBundles, definition),
      definition,
      method,
    }));
  const lines = [
    "// Generated by scripts/generate-protocol.mjs. Do not edit by hand.",
    "",
    "export const clientNotificationMethods = [",
    ...[...clientNotifications].sort().map((method) => `  ${JSON.stringify(method)},`),
    "] as const;",
    "",
    "export const serverNotificationMethods = [",
    ...[...serverNotifications].sort().map((method) => `  ${JSON.stringify(method)},`),
    "] as const;",
    "",
    "export const standaloneServerNotificationSchemaRefs = {",
    ...standaloneServerNotifications.map(
      ({ bundle, definition, method }) =>
        `  ${JSON.stringify(method)}: { bundle: ${JSON.stringify(bundle)}, definition: ${JSON.stringify(definition)} },`,
    ),
    "} as const;",
    "",
  ];
  writeFileSync(outputPath, lines.join("\n"));
}

function generateRuntimeValidationSchemas(generatedSchemas, metadata) {
  const bundles = {
    base: JSON.parse(
      readFileSync(join(generatedSchemas, "codex_app_server_protocol.schemas.json"), "utf8"),
    ),
    v2: JSON.parse(
      readFileSync(
        join(generatedSchemas, "codex_app_server_protocol.v2.schemas.json"),
        "utf8",
      ),
    ),
  };
  const extras = {};
  const unavailableClientResponses = [];
  const allResponses = [
    ...metadata.methods.map((entry) => ({ ...entry, owner: "client" })),
    ...metadata.serverRequests.map((entry) => ({ ...entry, owner: "server" })),
  ];

  for (const entry of allResponses) {
    const bundle = schemaBundle(entry.response.module);
    if (Object.hasOwn(bundles[bundle].definitions ?? {}, entry.response.name)) continue;
    const standalone = readStandaloneSchema(generatedSchemas, entry.response.name);
    if (standalone) extras[entry.response.name] = standalone;
    else if (entry.owner === "client") unavailableClientResponses.push(entry.method);
    else throw new Error(`No generated response schema is available for ${entry.method}.`);
  }

  const clientNotification = readStandaloneSchema(generatedSchemas, "ClientNotification");
  if (!clientNotification) throw new Error("ClientNotification.json is missing.");
  extras.ClientNotification = clientNotification;

  for (const [bundle, definitions] of Object.entries(compatibilityOptionalSchemaFields)) {
    for (const [definition, fields] of Object.entries(definitions)) {
      const required = bundles[bundle].definitions?.[definition]?.required;
      if (!Array.isArray(required)) {
        throw new Error(`Compatibility definition has no required fields: ${definition}.`);
      }
      for (const field of fields) {
        if (!required.includes(field)) {
          throw new Error(`Compatibility field is no longer required: ${definition}.${field}.`);
        }
      }
    }
  }
  for (const [bundle, definitions] of Object.entries(compatibilityArrayItemDefinitions)) {
    for (const [definition, properties] of Object.entries(definitions)) {
      for (const [property, itemDefinitions] of Object.entries(properties)) {
        const items = bundles[bundle].definitions?.[definition]?.properties?.[property]?.items;
        if (items?.$ref !== `#/definitions/${itemDefinitions[0]}`) {
          throw new Error(
            `Compatibility array no longer references ${itemDefinitions[0]}: ${definition}.${property}.`,
          );
        }
        for (const itemDefinition of itemDefinitions) {
          if (!Object.hasOwn(bundles[bundle].definitions ?? {}, itemDefinition)) {
            throw new Error(`Compatibility item definition is missing: ${itemDefinition}.`);
          }
        }
      }
    }
  }

  const output = sortJson({
    $schema: "http://json-schema.org/draft-07/schema#",
    compatibilityArrayItemDefinitions,
    compatibilityOptionalFields: compatibilityOptionalSchemaFields,
    schemas: extras,
    unavailableClientResponses: [...new Set(unavailableClientResponses)].sort(),
  });
  writeFileSync(
    join(generatedSchemas, "runtime-validation.schemas.json"),
    `${JSON.stringify(output, null, 2)}\n`,
  );
}

function readStandaloneSchema(generatedSchemas, name) {
  for (const candidate of [join(generatedSchemas, `${name}.json`), join(generatedSchemas, "v2", `${name}.json`)]) {
    if (existsSync(candidate)) return JSON.parse(readFileSync(candidate, "utf8"));
  }
  return null;
}

function methodsFromGeneratedUnion(source) {
  return new Set([...source.matchAll(/\{ "method": "([^"]+)"/g)].map((match) => match[1]));
}

function methodParamsFromGeneratedUnion(source) {
  const methods = new Map(
    [...source.matchAll(/\{ "method": "([^"]+)", "params": ([A-Za-z_$][\w$]*) \}/g)].map(
      (match) => [match[1], match[2]],
    ),
  );
  const methodNames = methodsFromGeneratedUnion(source);
  if (methods.size !== methodNames.size) {
    throw new Error("Generated notification union contains an unsupported method shape.");
  }
  return methods;
}

function notificationMethodsFromSchema(schema) {
  const methods = new Set();
  const visit = (value, key = "") => {
    if (!value || typeof value !== "object") return;
    if (key === "method" && Array.isArray(value.enum)) {
      for (const method of value.enum) {
        if (typeof method === "string") methods.add(method);
      }
    }
    for (const [childKey, child] of Object.entries(value)) visit(child, childKey);
  };
  visit(schema);
  return methods;
}

function definitionSchemaBundle(bundles, definition) {
  const matches = Object.entries(bundles)
    .filter(([, bundle]) => Object.hasOwn(bundle.definitions ?? {}, definition))
    .map(([name]) => name);
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one aggregate schema definition for ${definition}; found ${matches.join(", ") || "none"}.`,
    );
  }
  return matches[0];
}

function assertMethodSetsMatch(label, generatedMethods, metadataMethods) {
  const missing = [...generatedMethods].filter((method) => !metadataMethods.has(method));
  const extra = [...metadataMethods].filter((method) => !generatedMethods.has(method));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `${label} metadata does not match generated protocol. Missing: ${missing.join(", ") || "none"}. Extra: ${extra.join(", ") || "none"}.`,
    );
  }
}

function schemaBundle(modulePath) {
  return modulePath.startsWith("v2/") ? "v2" : "base";
}

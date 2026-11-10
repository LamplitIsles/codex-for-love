import { randomUUID } from "node:crypto";
import Ajv, { type AnySchema, type ErrorObject, type ValidateFunction } from "ajv";
import baseProtocolSchema from "../schemas/codex_app_server_protocol.schemas.json" with {
  type: "json",
};
import runtimeValidationSchemas from "../schemas/runtime-validation.schemas.json" with {
  type: "json",
};
import v2ProtocolSchema from "../schemas/codex_app_server_protocol.v2.schemas.json" with {
  type: "json",
};
import {
  AppServerProtocolValidationError,
  type ProtocolValidationDirection,
  type ProtocolValidationIssue,
} from "./errors";
import { appServerResponseSchemaRefs } from "./generated/app-server-methods";
import {
  clientNotificationMethods,
  serverNotificationMethods,
  standaloneServerNotificationSchemaRefs,
} from "./generated/protocol-method-sets";
import { serverRequestResponseSchemaRefs } from "./generated/server-request-methods";
import type { JsonRpcNotification, JsonRpcRequest } from "./types";

const BASE_SCHEMA_ID = "codex://app-server/base";
const V2_SCHEMA_ID = "codex://app-server/v2";
const VALIDATION_REQUEST_ID = "protocol-validation";
const BIGINT_VALIDATION_KEYWORD = "codexBigIntFormat";

const INTEGER_FORMAT_RANGES = {
  int32: [-(1n << 31n), (1n << 31n) - 1n],
  int64: [-(1n << 63n), (1n << 63n) - 1n],
  uint: [0n, (1n << 64n) - 1n],
  uint16: [0n, (1n << 16n) - 1n],
  uint32: [0n, (1n << 32n) - 1n],
  uint64: [0n, (1n << 64n) - 1n],
} as const;

type IntegerFormat = keyof typeof INTEGER_FORMAT_RANGES;

interface BigIntFormatSchema {
  exclusiveMaximum?: number;
  exclusiveMinimum?: number;
  format: IntegerFormat;
  maximum?: number;
  minimum?: number;
}

class ValidationBigInt {
  constructor(readonly value: bigint) {}
}

export type ProtocolValidationMode = "strict" | "off";

export const protocolValidationMetadata = {
  defaultMode: "strict" as const,
  validatedClientNotifications: clientNotificationMethods.length,
  validatedClientRequests: Object.keys(appServerResponseSchemaRefs).length,
  validatedClientResponses:
    Object.keys(appServerResponseSchemaRefs).length -
    runtimeValidationSchemas.unavailableClientResponses.length,
  validatedServerRequests: Object.keys(serverRequestResponseSchemaRefs).length,
  validatedServerNotifications: serverNotificationMethods.length,
  unavailableResponseSchemas: [
    ...runtimeValidationSchemas.unavailableClientResponses,
  ] as readonly string[],
} as const;

type SchemaBundle = "base" | "v2";
type SchemaReference = { bundle: SchemaBundle; definition: string };

let sharedValidator: Promise<ProtocolValidator> | null = null;

export function loadProtocolValidator(): Promise<ProtocolValidator> {
  sharedValidator ??= Promise.resolve().then(() => new ProtocolValidator());
  return sharedValidator;
}

export class ProtocolValidator {
  private readonly ajv: Ajv;
  private readonly appServerMethods = new Set(Object.keys(appServerResponseSchemaRefs));
  private readonly clientNotifications = new Set<string>(clientNotificationMethods);
  private readonly responseValidators = new Map<string, ValidateFunction | null>();
  private readonly serverNotifications = new Set<string>(serverNotificationMethods);
  private readonly standaloneServerNotificationValidators = new Map<
    string,
    ValidateFunction
  >();
  private readonly serverRequests = new Set(Object.keys(serverRequestResponseSchemaRefs));
  private readonly serverResponseValidators = new Map<string, ValidateFunction>();
  private readonly validateClientNotification: ValidateFunction;
  private readonly validateClientRequest: ValidateFunction;
  private readonly validateServerNotification: ValidateFunction;
  private readonly validateServerRequest: ValidateFunction;

  constructor() {
    this.ajv = new Ajv({
      allErrors: true,
      allowUnionTypes: true,
      strict: false,
      validateFormats: true,
    });
    for (const format of Object.keys(INTEGER_FORMAT_RANGES) as IntegerFormat[]) {
      this.ajv.addFormat(format, {
        type: "number",
        validate: (value: number) =>
          Number.isSafeInteger(value) && integerMatchesFormat(BigInt(value), format),
      });
    }
    this.ajv.addFormat("double", {
      type: "number",
      validate: (value: number) => Number.isFinite(value),
    });
    this.ajv.addKeyword({
      errors: false,
      keyword: BIGINT_VALIDATION_KEYWORD,
      schemaType: "object",
      validate: (schema: BigIntFormatSchema, value: unknown) =>
        value instanceof ValidationBigInt && bigintMatchesSchema(value.value, schema),
    });
    this.ajv.addSchema(
      withId(withCompatibilityOverrides(baseProtocolSchema, "base"), BASE_SCHEMA_ID),
      BASE_SCHEMA_ID,
    );
    this.ajv.addSchema(
      withId(withCompatibilityOverrides(v2ProtocolSchema, "v2"), V2_SCHEMA_ID),
      V2_SCHEMA_ID,
    );
    for (const [name, schema] of Object.entries(runtimeValidationSchemas.schemas)) {
      const id = runtimeSchemaId(name);
      this.ajv.addSchema(withId(schema, id), id);
    }

    this.validateClientRequest = this.requireValidator(
      `${V2_SCHEMA_ID}#/definitions/ClientRequest`,
    );
    this.validateClientNotification = this.requireValidator(
      runtimeSchemaId("ClientNotification"),
    );
    this.validateServerNotification = this.requireValidator(
      `${V2_SCHEMA_ID}#/definitions/ServerNotification`,
    );
    this.validateServerRequest = this.requireValidator(
      `${BASE_SCHEMA_ID}#/definitions/ServerRequest`,
    );

    for (const [method, reference] of Object.entries(serverRequestResponseSchemaRefs)) {
      this.serverResponseValidators.set(
        method,
        this.requireDefinitionValidator(reference),
      );
    }
    for (const [method, reference] of Object.entries(
      standaloneServerNotificationSchemaRefs,
    )) {
      this.standaloneServerNotificationValidators.set(
        method,
        this.compileStandaloneServerNotificationValidator(method, reference),
      );
    }
  }

  assertClientRequest(method: string, params: unknown): void {
    if (!this.appServerMethods.has(method)) return;
    this.assertValid(
      this.validateClientRequest,
      {
        id: VALIDATION_REQUEST_ID,
        method,
        ...(params === undefined ? {} : { params }),
      },
      "request",
      method,
    );
  }

  assertClientNotification(method: string, params: unknown): void {
    if (!this.clientNotifications.has(method)) return;
    this.assertValid(
      this.validateClientNotification,
      { method, ...(params === undefined ? {} : { params }) },
      "notification",
      method,
    );
  }

  assertResponse(method: string, result: unknown): void {
    const reference = schemaReference(appServerResponseSchemaRefs, method);
    if (!reference) return;
    let validate = this.responseValidators.get(method);
    if (validate === undefined) {
      validate = this.responseValidator(reference);
      this.responseValidators.set(method, validate);
    }
    if (validate) this.assertValid(validate, result, "response", method);
  }

  assertServerNotification(notification: JsonRpcNotification): void {
    if (!this.serverNotifications.has(notification.method)) return;
    const standalone = this.standaloneServerNotificationValidators.get(
      notification.method,
    );
    if (standalone) {
      this.assertValid(
        standalone,
        notification,
        "notification",
        notification.method,
      );
      return;
    }
    this.assertValid(
      this.validateServerNotification,
      notification,
      "notification",
      notification.method,
    );
  }

  assertServerRequest(request: JsonRpcRequest): void {
    if (!this.serverRequests.has(request.method)) return;
    this.assertValid(
      this.validateServerRequest,
      request,
      "serverRequest",
      request.method,
    );
  }

  assertServerResponse(method: string, result: unknown): void {
    const validate = this.serverResponseValidators.get(method);
    if (validate) this.assertValid(validate, result, "serverResponse", method);
  }

  private assertValid(
    validate: ValidateFunction,
    value: unknown,
    direction: ProtocolValidationDirection,
    method: string,
  ): void {
    let wireValue: unknown;
    try {
      wireValue = validationWireValue(value);
    } catch (error) {
      throw new AppServerProtocolValidationError(
        direction,
        method,
        [
          {
            instancePath: "",
            keyword: "serialization",
            message: error instanceof Error ? error.message : String(error),
            schemaPath: "",
          },
        ],
        error instanceof Error ? { cause: error } : undefined,
      );
    }
    if (validate(wireValue)) return;
    throw new AppServerProtocolValidationError(
      direction,
      method,
      validationIssues(validate.errors),
    );
  }

  private responseValidator(reference: SchemaReference): ValidateFunction | null {
    const combined = this.ajv.getSchema(combinedSchemaRef(reference));
    if (combined) return combined;
    return this.ajv.getSchema(runtimeSchemaId(reference.definition)) ?? null;
  }

  private requireDefinitionValidator(reference: SchemaReference): ValidateFunction {
    const validate = this.responseValidator(reference);
    if (!validate) {
      throw new Error(`Generated protocol schema is missing: ${reference.definition}.`);
    }
    return validate;
  }

  private compileStandaloneServerNotificationValidator(
    method: string,
    reference: SchemaReference,
  ): ValidateFunction {
    return this.ajv.compile(
      withBigIntIntegerValidation({
        properties: {
          emittedAtMs: { format: "int64", type: "integer" },
          method: { const: method },
          params: { $ref: combinedSchemaRef(reference) },
        },
        required: ["method", "params"],
        type: "object",
      }) as AnySchema,
    );
  }

  private requireValidator(reference: string): ValidateFunction {
    const validate = this.ajv.getSchema(reference);
    if (!validate) throw new Error(`Generated protocol schema is missing: ${reference}.`);
    return validate;
  }
}

function schemaReference(
  map: typeof appServerResponseSchemaRefs,
  method: string,
): SchemaReference | null {
  if (!Object.hasOwn(map, method)) return null;
  return map[method as keyof typeof map];
}

function combinedSchemaRef(reference: SchemaReference): string {
  const id = reference.bundle === "v2" ? V2_SCHEMA_ID : BASE_SCHEMA_ID;
  return `${id}#/definitions/${reference.definition}`;
}

function runtimeSchemaId(definition: string): string {
  return `codex://app-server/runtime/${definition}`;
}

function withId(schema: unknown, id: string): AnySchema {
  return {
    ...(withBigIntIntegerValidation(schema) as Record<string, unknown>),
    $id: id,
  } as AnySchema;
}

function withCompatibilityOverrides(
  schema: unknown,
  bundle: "base" | "v2",
): unknown {
  const compatible = structuredClone(schema) as unknown;
  if (!isRecord(compatible) || !isRecord(compatible.definitions)) {
    throw new Error(`Generated ${bundle} protocol schema has no definitions.`);
  }
  for (const [definition, fields] of Object.entries(
    runtimeValidationSchemas.compatibilityOptionalFields[bundle] ?? {},
  )) {
    const schemaDefinition = compatible.definitions[definition];
    if (!isRecord(schemaDefinition) || !Array.isArray(schemaDefinition.required)) {
      throw new Error(`Generated compatibility definition is invalid: ${definition}.`);
    }
    if (!Array.isArray(fields) || !fields.every((field) => typeof field === "string")) {
      throw new Error(`Generated compatibility fields are invalid: ${definition}.`);
    }
    const optional = new Set<string>(fields);
    schemaDefinition.required = schemaDefinition.required.filter(
      (field): field is string => typeof field === "string" && !optional.has(field),
    );
  }
  for (const [definition, properties] of Object.entries(
    runtimeValidationSchemas.compatibilityArrayItemDefinitions[bundle] ?? {},
  )) {
    const schemaDefinition = compatible.definitions[definition];
    if (!isRecord(schemaDefinition) || !isRecord(schemaDefinition.properties)) {
      throw new Error(`Generated compatibility definition is invalid: ${definition}.`);
    }
    for (const [property, itemDefinitions] of Object.entries(properties)) {
      const propertySchema = schemaDefinition.properties[property];
      if (
        !isRecord(propertySchema) ||
        !Array.isArray(itemDefinitions) ||
        !itemDefinitions.every((item) => typeof item === "string")
      ) {
        throw new Error(`Generated compatibility array is invalid: ${definition}.${property}.`);
      }
      schemaDefinition.properties[property] = {
        anyOf: itemDefinitions.map((itemDefinition) => ({
          ...structuredClone(propertySchema),
          items: { $ref: `#/definitions/${itemDefinition}` },
        })),
      };
    }
  }
  return compatible;
}

function validationWireValue(value: unknown): unknown {
  for (;;) {
    const prefix = `__codex_protocol_validation_bigint_${randomUUID()}_`;
    const markers: Array<{ marker: string; value: ValidationBigInt }> = [];
    const serialized = JSON.stringify(value, (_key, item: unknown) => {
      if (typeof item === "number" && !Number.isFinite(item)) {
        throw new TypeError("JSON numbers must be finite.");
      }
      if (typeof item !== "bigint") return item;
      const marker = `${prefix}${markers.length}__`;
      markers.push({ marker, value: new ValidationBigInt(item) });
      return marker;
    });
    if (serialized === undefined) throw new TypeError("JSON value serialized to undefined.");

    const markerValues = new Map(markers.map(({ marker, value: item }) => [marker, item]));
    if (
      markers.some(
        ({ marker }) => countOccurrences(serialized, JSON.stringify(marker)) !== 1,
      )
    ) {
      continue;
    }
    return JSON.parse(serialized, (_key, item: unknown) =>
      typeof item === "string" && markerValues.has(item) ? markerValues.get(item) : item,
    ) as unknown;
  }
}

function withBigIntIntegerValidation(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withBigIntIntegerValidation);
  if (!isRecord(value)) return value;

  const transformed = Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, withBigIntIntegerValidation(item)]),
  );
  const types = Array.isArray(value.type) ? value.type : [value.type];
  if (!types.includes("integer") || !isIntegerFormat(value.format)) return transformed;

  return {
    anyOf: [
      transformed,
      {
        [BIGINT_VALIDATION_KEYWORD]: {
          format: value.format,
          ...(typeof value.minimum === "number" ? { minimum: value.minimum } : {}),
          ...(typeof value.maximum === "number" ? { maximum: value.maximum } : {}),
          ...(typeof value.exclusiveMinimum === "number"
            ? { exclusiveMinimum: value.exclusiveMinimum }
            : {}),
          ...(typeof value.exclusiveMaximum === "number"
            ? { exclusiveMaximum: value.exclusiveMaximum }
            : {}),
        } satisfies BigIntFormatSchema,
      },
    ],
  };
}

function bigintMatchesSchema(value: bigint, schema: BigIntFormatSchema): boolean {
  if (!integerMatchesFormat(value, schema.format)) return false;
  if (schema.minimum !== undefined && value < BigInt(schema.minimum)) return false;
  if (schema.maximum !== undefined && value > BigInt(schema.maximum)) return false;
  if (schema.exclusiveMinimum !== undefined && value <= BigInt(schema.exclusiveMinimum)) {
    return false;
  }
  if (schema.exclusiveMaximum !== undefined && value >= BigInt(schema.exclusiveMaximum)) {
    return false;
  }
  return true;
}

function integerMatchesFormat(value: bigint, format: IntegerFormat): boolean {
  const [minimum, maximum] = INTEGER_FORMAT_RANGES[format];
  return value >= minimum && value <= maximum;
}

function isIntegerFormat(value: unknown): value is IntegerFormat {
  return typeof value === "string" && Object.hasOwn(INTEGER_FORMAT_RANGES, value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function countOccurrences(source: string, search: string): number {
  let count = 0;
  let index = 0;
  while ((index = source.indexOf(search, index)) >= 0) {
    count += 1;
    index += search.length;
  }
  return count;
}

function validationIssues(
  errors: ErrorObject[] | null | undefined,
): ProtocolValidationIssue[] {
  return (errors ?? []).map((error) => ({
    instancePath: error.instancePath,
    keyword: error.keyword,
    ...(error.message === undefined ? {} : { message: error.message }),
    schemaPath: error.schemaPath,
  }));
}

export interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  enum?: unknown[];
  anyOf?: JsonSchema[];
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
    case 'null':
      return value === null;
    default:
      return true;
  }
}

function validateAnyOf(value: unknown, schemas: JsonSchema[], path: string): string | null {
  const failures = schemas
    .map((schema) => validateJsonSchema(value, schema, path))
    .filter((result): result is string => Boolean(result));
  return failures.length === schemas.length ? failures[0] ?? `${path} does not match any allowed schema` : null;
}

export function validateJsonSchema(value: unknown, schema?: JsonSchema, path = '$'): string | null {
  if (!schema) return null;

  if (schema.anyOf?.length) {
    return validateAnyOf(value, schema.anyOf, path);
  }

  if (schema.enum && !schema.enum.some((candidate) => Object.is(candidate, value))) {
    return `${path} must be one of the allowed enum values`;
  }

  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const matched = types.some((type) => matchesType(value, type));
    if (!matched) {
      return `${path} must match type ${types.join(' | ')}`;
    }
  }

  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      return `${path} must be at least ${schema.minLength} characters`;
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      return `${path} must be at most ${schema.maxLength} characters`;
    }
  }

  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      return `${path} must be >= ${schema.minimum}`;
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      return `${path} must be <= ${schema.maximum}`;
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      return `${path} must contain at least ${schema.minItems} items`;
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      return `${path} must contain at most ${schema.maxItems} items`;
    }
    if (schema.items) {
      for (let index = 0; index < value.length; index++) {
        const error = validateJsonSchema(value[index], schema.items, `${path}[${index}]`);
        if (error) return error;
      }
    }
  }

  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const objectValue = value as Record<string, unknown>;
    const requiredKeys = schema.required ?? [];
    for (const key of requiredKeys) {
      if (!(key in objectValue)) {
        return `${path}.${key} is required`;
      }
    }

    const properties = schema.properties ?? {};
    for (const [key, childSchema] of Object.entries(properties)) {
      if (key in objectValue) {
        const error = validateJsonSchema(objectValue[key], childSchema, `${path}.${key}`);
        if (error) return error;
      }
    }

    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(properties));
      const extra = Object.keys(objectValue).find((key) => !allowed.has(key));
      if (extra) {
        return `${path}.${extra} is not allowed`;
      }
    }

    if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
      for (const [key, childValue] of Object.entries(objectValue)) {
        if (key in properties) continue;
        const error = validateJsonSchema(childValue, schema.additionalProperties, `${path}.${key}`);
        if (error) return error;
      }
    }
  }

  return null;
}

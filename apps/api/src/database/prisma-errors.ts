import { Prisma } from '../generated/prisma/client.js';

function fieldsOf(meta: Record<string, unknown> | undefined): string[] {
  if (!meta) return [];
  const { target, driverAdapterError } = meta as {
    target?: unknown;
    driverAdapterError?: { cause?: { constraint?: { fields?: unknown; index?: unknown } } };
  };
  const fields: string[] = [];
  if (Array.isArray(target)) fields.push(...target.map(String));
  else if (typeof target === 'string') fields.push(target);
  const constraint = driverAdapterError?.cause?.constraint;
  if (Array.isArray(constraint?.fields)) fields.push(...constraint.fields.map(String));
  if (typeof constraint?.index === 'string') fields.push(constraint.index);
  return fields;
}

/**
 * True if `error` is a unique-constraint violation involving `column`
 * (database column name, e.g. `ogc_id`). Works with and without driver adapters.
 */
export function isUniqueViolation(error: unknown, column: string): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return false;
  }
  return fieldsOf(error.meta).some((field) => field === column || field.includes(`_${column}_`));
}

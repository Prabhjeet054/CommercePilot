import { z } from "zod";
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from "./catalog.constants";

const emptyToUndefined = (value: unknown) => {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  return value;
};

const nonNegativeMoney = z.preprocess(
  emptyToUndefined,
  z.coerce
    .number({ invalid_type_error: "Price must be a number", required_error: "Price is required" })
    .finite("Price must be a number")
    .nonnegative("Price must be non-negative"),
);

const nonNegativeInt = z.preprocess(
  emptyToUndefined,
  z.coerce
    .number({ invalid_type_error: "Stock must be a number", required_error: "Stock is required" })
    .int("Stock must be an integer")
    .nonnegative("Stock must be non-negative"),
);

const optionalRating = z.preprocess(emptyToUndefined, z.coerce.number().min(0).max(5).optional());

const optionalNonNegInt = z.preprocess(
  emptyToUndefined,
  z.coerce.number().int().nonnegative().optional(),
);

const tagsSchema = z.preprocess((value: unknown) => {
  if (value === undefined || value === null || value === "") {
    return [];
  }
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value === "string") {
    return value.split(",");
  }
  return value;
}, z.array(z.string().trim().min(1).max(40)).max(20));

const attributesSchema = z
  .array(
    z.object({
      attrKey: z.string().trim().min(1).max(80),
      attrValue: z.string().trim().max(255).nullable().optional(),
    }),
  )
  .max(20)
  .optional();

export const productWriteSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(180),
  category: z.string().trim().min(1, "Category is required").max(80),
  description: z.string().trim().max(4000).nullable().optional(),
  price: nonNegativeMoney,
  currency: z.string().trim().length(3).optional(),
  rating: optionalRating,
  reviewCount: optionalNonNegInt,
  stock: nonNegativeInt,
  imageUrl: z.preprocess(
    (value) => (value === "" || value === null ? undefined : value),
    z.string().url("imageUrl must be a valid URL").max(500).optional(),
  ),
  tags: tagsSchema.optional(),
  deliveryDays: optionalNonNegInt,
  attributes: attributesSchema,
});

export const listProductsQuerySchema = z.object({
  category: z.preprocess(emptyToUndefined, z.string().trim().min(1).max(80).optional()),
  maxPrice: z.preprocess(emptyToUndefined, z.string().optional()).superRefine((value, ctx) => {
    if (value === undefined) {
      return;
    }
    const parsed = Number(value);
    if (Number.isNaN(parsed)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "maxPrice must be a number",
      });
      return;
    }
    if (parsed < 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "maxPrice must be non-negative",
      });
    }
  }),
  tags: z.union([z.string(), z.array(z.string())]).optional(),
  page: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(1)),
  pageSize: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().positive().max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  ),
  merchantId: z.preprocess(emptyToUndefined, z.string().uuid("merchantId must be a UUID").optional()),
});

export const uuidParamSchema = z.string().uuid();

export type ProductWriteInput = z.infer<typeof productWriteSchema>;
export type ListProductsQuery = z.infer<typeof listProductsQuerySchema>;

export function normalizeTags(tags: string[] | undefined): string[] {
  if (!tags) {
    return [];
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const tag of tags) {
    const normalized = tag.trim().toLowerCase();
    if (normalized.length === 0 || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

export function parseTagQuery(value: string | string[] | undefined): string[] {
  if (value === undefined) {
    return [];
  }
  const parts = Array.isArray(value) ? value : value.split(",");
  return normalizeTags(parts);
}

export function fieldErrors(error: z.ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "_root";
    if (!fields[key]) {
      fields[key] = issue.message;
    }
  }
  return fields;
}

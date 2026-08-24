import { z } from "zod";

const emptyToUndefined = (value: unknown) => {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  return value;
};

export const productWriteSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(180),
  category: z.string().trim().min(1, "Category is required").max(80),
  description: z.string().trim().max(4000).optional(),
  price: z.preprocess(
    emptyToUndefined,
    z.coerce
      .number({ invalid_type_error: "Price must be a number", required_error: "Price is required" })
      .finite("Price must be a number")
      .nonnegative("Price must be non-negative"),
  ),
  stock: z.preprocess(
    emptyToUndefined,
    z.coerce
      .number({ invalid_type_error: "Stock must be a number", required_error: "Stock is required" })
      .int("Stock must be an integer")
      .nonnegative("Stock must be non-negative"),
  ),
  rating: z.preprocess(emptyToUndefined, z.coerce.number().min(0).max(5).optional()),
  reviewCount: z.preprocess(emptyToUndefined, z.coerce.number().int().nonnegative().optional()),
  deliveryDays: z.preprocess(emptyToUndefined, z.coerce.number().int().nonnegative().optional()),
  tags: z.string().optional(),
  imageUrl: z.preprocess(
    (value) => (value === "" || value === null ? undefined : value),
    z.string().url("imageUrl must be a valid URL").max(500).optional(),
  ),
});

export type ProductWriteInput = z.infer<typeof productWriteSchema>;

export const CATEGORIES = ["Electronics", "Sports", "Travel"] as const;

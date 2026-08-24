import { Prisma } from "@prisma/client";
import type { Request } from "express";
import { prisma } from "../../lib/prisma";
import { normalizeTags, uuidParamSchema, type ProductWriteInput } from "./catalog.schema";

export type ProductDto = {
  id: string;
  merchantId: string;
  name: string;
  category: string;
  description: string | null;
  price: string;
  currency: string;
  rating: string | null;
  reviewCount: number;
  stock: number;
  imageUrl: string | null;
  tags: string[];
  deliveryDays: number | null;
  createdAt: string;
  attributes?: Array<{ id: string; attrKey: string; attrValue: string | null }>;
};

export type MerchantDto = {
  id: string;
  name: string;
  trustScore: string;
  isTrustedDefault: boolean;
  createdAt: string;
};

type ProductRow = Prisma.ProductGetPayload<{ include: { attributes: true } }> | Prisma.ProductGetPayload<object>;

function serializeProduct(product: ProductRow, includeAttributes: boolean): ProductDto {
  const dto: ProductDto = {
    id: product.id,
    merchantId: product.merchantId,
    name: product.name,
    category: product.category,
    description: product.description,
    price: product.price.toFixed(2),
    currency: product.currency,
    rating: product.rating ? product.rating.toFixed(2) : null,
    reviewCount: product.reviewCount,
    stock: product.stock,
    imageUrl: product.imageUrl,
    tags: product.tags,
    deliveryDays: product.deliveryDays,
    createdAt: product.createdAt.toISOString(),
  };
  if (includeAttributes && "attributes" in product && product.attributes) {
    dto.attributes = product.attributes.map((attribute) => ({
      id: attribute.id,
      attrKey: attribute.attrKey,
      attrValue: attribute.attrValue,
    }));
  }
  return dto;
}

export function serializeMerchant(merchant: {
  id: string;
  name: string;
  trustScore: Prisma.Decimal;
  isTrustedDefault: boolean;
  createdAt: Date;
}): MerchantDto {
  return {
    id: merchant.id,
    name: merchant.name,
    trustScore: merchant.trustScore.toFixed(2),
    isTrustedDefault: merchant.isTrustedDefault,
    createdAt: merchant.createdAt.toISOString(),
  };
}

export async function findMerchantIdForUser(userId: string): Promise<string | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { merchantId: true },
  });
  return user?.merchantId ?? null;
}

/**
 * Maps a product to `{ userId }` of the caller only when the product belongs
 * to that admin's merchant. Missing and foreign products both return null so
 * requireOwnership responds 404 (not 403).
 */
export async function loadProductOwnership(req: Request): Promise<{ userId: string } | null> {
  const productId = req.params.id;
  const callerId = req.user?.id;
  if (!productId || !callerId || !uuidParamSchema.safeParse(productId).success) {
    return null;
  }

  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { merchantId: true },
  });
  if (!product) {
    return null;
  }

  const merchantId = await findMerchantIdForUser(callerId);
  if (!merchantId || merchantId !== product.merchantId) {
    return null;
  }

  return { userId: callerId };
}

export async function listProducts(filters: {
  category?: string;
  maxPrice?: string;
  tags: string[];
  page: number;
  pageSize: number;
  merchantId?: string;
}): Promise<{ products: ProductDto[]; total: number }> {
  const where: Prisma.ProductWhereInput = { AND: [] };
  const clauses = where.AND as Prisma.ProductWhereInput[];

  if (filters.category) {
    clauses.push({ category: { equals: filters.category, mode: "insensitive" } });
  }
  if (filters.maxPrice !== undefined) {
    clauses.push({ price: { lte: new Prisma.Decimal(filters.maxPrice) } });
  }
  if (filters.merchantId) {
    clauses.push({ merchantId: filters.merchantId });
  }
  for (const tag of filters.tags) {
    clauses.push({ tags: { has: tag } });
  }
  if (clauses.length === 0) {
    delete where.AND;
  }

  const [total, products] = await prisma.$transaction([
    prisma.product.count({ where }),
    prisma.product.findMany({
      where,
      orderBy: [{ category: "asc" }, { name: "asc" }],
      skip: (filters.page - 1) * filters.pageSize,
      take: filters.pageSize,
    }),
  ]);

  return {
    products: products.map((product) => serializeProduct(product, false)),
    total,
  };
}

export async function getProductById(id: string): Promise<ProductDto | null> {
  const product = await prisma.product.findUnique({
    where: { id },
    include: { attributes: { orderBy: { attrKey: "asc" } } },
  });
  if (!product) {
    return null;
  }
  return serializeProduct(product, true);
}

export async function getMerchantById(id: string): Promise<MerchantDto | null> {
  const merchant = await prisma.merchant.findUnique({ where: { id } });
  if (!merchant) {
    return null;
  }
  return serializeMerchant(merchant);
}

function writeData(input: ProductWriteInput, merchantId: string) {
  const imageUrl = input.imageUrl === "" ? null : (input.imageUrl ?? null);
  return {
    merchantId,
    name: input.name,
    category: input.category,
    description: input.description ?? null,
    price: new Prisma.Decimal(input.price.toFixed(2)),
    currency: input.currency ?? "INR",
    rating: input.rating === undefined ? null : new Prisma.Decimal(input.rating.toFixed(2)),
    reviewCount: input.reviewCount ?? 0,
    stock: input.stock,
    imageUrl,
    tags: normalizeTags(input.tags),
    deliveryDays: input.deliveryDays ?? null,
  };
}

async function replaceAttributes(
  productId: string,
  attributes: ProductWriteInput["attributes"],
): Promise<void> {
  if (attributes === undefined) {
    return;
  }

  const keys = attributes.map((attribute) => attribute.attrKey);
  await prisma.productAttribute.deleteMany({
    where: { productId, attrKey: { notIn: keys } },
  });

  for (const attribute of attributes) {
    await prisma.productAttribute.upsert({
      where: { productId_attrKey: { productId, attrKey: attribute.attrKey } },
      create: {
        productId,
        attrKey: attribute.attrKey,
        attrValue: attribute.attrValue ?? null,
      },
      update: { attrValue: attribute.attrValue ?? null },
    });
  }
}

export async function createProductForMerchant(
  merchantId: string,
  input: ProductWriteInput,
): Promise<ProductDto> {
  const product = await prisma.product.create({
    data: writeData(input, merchantId),
  });
  await replaceAttributes(product.id, input.attributes);
  const created = await getProductById(product.id);
  if (!created) {
    throw new Error("Failed to load created product");
  }
  return created;
}

export async function updateProduct(
  productId: string,
  merchantId: string,
  input: ProductWriteInput,
): Promise<ProductDto | null> {
  const existing = await prisma.product.findUnique({
    where: { id: productId },
    select: { merchantId: true },
  });
  if (!existing || existing.merchantId !== merchantId) {
    return null;
  }

  await prisma.product.update({
    where: { id: productId },
    data: writeData(input, merchantId),
  });
  await replaceAttributes(productId, input.attributes);
  return getProductById(productId);
}
